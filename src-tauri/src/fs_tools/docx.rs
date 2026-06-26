//! .docx generation, plus the lightweight extractor used by `fs_read_docx`.
//! Hand-rolled OOXML packaging via the `zip` crate; markdown-shaped input
//! preprocessing comes from `super::markdown_inline`.

use super::images::LoadedImage;
use super::markdown_inline::ImageAlignment;
use super::path::{resolve_in_workdir, stat_within_limit, workdir_path, MAX_DOC_READ_BYTES};
use std::path::Path;

/// Extract text from a .docx file by reading word/document.xml from the zip
/// and scanning for <w:t>...</w:t> elements. Paragraphs (<w:p>) become line
/// breaks. This is much simpler than walking the full docx AST and handles
/// 95% of real-world documents correctly.
fn extract_docx_text(path: &Path) -> Result<String, String> {
    use std::io::Read;

    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open docx: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Not a valid docx (zip) file: {}", e))?;

    let mut doc_xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|e| format!("docx missing word/document.xml: {}", e))?
        .read_to_string(&mut doc_xml)
        .map_err(|e| format!("Failed to read word/document.xml: {}", e))?;

    Ok(extract_text_from_document_xml(&doc_xml))
}

/// Scan document.xml for text runs and paragraph breaks. This is a forward
/// scan — not a full XML parser, but it handles the flat structure of word
/// text elements reliably.
fn extract_text_from_document_xml(doc_xml: &str) -> String {
    let mut out = String::new();
    let bytes = doc_xml.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // The prefix match alone is not enough: `<w:t` is also the start of
        // `<w:tbl>`, `<w:tc>`, `<w:tr>` — without the name-boundary check,
        // any document with a table dumps raw OOXML into the output.
        if bytes[i..].starts_with(b"<w:t") && tag_name_ends_at(bytes, i + "<w:t".len()) {
            // Find the end of the opening tag
            if let Some(open_end) = bytes[i..].iter().position(|&b| b == b'>') {
                let text_start = i + open_end + 1;
                // Self-closing empty run (`<w:t/>`) has no text and no
                // closing tag — capturing up to the next `</w:t>` would
                // swallow unrelated markup.
                if open_end >= 1 && bytes[i + open_end - 1] == b'/' {
                    i = text_start;
                    continue;
                }
                if let Some(close_rel) = find_subslice(&bytes[text_start..], b"</w:t>") {
                    let text_end = text_start + close_rel;
                    // Decode XML entities in the text range
                    out.push_str(&decode_xml_entities(&doc_xml[text_start..text_end]));
                    i = text_end + "</w:t>".len();
                    continue;
                }
            }
        } else if bytes[i..].starts_with(b"</w:p>") {
            out.push('\n');
            i += "</w:p>".len();
            continue;
        } else if bytes[i..].starts_with(b"<w:br") && tag_name_ends_at(bytes, i + "<w:br".len()) {
            out.push('\n');
            // Skip to end of tag
            if let Some(end) = bytes[i..].iter().position(|&b| b == b'>') {
                i += end + 1;
                continue;
            }
        } else if bytes[i..].starts_with(b"<w:tab/>") {
            out.push('\t');
            i += "<w:tab/>".len();
            continue;
        }
        i += 1;
    }

    out.trim().to_string()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Does the byte at `idx` terminate an XML tag name (`>`, `/`, or
/// whitespace before attributes)?
fn tag_name_ends_at(bytes: &[u8], idx: usize) -> bool {
    matches!(
        bytes.get(idx),
        Some(b'>') | Some(b'/') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')
    )
}

/// Single-pass XML entity decoder: the five named entities plus numeric
/// character references (`&#8217;`, `&#x2019;`). Sequential `.replace()`
/// calls were wrong in two ways — `&amp;` decoded first turned stored
/// `&amp;lt;` into a literal `<`, and numeric references (which Word
/// emits for smart quotes/dashes) weren't decoded at all.
fn decode_xml_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        // Entities are short; a missing or distant `;` means a bare `&`.
        let semi = match rest.find(';') {
            Some(p) if p <= 12 => p,
            _ => {
                out.push('&');
                rest = &rest[1..];
                continue;
            }
        };
        let entity = &rest[1..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => {
                if let Some(hex) = entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                {
                    u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                } else if let Some(dec) = entity.strip_prefix('#') {
                    dec.parse::<u32>().ok().and_then(char::from_u32)
                } else {
                    None
                }
            }
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Read an image file and return it as a base64 data URL, resized if
/// larger than MAX_IMAGE_DIMENSION on the longest side. The returned URL
/// can be passed directly as an image_url content part to the vision model.
/// Build a minimal valid .docx file from a list of paragraphs. Each
/// paragraph string becomes a <w:p> with a single <w:t> run. Basic
/// formatting (bold, italic) is not supported in this first pass —
/// the content parameter is plain text with newline-separated paragraphs.
/// Body XML for a standalone image paragraph. `w:jc` alignment is only
/// emitted when not default-left (Word treats absent `w:jc` as left), which
/// keeps the common case lean.
fn docx_image_paragraph(
    idx: usize,
    target_w: u64,
    target_h: u64,
    drawing_id: u32,
    alignment: ImageAlignment,
) -> String {
    let ppr = match alignment {
        ImageAlignment::Left => String::new(),
        ImageAlignment::Center => r#"<w:pPr><w:jc w:val="center"/></w:pPr>"#.to_string(),
        ImageAlignment::Right => r#"<w:pPr><w:jc w:val="right"/></w:pPr>"#.to_string(),
    };
    format!(
        r#"<w:p>{ppr}<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{w}" cy="{h}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{id}" name="Picture {id}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{id}" name="image{idx}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId{idx}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{w}" cy="{h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"#,
        ppr = ppr,
        w = target_w,
        h = target_h,
        id = drawing_id,
        idx = idx,
    )
}

/// Body XML for a heading paragraph. Font size shrinks two half-points per
/// level (`32 - level*2`).
fn docx_heading_paragraph(level: usize, escaped_text: &str) -> String {
    format!(
        r#"<w:p><w:pPr><w:pStyle w:val="Heading{}"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="{}"/></w:rPr><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
        level,
        32 - level * 2,
        escaped_text
    )
}

/// Body XML for a plain text paragraph.
fn docx_text_paragraph(escaped_text: &str) -> String {
    format!(
        r#"<w:p><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
        escaped_text
    )
}

/// DOCX paragraph emitter for the shared [`super::images::render_doc_body`]
/// driver. DOCX uses the drawing `seq` for the `<wp:docPr>` id and ignores the
/// image extension (the relationship already carries it).
struct DocxBody;

impl super::images::DocBodyEmitter for DocxBody {
    fn image(
        &self,
        idx: usize,
        w_emu: u64,
        h_emu: u64,
        seq: u32,
        _ext: &str,
        alignment: ImageAlignment,
    ) -> String {
        docx_image_paragraph(idx, w_emu, h_emu, seq, alignment)
    }
    fn heading(&self, level: usize, escaped: &str) -> String {
        docx_heading_paragraph(level, escaped)
    }
    fn text(&self, escaped: &str) -> String {
        docx_text_paragraph(escaped)
    }
}

pub(super) fn build_docx(
    paragraphs: &[&str],
    images: &std::collections::HashMap<String, LoadedImage>,
) -> Result<Vec<u8>, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    // Resolve referenced images (first-appearance media numbering + natural
    // EMU sizes) once. Shared with the ODT builder; per-reference alignment
    // and width% are applied later by render_doc_body.
    let (index, natural_emu) = super::images::prepare_doc_images(paragraphs, images)?;

    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // [Content_Types].xml — shared prologue + Default entries for any
        // image extensions used, then the docx body Override.
        let mut content_types = super::ooxml::content_types_prologue(&index.unique_exts);
        content_types.push_str(
            r#"<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#,
        );
        zip.start_file("[Content_Types].xml", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(content_types.as_bytes())
            .map_err(|e| e.to_string())?;

        // _rels/.rels — package-level relationship to the main document.
        zip.start_file("_rels/.rels", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(super::ooxml::root_rels("word/document.xml").as_bytes())
            .map_err(|e| e.to_string())?;

        // word/_rels/document.xml.rels — only emitted when there's at
        // least one image to reference. Word tolerates a missing file
        // when there are no images, and we'd rather not write empty
        // <Relationships> XML.
        if !index.ordered.is_empty() {
            let mut rels = String::from(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
"#,
            );
            for path in &index.ordered {
                let idx = index.by_path[*path];
                let ext = &images[*path].extension;
                rels.push_str(&format!(
                    r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image{}.{}"/>
"#,
                    idx, idx, ext
                ));
            }
            rels.push_str("</Relationships>");
            zip.start_file("word/_rels/document.xml.rels", options)
                .map_err(|e| e.to_string())?;
            zip.write_all(rels.as_bytes()).map_err(|e| e.to_string())?;
        }

        // word/media/imageN.{ext} — one per unique image.
        for path in &index.ordered {
            let idx = index.by_path[*path];
            let img = &images[*path];
            zip.start_file(
                format!("word/media/image{}.{}", idx, img.extension),
                options,
            )
            .map_err(|e| e.to_string())?;
            zip.write_all(&img.bytes).map_err(|e| e.to_string())?;
        }

        // word/document.xml — body XML. The root <w:document> needs every
        // namespace prefix any drawing markup uses, so add wp/a/r/pic now
        // even when there are no images (cheap, simpler than branching).
        let mut body_xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>"#,
        );
        super::images::render_doc_body(
            &mut body_xml,
            paragraphs,
            images,
            &index,
            &natural_emu,
            &DocxBody,
        );
        body_xml.push_str("</w:body></w:document>");

        zip.start_file("word/document.xml", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(body_xml.as_bytes())
            .map_err(|e| e.to_string())?;

        zip.finish().map_err(|e| e.to_string())?;
    }

    Ok(buf)
}

#[tauri::command]
pub async fn fs_write_docx(
    workdir: String,
    rel_path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    super::write_markdown_document(
        workdir, rel_path, content, overwrite, "docx", false, build_docx,
    )
    .await
}

#[tauri::command]
pub async fn fs_read_docx(workdir: String, rel_path: String) -> Result<String, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_file() {
        return Err(format!("Not a file: {}", rel_path));
    }

    stat_within_limit(&resolved, MAX_DOC_READ_BYTES, "docx").await?;

    let resolved_clone = resolved.clone();
    let text = tokio::task::spawn_blocking(move || extract_docx_text(&resolved_clone))
        .await
        .map_err(|e| format!("docx extraction task failed: {}", e))??;

    if text.is_empty() {
        return Err("docx has no extractable text".to_string());
    }

    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs_tools::test_support::read_zip_entry;
    use std::collections::HashMap;

    fn document_xml(paragraphs: &[&str]) -> String {
        let bytes = build_docx(paragraphs, &HashMap::new()).unwrap();
        read_zip_entry(&bytes, "word/document.xml")
    }

    #[test]
    fn extract_text_handles_tables_without_dumping_xml() {
        // `<w:tbl>`/`<w:tc>`/`<w:tr>` share the `<w:t` prefix — the scan
        // must not treat them as text runs.
        let xml = r#"<w:document><w:body>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell one</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>cell two</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            <w:p><w:r><w:t>after table</w:t></w:r></w:p>
        </w:body></w:document>"#;
        let text = extract_text_from_document_xml(xml);
        assert!(text.contains("cell one"));
        assert!(text.contains("cell two"));
        assert!(text.contains("after table"));
        assert!(!text.contains('<'), "raw XML leaked into output: {text}");
    }

    #[test]
    fn extract_text_skips_self_closing_runs() {
        let xml = r#"<w:p><w:r><w:t/></w:r><w:r><w:t>real</w:t></w:r></w:p>"#;
        assert_eq!(extract_text_from_document_xml(xml), "real");
    }

    #[test]
    fn extract_text_keeps_tabs_and_breaks() {
        let xml = r#"<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>"#;
        assert_eq!(extract_text_from_document_xml(xml), "a\tb\nc");
    }

    #[test]
    fn decode_entities_single_pass_and_numeric() {
        // Stored "&lt;" (escaped as &amp;lt;) must decode to the literal
        // text "&lt;", not to "<" — the old sequential replace got this
        // wrong.
        assert_eq!(decode_xml_entities("&amp;lt;"), "&lt;");
        assert_eq!(decode_xml_entities("a &amp; b"), "a & b");
        assert_eq!(decode_xml_entities("&lt;tag&gt;"), "<tag>");
        // Word emits numeric refs for smart quotes / dashes
        assert_eq!(decode_xml_entities("it&#8217;s"), "it’s");
        assert_eq!(decode_xml_entities("&#x2019;"), "’");
        // Bare ampersands and unknown entities pass through
        assert_eq!(decode_xml_entities("AT&T"), "AT&T");
        assert_eq!(decode_xml_entities("&unknown;"), "&unknown;");
    }

    #[test]
    fn docx_renders_headings_at_each_level() {
        let body = document_xml(&["# One", "## Two", "### Three"]);
        assert!(body.contains(r#"<w:pStyle w:val="Heading1"/>"#));
        assert!(body.contains(r#"<w:pStyle w:val="Heading2"/>"#));
        assert!(body.contains(r#"<w:pStyle w:val="Heading3"/>"#));
        assert!(body.contains(r#"<w:t xml:space="preserve">One</w:t>"#));
        assert!(body.contains(r#"<w:t xml:space="preserve">Three</w:t>"#));
    }

    #[test]
    fn docx_renders_plain_paragraph() {
        let body = document_xml(&["Just text."]);
        assert!(
            body.contains(r#"<w:p><w:r><w:t xml:space="preserve">Just text.</w:t></w:r></w:p>"#)
        );
    }

    #[test]
    fn docx_escapes_xml_special_chars() {
        let body = document_xml(&["a < b & c > d"]);
        assert!(body.contains("a &lt; b &amp; c &gt; d"));
    }

    #[test]
    fn docx_package_declares_document_part() {
        let bytes = build_docx(&["hi"], &HashMap::new()).unwrap();
        let content_types = read_zip_entry(&bytes, "[Content_Types].xml");
        assert!(content_types.contains("word/document.xml"));
    }
}
