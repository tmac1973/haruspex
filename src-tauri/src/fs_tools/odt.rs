//! .odt (OpenDocument Text) generation. Same markdown-shaped input
//! contract as .docx but with the ODF first-entry-stored-mimetype
//! convention.

use super::images::{
    build_image_index, fit_image_emu, image_pixel_dimensions, load_markdown_images, px_to_emu,
    ImageIndex, LoadedImage,
};
use super::markdown_inline::{
    escape_xml, parse_heading, parse_standalone_image_line, ImageAlignment,
};
use super::path::{
    refuse_if_exists, resolve_in_workdir, workdir_path, write_bytes_to_workdir, MAX_WRITE_BYTES,
};

/// `mimetype`, is stored uncompressed (`CompressionMethod::Stored`),
/// has no extra field, and contains the exact ODF media-type string for
/// the format. This lets tools identify the document type from the raw
/// zip header without decoding the full archive. LibreOffice won't open
/// a file that violates this — it'll treat it as a generic zip.
pub(super) fn build_odt(
    paragraphs: &[&str],
    images: &std::collections::HashMap<String, LoadedImage>,
) -> Result<Vec<u8>, String> {
    use std::io::Write;

    // Walk paragraphs once to assign stable Pictures/imageN.{ext} indices
    // to each unique image path referenced via standalone `![alt](path)`.
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
    // Per-image natural sizes, in EMU. Width%/auto-fit and aspect-ratio
    // scaling happen in the body loop so per-reference options can apply.
    // ODF svg attributes need cm (1 cm = 360000 EMU).
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
        if !ordered_image_paths.is_empty() {
            manifest.push_str(
                r#"<manifest:file-entry manifest:full-path="Pictures/" manifest:media-type=""/>
"#,
            );
        }
        for path in &ordered_image_paths {
            let idx = image_index[*path];
            let ext = &images[*path].extension;
            manifest.push_str(&format!(
                r#"<manifest:file-entry manifest:full-path="Pictures/image{}.{}" manifest:media-type="image/{}"/>
"#,
                idx, ext, ext
            ));
        }
        manifest.push_str("</manifest:manifest>");
        let _ = unique_exts; // captured into manifest above; var kept for symmetry with DOCX path
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
        for path in &ordered_image_paths {
            let idx = image_index[*path];
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
        for para in paragraphs {
            if let Some((path, opts)) = parse_standalone_image_line(para) {
                if let Some(&idx) = image_index.get(&path) {
                    let (nat_w, nat_h) = natural_emu[&path];
                    let (target_w_emu, target_h_emu) =
                        fit_image_emu(nat_w, nat_h, opts.width_fraction);
                    let cm_w = target_w_emu as f32 / 360000.0;
                    let cm_h = target_h_emu as f32 / 360000.0;
                    let style_attr = match opts.alignment {
                        ImageAlignment::Center => r#" text:style-name="ImageCenter""#,
                        ImageAlignment::Right => r#" text:style-name="ImageRight""#,
                        ImageAlignment::Left => "",
                    };
                    let ext = &images[&path].extension;
                    body_xml.push_str(&format!(
                        r#"<text:p{style_attr}><draw:frame draw:name="image{idx}" text:anchor-type="paragraph" svg:width="{w:.3}cm" svg:height="{h:.3}cm"><draw:image xlink:href="Pictures/image{idx}.{ext}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>"#,
                        style_attr = style_attr,
                        idx = idx,
                        w = cm_w,
                        h = cm_h,
                        ext = ext,
                    ));
                    continue;
                }
                // Loaded-image lookup miss falls through to plain-text rendering
                // of the markdown so the user can see what went wrong.
            }
            let (text, heading_level) = parse_heading(para);
            let escaped = escape_xml(text);
            if let Some(level) = heading_level {
                body_xml.push_str(&format!(
                    r#"<text:h text:style-name="Heading_20_{}" text:outline-level="{}">{}</text:h>"#,
                    level, level, escaped
                ));
            } else {
                body_xml.push_str(&format!("<text:p>{}</text:p>", escaped));
            }
        }
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
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("Content too large ({} bytes)", content.len()));
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    let images = load_markdown_images(&workdir, &content)?;

    // Same markdown-ish line model as fs_write_docx: split on newlines,
    // drop empties, pass through build_odt for the zip+ODF packaging.
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let paragraphs: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        build_odt(&paragraphs, &images)
    })
    .await
    .map_err(|e| format!("odt build task failed: {}", e))??;

    write_bytes_to_workdir(&resolved, &bytes).await
}
