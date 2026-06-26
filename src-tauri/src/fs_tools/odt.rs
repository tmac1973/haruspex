//! .odt (OpenDocument Text) generation. Same markdown-shaped input
//! contract as .docx but with the ODF first-entry-stored-mimetype
//! convention.

use super::images::LoadedImage;
use super::markdown_inline::ImageAlignment;

/// `mimetype`, is stored uncompressed (`CompressionMethod::Stored`),
/// has no extra field, and contains the exact ODF media-type string for
/// the format. This lets tools identify the document type from the raw
/// zip header without decoding the full archive. LibreOffice won't open
/// a file that violates this — it'll treat it as a generic zip.
/// content.xml fragment for a standalone image paragraph. Alignment maps to
/// the automatic paragraph styles declared in the content prologue
/// (`ImageCenter` / `ImageRight`); left needs no style.
fn odt_image_paragraph(
    idx: usize,
    cm_w: f32,
    cm_h: f32,
    ext: &str,
    alignment: ImageAlignment,
) -> String {
    let style_attr = match alignment {
        ImageAlignment::Center => r#" text:style-name="ImageCenter""#,
        ImageAlignment::Right => r#" text:style-name="ImageRight""#,
        ImageAlignment::Left => "",
    };
    format!(
        r#"<text:p{style_attr}><draw:frame draw:name="image{idx}" text:anchor-type="paragraph" svg:width="{w:.3}cm" svg:height="{h:.3}cm"><draw:image xlink:href="Pictures/image{idx}.{ext}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>"#,
        style_attr = style_attr,
        idx = idx,
        w = cm_w,
        h = cm_h,
        ext = ext,
    )
}

/// content.xml fragment for a heading paragraph (`_20_` is the encoded space
/// in the ODF style name).
fn odt_heading_paragraph(level: usize, escaped_text: &str) -> String {
    format!(
        r#"<text:h text:style-name="Heading_20_{}" text:outline-level="{}">{}</text:h>"#,
        level, level, escaped_text
    )
}

/// content.xml fragment for a plain text paragraph.
fn odt_text_paragraph(escaped_text: &str) -> String {
    format!("<text:p>{}</text:p>", escaped_text)
}

/// ODT paragraph emitter for the shared [`super::images::render_doc_body`]
/// driver. ODF svg attributes use cm rather than EMU (1 cm = 360000 EMU) and
/// reference the image extension; ODF has no per-drawing id so `seq` is unused.
struct OdtBody;

impl super::images::DocBodyEmitter for OdtBody {
    fn image(
        &self,
        idx: usize,
        w_emu: u64,
        h_emu: u64,
        _seq: u32,
        ext: &str,
        alignment: ImageAlignment,
    ) -> String {
        let cm_w = w_emu as f32 / 360000.0;
        let cm_h = h_emu as f32 / 360000.0;
        odt_image_paragraph(idx, cm_w, cm_h, ext, alignment)
    }
    fn heading(&self, level: usize, escaped: &str) -> String {
        odt_heading_paragraph(level, escaped)
    }
    fn text(&self, escaped: &str) -> String {
        odt_text_paragraph(escaped)
    }
}

pub(super) fn build_odt(
    paragraphs: &[&str],
    images: &std::collections::HashMap<String, LoadedImage>,
) -> Result<Vec<u8>, String> {
    use std::io::Write;

    // Resolve referenced images (first-appearance Pictures/imageN.{ext}
    // numbering + natural EMU sizes) once. Shared with the DOCX builder;
    // render_doc_body applies per-reference alignment/width% (and EMU→cm).
    let (index, natural_emu) = super::images::prepare_doc_images(paragraphs, images)?;

    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let (stored, deflated) = super::odf::odf_options();

        // 1) `mimetype` — MUST be the first entry, MUST be STORED.
        zip.start_file("mimetype", stored)
            .map_err(|e| e.to_string())?;
        zip.write_all(b"application/vnd.oasis.opendocument.text")
            .map_err(|e| e.to_string())?;

        // 2) META-INF/manifest.xml — lists every file in the package and
        //    its media type. The root `/` entry declares the document type.
        //    Each embedded image needs its own file-entry, and so does the
        //    Pictures/ directory entry that LibreOffice expects when any
        //    Pictures/* file is present.
        let mut manifest = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.text"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
"#,
        );
        if !index.ordered.is_empty() {
            manifest.push_str(
                r#"<manifest:file-entry manifest:full-path="Pictures/" manifest:media-type=""/>
"#,
            );
        }
        for path in &index.ordered {
            let idx = index.by_path[*path];
            let ext = &images[*path].extension;
            manifest.push_str(&format!(
                r#"<manifest:file-entry manifest:full-path="Pictures/image{}.{}" manifest:media-type="image/{}"/>
"#,
                idx, ext, ext
            ));
        }
        manifest.push_str("</manifest:manifest>");
        zip.start_file("META-INF/manifest.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(manifest.as_bytes())
            .map_err(|e| e.to_string())?;

        // 3) meta.xml — minimal doc metadata. Optional but polite.
        zip.start_file("meta.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(super::odf::ODF_META_XML)
            .map_err(|e| e.to_string())?;

        // 4) styles.xml — defines the paragraph styles referenced from
        //    content.xml. LibreOffice uses `Heading_20_1`, etc.
        //    (`_20_` is the encoded space character).
        zip.start_file("styles.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br##"<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">
<office:styles>
<style:default-style style:family="paragraph"><style:text-properties fo:font-size="11pt"/></style:default-style>
<style:style style:name="Heading_20_1" style:family="paragraph" style:display-name="Heading 1" style:default-outline-level="1"><style:text-properties fo:font-size="20pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_2" style:family="paragraph" style:display-name="Heading 2" style:default-outline-level="2"><style:text-properties fo:font-size="16pt" fo:font-weight="bold"/></style:style>
<style:style style:name="Heading_20_3" style:family="paragraph" style:display-name="Heading 3" style:default-outline-level="3"><style:text-properties fo:font-size="13pt" fo:font-weight="bold"/></style:style>
</office:styles>
</office:document-styles>"##,
        )
        .map_err(|e| e.to_string())?;

        // 6) Pictures/imageN.{ext} — embedded image binaries. ODF stores
        //    these in a top-level Pictures/ directory referenced by
        //    relative xlink:href from content.xml.
        for path in &index.ordered {
            let idx = index.by_path[*path];
            let img = &images[*path];
            zip.start_file(format!("Pictures/image{}.{}", idx, img.extension), deflated)
                .map_err(|e| e.to_string())?;
            zip.write_all(&img.bytes).map_err(|e| e.to_string())?;
        }

        // 7) content.xml — the document body. The root element needs the
        //    draw/svg/xlink namespaces since image paragraphs use them.
        //    Declare automatic paragraph styles for image alignment up
        //    front so the body loop can reference them by name.
        let mut body_xml = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2">
<office:automatic-styles>
<style:style style:name="ImageCenter" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>
<style:style style:name="ImageRight" style:family="paragraph"><style:paragraph-properties fo:text-align="end"/></style:style>
</office:automatic-styles>
<office:body><office:text>"#,
        );
        super::images::render_doc_body(
            &mut body_xml,
            paragraphs,
            images,
            &index,
            &natural_emu,
            &OdtBody,
        );
        body_xml.push_str("</office:text></office:body></office:document-content>");

        zip.start_file("content.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(body_xml.as_bytes())
            .map_err(|e| e.to_string())?;

        zip.finish().map_err(|e| e.to_string())?;
    }

    Ok(buf)
}

#[tauri::command]
pub async fn fs_write_odt(
    workdir: String,
    rel_path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    super::write_markdown_document(
        workdir, rel_path, content, overwrite, "odt", false, build_odt,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs_tools::test_support::{assert_odf_mimetype, read_zip_entry};
    use std::collections::HashMap;

    fn content_xml(paragraphs: &[&str]) -> String {
        let bytes = build_odt(paragraphs, &HashMap::new()).unwrap();
        assert_odf_mimetype(&bytes, "application/vnd.oasis.opendocument.text");
        read_zip_entry(&bytes, "content.xml")
    }

    #[test]
    fn odt_renders_headings_at_each_level() {
        let c = content_xml(&["# One", "## Two", "### Three"]);
        assert!(c.contains(
            r#"<text:h text:style-name="Heading_20_1" text:outline-level="1">One</text:h>"#
        ));
        assert!(c.contains(
            r#"<text:h text:style-name="Heading_20_2" text:outline-level="2">Two</text:h>"#
        ));
        assert!(c.contains(
            r#"<text:h text:style-name="Heading_20_3" text:outline-level="3">Three</text:h>"#
        ));
    }

    #[test]
    fn odt_renders_plain_paragraph() {
        let c = content_xml(&["Just text."]);
        assert!(c.contains("<text:p>Just text.</text:p>"));
    }

    #[test]
    fn odt_escapes_xml_special_chars() {
        let c = content_xml(&["a < b & c > d"]);
        assert!(c.contains("a &lt; b &amp; c &gt; d"));
    }
}
