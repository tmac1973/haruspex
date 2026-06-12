//! OpenDocument Presentation (.odp) generation. Same input shape as
//! .pptx — reuses `PptxSlide`/`PptxBullet`/`PptxLayout` from `super::pptx`
//! — but writes ODF zip packaging with the first-entry-stored-mimetype
//! convention LibreOffice Impress expects.

use super::images::{build_image_index, load_image_set, ImageIndex, LoadedImage};
use super::markdown_inline::escape_xml;
use super::path::{
    refuse_if_exists, resolve_in_workdir, workdir_path_for_write, write_bytes_to_workdir,
};
use super::pptx::{PptxLayout, PptxSlide};

/// and a layout choice (content or section). Reuses the ODF zip
/// scaffolding from `build_odt` (STORED mimetype first, manifest, meta,
/// styles, content).
pub(super) fn build_odp(
    slides: &[PptxSlide],
    images: &std::collections::HashMap<String, LoadedImage>,
) -> Result<Vec<u8>, String> {
    use std::io::Write;

    if slides.is_empty() {
        return Err("At least one slide is required".to_string());
    }

    // Assign a stable index to each unique image path — same logic as
    // build_pptx. ODP puts the media files under Pictures/ and references
    // them by relative path in content.xml and manifest.xml.
    let ImageIndex {
        ordered: ordered_image_paths,
        by_path: image_index,
        ..
    } = build_image_index(slides.iter().filter_map(|s| s.image.as_ref()), images);

    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let (stored, deflated) = super::odf::odf_options();

        // 1) mimetype — STORED, first entry
        zip.start_file("mimetype", stored)
            .map_err(|e| e.to_string())?;
        zip.write_all(b"application/vnd.oasis.opendocument.presentation")
            .map_err(|e| e.to_string())?;

        // 2) manifest.xml — enumerates every file in the package
        //    (core parts + one Pictures/ entry per image).
        let mut manifest = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
"#,
        );
        for (i, path) in ordered_image_paths.iter().enumerate() {
            let img = images
                .get(*path)
                .ok_or_else(|| format!("Image not loaded: {}", path))?;
            manifest.push_str(&format!(
                r#"<manifest:file-entry manifest:full-path="Pictures/image{}.{}" manifest:media-type="image/{}"/>
"#,
                i + 1,
                img.extension,
                img.extension
            ));
        }
        manifest.push_str("</manifest:manifest>");
        zip.start_file("META-INF/manifest.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(manifest.as_bytes())
            .map_err(|e| e.to_string())?;

        // 3) meta.xml
        zip.start_file("meta.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(super::odf::ODF_META_XML)
            .map_err(|e| e.to_string())?;

        // 4) styles.xml — widescreen page layout + master page. Body
        //    paragraph styles are defined in content.xml's automatic
        //    style section so they can be tweaked per-deck if needed.
        zip.start_file("styles.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(
            br##"<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.2">
<office:styles>
<style:default-style style:family="paragraph"><style:text-properties fo:font-size="18pt"/></style:default-style>
</office:styles>
<office:automatic-styles>
<style:page-layout style:name="PageLayout1">
<style:page-layout-properties fo:page-width="25.4cm" fo:page-height="14.288cm" fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" style:print-orientation="landscape"/>
</style:page-layout>
</office:automatic-styles>
<office:master-styles>
<style:master-page style:name="Default" style:page-layout-name="PageLayout1"/>
</office:master-styles>
</office:document-styles>"##,
        )
        .map_err(|e| e.to_string())?;

        // 5) content.xml — one <draw:page> per slide.
        //    Automatic styles declare:
        //      - TitleText (28pt bold) for content-slide titles
        //      - SectionTitle (40pt bold, centered) for section slides
        //      - BulletText0/1/2 — nested bullets with increasing
        //        fo:margin-left and decreasing font size
        let mut body = String::from(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2">
<office:automatic-styles>
<style:style style:name="TitleText" style:family="paragraph"><style:text-properties fo:font-size="28pt" fo:font-weight="bold"/></style:style>
<style:style style:name="SectionTitle" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="40pt" fo:font-weight="bold"/></style:style>
<style:style style:name="SectionSubtitle" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="22pt"/></style:style>
<style:style style:name="BulletText0" style:family="paragraph"><style:paragraph-properties fo:margin-left="0cm"/><style:text-properties fo:font-size="18pt"/></style:style>
<style:style style:name="BulletText1" style:family="paragraph"><style:paragraph-properties fo:margin-left="1cm"/><style:text-properties fo:font-size="16pt"/></style:style>
<style:style style:name="BulletText2" style:family="paragraph"><style:paragraph-properties fo:margin-left="2cm"/><style:text-properties fo:font-size="14pt"/></style:style>
</office:automatic-styles>
<office:body><office:presentation>
"#,
        );
        for (i, slide) in slides.iter().enumerate() {
            body.push_str(&format!(
                r#"<draw:page draw:name="Slide{}" draw:master-page-name="Default">
"#,
                i + 1
            ));

            match slide.layout {
                PptxLayout::Section => {
                    // Centered title frame in the vertical middle of the
                    // slide. 25.4cm wide slide → title frame 23cm wide at
                    // x=1.2cm is effectively centered.
                    body.push_str(&format!(
                        r#"<draw:frame svg:x="1.2cm" svg:y="5cm" svg:width="23cm" svg:height="2.5cm"><draw:text-box><text:p text:style-name="SectionTitle">{}</text:p></draw:text-box></draw:frame>
"#,
                        escape_xml(slide.title.trim())
                    ));
                    if let Some(subtitle) = slide
                        .subtitle
                        .as_ref()
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                    {
                        body.push_str(&format!(
                            r#"<draw:frame svg:x="1.2cm" svg:y="8cm" svg:width="23cm" svg:height="1.5cm"><draw:text-box><text:p text:style-name="SectionSubtitle">{}</text:p></draw:text-box></draw:frame>
"#,
                            escape_xml(subtitle)
                        ));
                    }
                }
                PptxLayout::Content => {
                    // Title frame — full width at the top.
                    body.push_str(&format!(
                        r#"<draw:frame svg:x="1cm" svg:y="0.8cm" svg:width="23cm" svg:height="2cm"><draw:text-box><text:p text:style-name="TitleText">{}</text:p></draw:text-box></draw:frame>
"#,
                        escape_xml(slide.title.trim())
                    ));

                    // Bullet frame width shrinks to the left half when
                    // an image is attached. Full width: 23cm. Split
                    // width: 11cm left, 11cm right with 1cm gap.
                    let has_image = slide.image.is_some();
                    let bullet_width = if has_image { "11cm" } else { "23cm" };
                    body.push_str(&format!(
                        r#"<draw:frame svg:x="1cm" svg:y="3.2cm" svg:width="{}" svg:height="10cm"><draw:text-box>
"#,
                        bullet_width
                    ));
                    if slide.bullets.is_empty() {
                        body.push_str("<text:p/>");
                    } else {
                        for bullet in &slide.bullets {
                            let level = bullet.level.min(2);
                            body.push_str(&format!(
                                r#"<text:p text:style-name="BulletText{}">- {}</text:p>
"#,
                                level,
                                escape_xml(bullet.text.trim())
                            ));
                        }
                    }
                    body.push_str("</draw:text-box></draw:frame>\n");

                    // Image frame on the right half.
                    if let Some(image_path) = &slide.image {
                        let idx = image_index
                            .get(image_path)
                            .copied()
                            .ok_or_else(|| format!("Image index missing for {}", image_path))?;
                        let ext = images
                            .get(image_path)
                            .map(|i| i.extension.as_str())
                            .ok_or_else(|| format!("Image not loaded: {}", image_path))?;
                        body.push_str(&format!(
                            r#"<draw:frame svg:x="13cm" svg:y="3.2cm" svg:width="11cm" svg:height="9cm"><draw:image xlink:href="Pictures/image{}.{}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>
"#,
                            idx, ext
                        ));
                    }
                }
            }

            body.push_str("</draw:page>\n");
        }
        body.push_str("</office:presentation></office:body></office:document-content>");

        zip.start_file("content.xml", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(body.as_bytes()).map_err(|e| e.to_string())?;

        // 6) Pictures/image{N}.{ext} — embed the binary image files.
        for (i, path) in ordered_image_paths.iter().enumerate() {
            let img = images
                .get(*path)
                .ok_or_else(|| format!("Image not loaded: {}", path))?;
            zip.start_file(
                format!("Pictures/image{}.{}", i + 1, img.extension),
                deflated,
            )
            .map_err(|e| e.to_string())?;
            zip.write_all(&img.bytes).map_err(|e| e.to_string())?;
        }

        zip.finish().map_err(|e| e.to_string())?;
    }

    Ok(buf)
}

#[tauri::command]
pub async fn fs_write_odp(
    workdir: String,
    rel_path: String,
    slides: Vec<PptxSlide>,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path_for_write(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if slides.is_empty() {
        return Err("At least one slide is required".to_string());
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    // ODP reuses the same PptxSlide struct since the data shape (title
    // + bullet list + optional image) is format-agnostic. Hand-rolled
    // ODF packaging in build_odp.
    let images = load_image_set(&workdir, slides.iter().filter_map(|s| s.image.clone()))?;

    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        build_odp(&slides, &images)
    })
    .await
    .map_err(|e| format!("odp build task failed: {}", e))??;

    write_bytes_to_workdir(&resolved, &bytes).await
}
