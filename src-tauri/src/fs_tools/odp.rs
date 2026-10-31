//! OpenDocument Presentation (.odp) generation, from the slide shape in
//! `super::slides` (the .pptx deck is built in the frontend from the same
//! one). Writes ODF zip packaging with the first-entry-stored-mimetype
//! convention LibreOffice Impress expects.

use super::images::{build_image_index, load_image_set, ImageIndex, LoadedImage};
use super::markdown_inline::escape_xml;
use super::path::{
    refuse_if_exists, resolve_in_workdir, workdir_path_for_write, write_bytes_to_workdir,
};
use super::slides::{Slide, SlideLayout, SlideOrientation};

/// A length in centimetres as ODF writes it, to the nearest 0.01 mm.
fn cm(v: f64) -> String {
    format!("{}cm", (v * 1000.0).round() / 1000.0)
}

/// Where each frame goes on a page of one orientation, in centimetres.
/// Landscape is 25.4 × 14.288 (16:9); portrait turns it on its side, and
/// stacks a slide's image under its title instead of beside its bullets.
struct Page {
    w: f64,
    h: f64,
    orientation: SlideOrientation,
}

/// A frame's position and size, in centimetres.
struct Frame {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Frame {
    fn attrs(&self) -> String {
        format!(
            r#"svg:x="{}" svg:y="{}" svg:width="{}" svg:height="{}""#,
            cm(self.x),
            cm(self.y),
            cm(self.w),
            cm(self.h)
        )
    }
}

impl Page {
    fn new(orientation: SlideOrientation) -> Self {
        let (w, h) = match orientation {
            SlideOrientation::Landscape => (25.4, 14.288),
            SlideOrientation::Portrait => (14.288, 25.4),
        };
        Page { w, h, orientation }
    }

    fn portrait(&self) -> bool {
        self.orientation == SlideOrientation::Portrait
    }

    /// A section slide's title, centred, and its subtitle under it.
    fn section(&self) -> (Frame, Frame) {
        let y = self.h / 2.0 - 2.144;
        let title = Frame {
            x: 1.2,
            y,
            w: self.w - 2.4,
            h: 2.5,
        };
        let subtitle = Frame {
            y: y + 3.0,
            h: 1.5,
            ..title
        };
        (title, subtitle)
    }

    /// A content slide's title, full width at the top. Portrait gives it
    /// room for a second line, since the page is narrow.
    fn title(&self) -> Frame {
        Frame {
            x: 1.0,
            y: 0.8,
            w: self.w - 2.4,
            h: if self.portrait() { 3.0 } else { 2.0 },
        }
    }

    /// The bullets' frame, and the image's when the slide has one.
    fn body(&self, has_image: bool) -> (Frame, Option<Frame>) {
        let top = if self.portrait() { 4.2 } else { 3.2 };
        let full = Frame {
            x: 1.0,
            y: top,
            w: self.w - 2.4,
            h: self.h - top - 1.088,
        };
        if !has_image {
            return (full, None);
        }
        if self.portrait() {
            let image_h = full.h * 0.45;
            let image = Frame { h: image_h, ..full };
            let bullets = Frame {
                y: top + image_h + 0.5,
                h: full.h - image_h - 0.5,
                ..full
            };
            return (bullets, Some(image));
        }
        let bullets = Frame { w: 11.0, ..full };
        let image = Frame {
            x: 13.0,
            y: top,
            w: 11.0,
            h: 9.0,
        };
        (bullets, Some(image))
    }
}

/// Build an .odp deck: one page per slide, each a title with bullets and an
/// optional image, or a section divider. Reuses the ODF zip
/// scaffolding from `build_odt` (STORED mimetype first, manifest, meta,
/// styles, content).
pub(super) fn build_odp(
    slides: &[Slide],
    images: &std::collections::HashMap<String, LoadedImage>,
    orientation: SlideOrientation,
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

    let page = Page::new(orientation);
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
        let mut manifest =
            super::odf::manifest_prologue("application/vnd.oasis.opendocument.presentation");
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

        // 4) styles.xml — the page layout + master page. Body
        //    paragraph styles are defined in content.xml's automatic
        //    style section so they can be tweaked per-deck if needed.
        zip.start_file("styles.xml", deflated)
            .map_err(|e| e.to_string())?;
        let styles = format!(
            r##"<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.2">
<office:styles>
<style:default-style style:family="paragraph"><style:text-properties fo:font-size="18pt"/></style:default-style>
</office:styles>
<office:automatic-styles>
<style:page-layout style:name="PageLayout1">
<style:page-layout-properties fo:page-width="{}" fo:page-height="{}" fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" style:print-orientation="{}"/>
</style:page-layout>
</office:automatic-styles>
<office:master-styles>
<style:master-page style:name="Default" style:page-layout-name="PageLayout1"/>
</office:master-styles>
</office:document-styles>"##,
            cm(page.w),
            cm(page.h),
            if page.portrait() {
                "portrait"
            } else {
                "landscape"
            }
        );
        zip.write_all(styles.as_bytes())
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
                SlideLayout::Section => {
                    // Centered title frame in the vertical middle of the
                    // slide, the subtitle under it.
                    let (title, sub) = page.section();
                    body.push_str(&format!(
                        r#"<draw:frame {}><draw:text-box><text:p text:style-name="SectionTitle">{}</text:p></draw:text-box></draw:frame>
"#,
                        title.attrs(),
                        escape_xml(slide.title.trim())
                    ));
                    if let Some(subtitle) = slide
                        .subtitle
                        .as_ref()
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                    {
                        body.push_str(&format!(
                            r#"<draw:frame {}><draw:text-box><text:p text:style-name="SectionSubtitle">{}</text:p></draw:text-box></draw:frame>
"#,
                            sub.attrs(),
                            escape_xml(subtitle)
                        ));
                    }
                }
                SlideLayout::Content => {
                    // Title frame — full width at the top.
                    body.push_str(&format!(
                        r#"<draw:frame {}><draw:text-box><text:p text:style-name="TitleText">{}</text:p></draw:text-box></draw:frame>
"#,
                        page.title().attrs(),
                        escape_xml(slide.title.trim())
                    ));

                    // An image takes the right half of the body in
                    // landscape, and the top of it in portrait.
                    let (bullets, image_frame) = page.body(slide.image.is_some());
                    body.push_str(&format!(
                        r#"<draw:frame {}><draw:text-box>
"#,
                        bullets.attrs()
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

                    if let (Some(image_path), Some(frame)) = (&slide.image, image_frame) {
                        let idx = image_index
                            .get(image_path)
                            .copied()
                            .ok_or_else(|| format!("Image index missing for {}", image_path))?;
                        let ext = images
                            .get(image_path)
                            .map(|i| i.extension.as_str())
                            .ok_or_else(|| format!("Image not loaded: {}", image_path))?;
                        body.push_str(&format!(
                            r#"<draw:frame {}><draw:image xlink:href="Pictures/image{}.{}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>
"#,
                            frame.attrs(),
                            idx,
                            ext
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
    slides: Vec<Slide>,
    orientation: Option<SlideOrientation>,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let workdir = workdir_path_for_write(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if slides.is_empty() {
        return Err("At least one slide is required".to_string());
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    let images = load_image_set(&workdir, slides.iter().filter_map(|s| s.image.clone()))?;

    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        build_odp(&slides, &images, orientation.unwrap_or_default())
    })
    .await
    .map_err(|e| format!("odp build task failed: {}", e))??;

    write_bytes_to_workdir(&resolved, &bytes).await
}
