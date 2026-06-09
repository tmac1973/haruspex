//! .docx generation, plus the lightweight extractor used by `fs_read_docx`.
//! Hand-rolled OOXML packaging via the `zip` crate; markdown-shaped input
//! preprocessing comes from `super::markdown_inline`.

use super::images::{
    build_image_index, fit_image_emu, image_pixel_dimensions, load_markdown_images, px_to_emu,
    ImageIndex, LoadedImage,
};
use super::markdown_inline::{
    escape_xml, parse_heading, parse_standalone_image_line, ImageAlignment,
};
use super::path::{
    refuse_if_exists, resolve_in_workdir, stat_within_limit, workdir_path, write_bytes_to_workdir,
    MAX_DOC_READ_BYTES, MAX_WRITE_BYTES,
};
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

    // Scan for text runs and paragraph breaks. This is a forward scan — not
    // a full XML parser, but it handles the flat structure of word text
    // elements reliably.
    let mut out = String::new();
    let bytes = doc_xml.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"<w:t") {
            // Find the end of the opening tag
            if let Some(open_end) = bytes[i..].iter().position(|&b| b == b'>') {
                let text_start = i + open_end + 1;
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
        } else if bytes[i..].starts_with(b"<w:br") {
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

    Ok(out.trim().to_string())
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn decode_xml_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

/// Read an image file and return it as a base64 data URL, resized if
/// larger than MAX_IMAGE_DIMENSION on the longest side. The returned URL
/// can be passed directly as an image_url content part to the vision model.
/// Build a minimal valid .docx file from a list of paragraphs. Each
/// paragraph string becomes a <w:p> with a single <w:t> run. Basic
/// formatting (bold, italic) is not supported in this first pass —
/// the content parameter is plain text with newline-separated paragraphs.
pub(super) fn build_docx(
    paragraphs: &[&str],
    images: &std::collections::HashMap<String, LoadedImage>,
) -> Result<Vec<u8>, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    // Walk paragraphs once to assign stable media indices to each unique
    // image path. Duplicate paths share a single word/media/imageN.{ext}.
    let ImageIndex {
        ordered: ordered_image_paths,
        by_path: image_index,
        unique_exts,
    } = build_image_index(
        paragraphs.iter().filter_map(|p| {
            parse_standalone_image_line(p).and_then(|(path, _)| images.keys().find(|k| **k == path))
        }),
        images,
    );
    // Decode pixel dimensions for each image once. Each image's natural EMU
    // size lives here; the per-paragraph rendering loop applies per-image
    // ImageOptions (alignment, width%) on top of these natural dimensions.
    let mut natural_emu: std::collections::HashMap<&String, (u64, u64)> =
        std::collections::HashMap::new();
    for path in &ordered_image_paths {
        let img = images
            .get(*path)
            .ok_or_else(|| format!("Image {} missing from loaded map", path))?;
        let (px_w, px_h) = image_pixel_dimensions(&img.bytes)?;
        natural_emu.insert(*path, (px_to_emu(px_w), px_to_emu(px_h)));
    }

    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // [Content_Types].xml — shared prologue + Default entries for any
        // image extensions used, then the docx body Override.
        let mut content_types = super::ooxml::content_types_prologue(&unique_exts);
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
        if !ordered_image_paths.is_empty() {
            let mut rels = String::from(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
"#,
            );
            for path in &ordered_image_paths {
                let idx = image_index[*path];
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
        for path in &ordered_image_paths {
            let idx = image_index[*path];
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
        let mut drawing_id: u32 = 0;
        for para in paragraphs {
            if let Some((path, opts)) = parse_standalone_image_line(para) {
                if let Some(&idx) = image_index.get(&path) {
                    let (nat_w, nat_h) = natural_emu[&path];
                    // Apply width% if specified, else auto-fit to content
                    // width (capping at MAX_DOC_IMAGE_WIDTH_EMU). Aspect
                    // ratio is always preserved.
                    let (target_w, target_h) = fit_image_emu(nat_w, nat_h, opts.width_fraction);
                    let jc = match opts.alignment {
                        ImageAlignment::Center => "center",
                        ImageAlignment::Right => "right",
                        ImageAlignment::Left => "left",
                    };
                    drawing_id += 1;
                    // Wrap the drawing in a paragraph with w:jc alignment
                    // when not default-left. Word treats absent w:jc as
                    // left-aligned, so we can skip the w:pPr block in that
                    // case to keep the XML lean.
                    let ppr = if opts.alignment == ImageAlignment::Left {
                        String::new()
                    } else {
                        format!(r#"<w:pPr><w:jc w:val="{}"/></w:pPr>"#, jc)
                    };
                    body_xml.push_str(&format!(
                        r#"<w:p>{ppr}<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{w}" cy="{h}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{id}" name="Picture {id}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{id}" name="image{idx}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId{idx}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{w}" cy="{h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"#,
                        ppr = ppr,
                        w = target_w,
                        h = target_h,
                        id = drawing_id,
                        idx = idx,
                    ));
                    continue;
                }
                // Image referenced but not loaded — render the markdown
                // verbatim as a paragraph so the user can see what went
                // wrong instead of silently dropping content.
            }
            // Treat as a heading if the line starts with # (simple markdown-ish)
            let (text, heading_level) = parse_heading(para);
            let escaped = escape_xml(text);
            if let Some(level) = heading_level {
                body_xml.push_str(&format!(
                    r#"<w:p><w:pPr><w:pStyle w:val="Heading{}"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="{}"/></w:rPr><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
                    level,
                    32 - level * 2,
                    escaped
                ));
            } else {
                body_xml.push_str(&format!(
                    r#"<w:p><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
                    escaped
                ));
            }
        }
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
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("Content too large ({} bytes)", content.len()));
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    let images = load_markdown_images(&workdir, &content)?;

    // Split content into paragraphs on newlines, drop empty lines
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let paragraphs: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        build_docx(&paragraphs, &images)
    })
    .await
    .map_err(|e| format!("docx build task failed: {}", e))??;

    write_bytes_to_workdir(&resolved, &bytes).await
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
