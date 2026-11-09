//! The lightweight .docx text extractor behind `fs_read_docx`. Word files
//! are built in the frontend (`src/lib/documents/docx.ts`) and written by
//! `document_write.rs`.

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

#[tauri::command]
pub async fn fs_read_docx(workdir: String, rel_path: String) -> Result<String, String> {
    let text = super::read_document_blocking(workdir, rel_path, "docx", extract_docx_text).await?;

    if text.is_empty() {
        return Err("docx has no extractable text".to_string());
    }

    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
