pub mod absolute;
pub mod bytes;
pub mod created;
pub mod docx;
pub mod download;
pub mod editor;
pub mod fuzzy;
pub mod images;
pub mod markdown_inline;
pub mod odf;
pub mod odp;
pub mod odt;
pub mod ooxml;
pub mod path;
pub mod pdf_read;
pub mod pdf_write;
pub mod pptx;
pub mod preview;
pub mod slides;
pub mod text;
pub mod xlsx;

#[cfg(test)]
mod test_support;

pub(crate) use path::ensure_parent_dir;
pub use path::resolve_in_workdir;
pub(crate) use path::workdir_path;
pub use pdf_read::init_pdfium;

use images::{load_markdown_images, LoadedImage};
use path::{
    refuse_if_exists, stat_within_limit, workdir_path_for_write, write_bytes_to_workdir,
    MAX_DOC_READ_BYTES, MAX_WRITE_BYTES,
};
use std::collections::HashMap;
use std::path::Path;

/// Shared command body for the markdown-text document writers (docx / odt;
/// the PDF is built in the frontend). Resolves and guards the destination (write-size cap + overwrite
/// refusal), pre-loads referenced `![](…)` images while the async runtime is
/// available, then runs `build` on a blocking thread over the content's
/// non-blank lines and writes the bytes.
/// `format` names the build task in error messages.
///
/// The slide/sheet writers (pptx / odp / xlsx) don't share this: they take
/// structured input rather than markdown text, use a different image loader,
/// and carry their own "at least one slide/sheet" guards.
pub(super) async fn write_markdown_document(
    workdir: String,
    rel_path: String,
    content: String,
    overwrite: Option<bool>,
    format: &str,
    build: impl FnOnce(&[&str], &HashMap<String, LoadedImage>) -> Result<Vec<u8>, String>
        + Send
        + 'static,
) -> Result<(), String> {
    let workdir = workdir_path_for_write(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("Content too large ({} bytes)", content.len()));
    }

    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    // Pre-load every `![alt](path)` image while we still have async runtime
    // access; the build functions themselves do no I/O.
    let images = load_markdown_images(&workdir, &content)?;

    let format = format.to_string();
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
        build(&lines, &images)
    })
    .await
    .map_err(|e| format!("{} build task failed: {}", format, e))??;

    write_bytes_to_workdir(&resolved, &bytes).await
}

/// Shared command body for the document readers (docx / xlsx / pdf) — the
/// read-side twin of [`write_markdown_document`]. Resolves and guards the
/// source (must be a file, within the doc-read size cap), then runs
/// `extract` on a blocking thread. `fmt` names the format in error
/// messages (e.g. "PDF" / "xlsx" / "docx").
///
/// The image reader doesn't share this: it has its own (smaller) size cap
/// and error phrasing.
pub(super) async fn read_document_blocking(
    workdir: String,
    rel_path: String,
    fmt: &str,
    extract: impl FnOnce(&Path) -> Result<String, String> + Send + 'static,
) -> Result<String, String> {
    let workdir = workdir_path(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    if !resolved.is_file() {
        return Err(path::not_a_file(&resolved, &rel_path));
    }

    extract_document_blocking(&resolved, fmt, extract).await
}

/// Stat-guard + `spawn_blocking` tail of [`read_document_blocking`], split
/// out so the absolute-path PDF reader (which resolves its own path) can
/// share it.
pub(super) async fn extract_document_blocking(
    resolved: &Path,
    fmt: &str,
    extract: impl FnOnce(&Path) -> Result<String, String> + Send + 'static,
) -> Result<String, String> {
    stat_within_limit(resolved, MAX_DOC_READ_BYTES, fmt).await?;

    let resolved = resolved.to_path_buf();
    let fmt = fmt.to_string();
    tokio::task::spawn_blocking(move || extract(&resolved))
        .await
        .map_err(|e| format!("{} extraction task failed: {}", fmt, e))?
}

#[cfg(test)]
mod tests {
    use super::docx::build_docx;
    use super::images::LoadedImage;
    use super::markdown_inline::{parse_standalone_image_line, ImageAlignment, ImageOptions};
    use super::odp::build_odp;
    use super::odt::build_odt;
    use super::slides::{Slide, SlideBullet, SlideLayout, SlideOrientation};

    use super::test_support::{assert_odf_mimetype, read_zip_entry, read_zip_entry_bytes};

    #[test]
    fn build_odt_produces_valid_odf_zip() {
        let bytes = build_odt(
            &["# Main Title", "## Subsection", "A paragraph."],
            &no_images(),
        )
        .unwrap();
        assert_odf_mimetype(&bytes, "application/vnd.oasis.opendocument.text");

        // Required files exist
        let manifest = read_zip_entry(&bytes, "META-INF/manifest.xml");
        assert!(manifest.contains("application/vnd.oasis.opendocument.text"));
        assert!(manifest.contains("content.xml"));
        assert!(manifest.contains("styles.xml"));

        // content.xml has the expected headings and paragraph
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains(r#"text:outline-level="1""#));
        assert!(content.contains("Main Title"));
        assert!(content.contains(r#"text:outline-level="2""#));
        assert!(content.contains("Subsection"));
        assert!(content.contains("<text:p>A paragraph.</text:p>"));
    }

    /// Build a real PNG of the given dimensions for image-embedding tests.
    /// `image::load_from_memory` has to be able to decode it, so we can't
    /// use a bytestring placeholder — go through the `image` crate.
    fn make_png(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbImage::new(width, height);
        let mut bytes: Vec<u8> = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        bytes
    }

    #[test]
    fn parse_standalone_image_line_matches_only_whole_line_refs() {
        assert_eq!(
            parse_standalone_image_line("![alt](pic.png)"),
            Some(("pic.png".to_string(), ImageOptions::default()))
        );
        assert_eq!(
            parse_standalone_image_line("   ![alt](pic.png)   "),
            Some(("pic.png".to_string(), ImageOptions::default()))
        );
        // Trailing prose disqualifies — image must be the entire line.
        assert_eq!(parse_standalone_image_line("![alt](pic.png) caption"), None);
        // Leading prose also disqualifies — only whole-line refs are blocks.
        assert_eq!(parse_standalone_image_line("see ![alt](pic.png)"), None);
        assert_eq!(parse_standalone_image_line("not an image"), None);
        assert_eq!(parse_standalone_image_line("![alt]()"), None);
    }

    #[test]
    fn parse_standalone_image_line_extracts_title_options() {
        let (path, opts) = parse_standalone_image_line(r#"![alt](pic.png "center 50%")"#).unwrap();
        assert_eq!(path, "pic.png");
        assert_eq!(opts.alignment, ImageAlignment::Center);
        assert!((opts.width_fraction.unwrap() - 0.5).abs() < 1e-6);

        // Single-quoted title and reversed token order both work.
        let (path, opts) =
            parse_standalone_image_line(r#"![hero](img/hero.png '75% right')"#).unwrap();
        assert_eq!(path, "img/hero.png");
        assert_eq!(opts.alignment, ImageAlignment::Right);
        assert!((opts.width_fraction.unwrap() - 0.75).abs() < 1e-6);

        // Unknown tokens are ignored, valid ones still apply.
        let (path, opts) =
            parse_standalone_image_line(r#"![a](pic.png "shrink center bogus 30%")"#).unwrap();
        assert_eq!(path, "pic.png");
        assert_eq!(opts.alignment, ImageAlignment::Center);
        assert!((opts.width_fraction.unwrap() - 0.3).abs() < 1e-6);

        // Out-of-range width gets clamped to [5%, 100%].
        let (_, opts) = parse_standalone_image_line(r#"![a](pic.png "200%")"#).unwrap();
        assert!((opts.width_fraction.unwrap() - 1.0).abs() < 1e-6);
        let (_, opts) = parse_standalone_image_line(r#"![a](pic.png "1%")"#).unwrap();
        assert!((opts.width_fraction.unwrap() - 0.05).abs() < 1e-6);
    }

    #[test]
    fn build_docx_embeds_referenced_image() {
        let mut images = std::collections::HashMap::new();
        let png = make_png(64, 32);
        images.insert(
            "hero.png".to_string(),
            LoadedImage {
                bytes: png.clone(),
                extension: "png".to_string(),
            },
        );

        let paragraphs = vec!["# Title", "intro", "![hero](hero.png)", "outro"];
        let bytes = build_docx(&paragraphs, &images).unwrap();

        // Image bytes land in word/media/image1.png.
        let media = read_zip_entry_bytes(&bytes, "word/media/image1.png");
        assert_eq!(media, png);

        // Content_Types declares the png extension default.
        let ct = read_zip_entry(&bytes, "[Content_Types].xml");
        assert!(ct.contains(r#"<Default Extension="png" ContentType="image/png"/>"#));

        // document.xml.rels has the image relationship.
        let rels = read_zip_entry(&bytes, "word/_rels/document.xml.rels");
        assert!(rels.contains(r#"Id="rId1""#));
        assert!(rels.contains("media/image1.png"));

        // document.xml contains a <w:drawing> with the expected r:embed ref.
        let doc = read_zip_entry(&bytes, "word/document.xml");
        assert!(doc.contains("<w:drawing>"));
        assert!(doc.contains(r#"r:embed="rId1""#));
        // Headings and prose still render normally alongside the image.
        assert!(doc.contains("Title"));
        assert!(doc.contains("intro"));
        assert!(doc.contains("outro"));
    }

    #[test]
    fn build_docx_without_images_skips_rels_file() {
        let paragraphs = vec!["# Title", "just text"];
        let bytes = build_docx(&paragraphs, &no_images()).unwrap();
        // word/_rels/document.xml.rels should not be present when there
        // are no images to reference.
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("valid zip");
        assert!(zip.by_name("word/_rels/document.xml.rels").is_err());
    }

    #[test]
    fn build_odt_embeds_referenced_image() {
        let mut images = std::collections::HashMap::new();
        let png = make_png(48, 24);
        images.insert(
            "logo.png".to_string(),
            LoadedImage {
                bytes: png.clone(),
                extension: "png".to_string(),
            },
        );

        let paragraphs = vec!["# Heading", "![logo](logo.png)", "footer"];
        let bytes = build_odt(&paragraphs, &images).unwrap();

        // Image bytes land in Pictures/image1.png.
        let media = read_zip_entry_bytes(&bytes, "Pictures/image1.png");
        assert_eq!(media, png);

        // Manifest lists the Pictures directory and the image file.
        let manifest = read_zip_entry(&bytes, "META-INF/manifest.xml");
        assert!(manifest.contains(r#"manifest:full-path="Pictures/""#));
        assert!(manifest.contains(r#"manifest:full-path="Pictures/image1.png""#));
        assert!(manifest.contains(r#"manifest:media-type="image/png""#));

        // content.xml has a draw:frame referencing the picture.
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains(r#"xlink:href="Pictures/image1.png""#));
        assert!(content.contains("<draw:frame"));
        // Heading and trailing paragraph still render.
        assert!(content.contains("Heading"));
        assert!(content.contains("footer"));
    }

    #[test]
    fn build_docx_honors_image_alignment_and_width() {
        let mut images = std::collections::HashMap::new();
        images.insert(
            "hero.png".to_string(),
            LoadedImage {
                bytes: make_png(100, 50),
                extension: "png".to_string(),
            },
        );
        let bytes = build_docx(
            &["![hero](hero.png \"center 50%\")", "![hero](hero.png)"],
            &images,
        )
        .unwrap();
        let doc = read_zip_entry(&bytes, "word/document.xml");
        // First reference is centered.
        assert!(doc.contains(r#"<w:jc w:val="center"/>"#));
        // The default-left second reference omits w:pPr/w:jc entirely. Two
        // separate <w:drawing> blocks should appear regardless.
        let drawings = doc.matches("<w:drawing>").count();
        assert_eq!(drawings, 2);
        // 50% of the 6 inch content width is ~2_743_200 EMU. Let the test
        // be permissive: assert *some* cx value in the expected range
        // appears.
        let has_half_width = (2_500_000..3_000_000)
            .step_by(1)
            .any(|emu| doc.contains(&format!(r#"cx="{}""#, emu)));
        // The exact computed cx is deterministic; verify the literal too.
        assert!(
            doc.contains(r#"cx="2743200""#) || has_half_width,
            "expected ~50% content-width cx in docx, got:\n{}",
            doc
        );
    }

    #[test]
    fn build_odt_honors_image_alignment_and_width() {
        let mut images = std::collections::HashMap::new();
        images.insert(
            "hero.png".to_string(),
            LoadedImage {
                bytes: make_png(100, 50),
                extension: "png".to_string(),
            },
        );
        let bytes = build_odt(
            &[
                "![hero](hero.png \"right 75%\")",
                "![hero](hero.png \"center\")",
            ],
            &images,
        )
        .unwrap();
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains(r#"text:style-name="ImageRight""#));
        assert!(content.contains(r#"text:style-name="ImageCenter""#));
        // Style declarations should appear in automatic-styles.
        assert!(content.contains(r#"style:name="ImageCenter""#));
        assert!(content.contains(r#"style:name="ImageRight""#));
        // 75% of 6" ≈ 11.43 cm. Match the cm decimal in the svg:width.
        assert!(
            content.contains(r#"svg:width="11.430cm""#)
                || content.contains(r#"svg:width="11.43cm""#),
            "expected ~11.43cm width in odt content, got:\n{}",
            content
        );
    }

    #[test]
    fn build_odt_escapes_xml_special_chars() {
        let bytes = build_odt(&["Contains < and > and & and \"quoted\""], &no_images()).unwrap();
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains("&lt;"));
        assert!(content.contains("&gt;"));
        assert!(content.contains("&amp;"));
        assert!(content.contains("&quot;"));
        // And raw specials should not appear in the escaped paragraph text
        assert!(!content.contains("< and >"));
    }

    /// Build a SlideBullet at level 0 (the default). Shorthand used in
    /// tests that just want a flat bullet list without nesting.
    fn b(text: &str) -> SlideBullet {
        SlideBullet {
            text: text.to_string(),
            level: 0,
        }
    }

    /// Build a Slide with only title + bullets populated; everything
    /// else defaults. Matches the original pre-extension ergonomics so
    /// existing tests stay focused on what they're checking.
    fn content_slide(title: &str, bullets: Vec<SlideBullet>) -> Slide {
        Slide {
            title: title.to_string(),
            bullets,
            subtitle: None,
            image: None,
            layout: SlideLayout::Content,
        }
    }

    /// Empty images map helper — used by tests that don't exercise
    /// image embedding so the call sites stay readable.
    fn no_images() -> std::collections::HashMap<String, LoadedImage> {
        std::collections::HashMap::new()
    }

    #[test]
    fn build_odp_section_layout_uses_section_title_style() {
        let slides = vec![Slide {
            title: "Part Two".to_string(),
            subtitle: Some("Applications".to_string()),
            bullets: vec![],
            image: None,
            layout: SlideLayout::Section,
        }];
        let bytes = build_odp(&slides, &no_images(), SlideOrientation::Landscape).unwrap();
        let content = read_zip_entry(&bytes, "content.xml");

        // SectionTitle paragraph style is referenced (bigger + centered).
        assert!(content.contains(r#"text:style-name="SectionTitle""#));
        assert!(content.contains(r#"text:style-name="SectionSubtitle""#));
        assert!(content.contains("Part Two"));
        assert!(content.contains("Applications"));
        // No content-slide title style on section slides.
        assert!(!content.contains(r#"text:style-name="TitleText""#));
    }

    #[test]
    fn build_odp_nested_bullets_use_level_styles() {
        let slides = vec![Slide {
            title: "Nested".to_string(),
            subtitle: None,
            bullets: vec![
                SlideBullet {
                    text: "Parent".to_string(),
                    level: 0,
                },
                SlideBullet {
                    text: "Child".to_string(),
                    level: 1,
                },
                SlideBullet {
                    text: "Grandchild".to_string(),
                    level: 2,
                },
            ],
            image: None,
            layout: SlideLayout::Content,
        }];
        let bytes = build_odp(&slides, &no_images(), SlideOrientation::Landscape).unwrap();
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains(r#"text:style-name="BulletText0""#));
        assert!(content.contains(r#"text:style-name="BulletText1""#));
        assert!(content.contains(r#"text:style-name="BulletText2""#));
    }

    #[test]
    fn build_odp_embeds_referenced_images() {
        let fake_jpg = b"\xff\xd8\xff\xe0fake-jpeg-bytes".to_vec();
        let mut images = std::collections::HashMap::new();
        images.insert(
            "diagram.jpg".to_string(),
            LoadedImage {
                bytes: fake_jpg.clone(),
                extension: "jpeg".to_string(),
            },
        );
        let slides = vec![Slide {
            title: "Architecture".to_string(),
            subtitle: None,
            bullets: vec![b("overview")],
            image: Some("diagram.jpg".to_string()),
            layout: SlideLayout::Content,
        }];
        let bytes = build_odp(&slides, &images, SlideOrientation::Landscape).unwrap();
        assert_odf_mimetype(&bytes, "application/vnd.oasis.opendocument.presentation");

        // Image lives under Pictures/ and was written verbatim.
        let media = read_zip_entry_bytes(&bytes, "Pictures/image1.jpeg");
        assert_eq!(media, fake_jpg);

        // content.xml references the image via xlink:href.
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains(r#"xlink:href="Pictures/image1.jpeg""#));

        // Manifest enumerates the image with the right media type.
        let manifest = read_zip_entry(&bytes, "META-INF/manifest.xml");
        assert!(manifest.contains(r#"manifest:full-path="Pictures/image1.jpeg""#));
        assert!(manifest.contains(r#"manifest:media-type="image/jpeg""#));
    }

    #[test]
    fn build_odp_produces_valid_odf_zip_with_slides() {
        let slides = vec![
            content_slide("Overview", vec![b("Item one"), b("Item two")]),
            content_slide("Details", vec![b("Only item")]),
        ];
        let bytes = build_odp(&slides, &no_images(), SlideOrientation::Landscape).unwrap();
        assert_odf_mimetype(&bytes, "application/vnd.oasis.opendocument.presentation");

        let content = read_zip_entry(&bytes, "content.xml");
        // One draw:page per input slide.
        assert_eq!(content.matches("<draw:page").count(), 2);
        // Title and bullet text both appear.
        assert!(content.contains("Overview"));
        assert!(content.contains("Item one"));
        assert!(content.contains("Item two"));
        assert!(content.contains("Details"));
        assert!(content.contains("Only item"));
        // Each slide references the master page.
        assert!(content.contains(r#"draw:master-page-name="Default""#));
    }

    #[test]
    fn build_odp_portrait_turns_the_page_and_stacks_the_image() {
        let mut images = std::collections::HashMap::new();
        images.insert(
            "a.png".to_string(),
            LoadedImage {
                bytes: b"png".to_vec(),
                extension: "png".to_string(),
            },
        );
        let mut slide = content_slide("Tall", vec![b("point")]);
        slide.image = Some("a.png".to_string());
        let bytes = build_odp(&[slide], &images, SlideOrientation::Portrait).unwrap();
        let styles = read_zip_entry(&bytes, "styles.xml");
        assert!(styles.contains(r#"fo:page-width="14.288cm" fo:page-height="25.4cm""#));
        assert!(styles.contains(r#"style:print-orientation="portrait""#));
        // The image spans the body's width above the bullets, not beside them.
        let content = read_zip_entry(&bytes, "content.xml");
        let image = content
            .split("<draw:frame ")
            .find(|f| f.contains("<draw:image"))
            .unwrap();
        assert!(image.contains(r#"svg:x="1cm" svg:y="4.2cm" svg:width="11.888cm""#));
    }

    #[test]
    fn build_odp_landscape_keeps_the_widescreen_page() {
        let slides = vec![content_slide("Wide", vec![b("point")])];
        let bytes = build_odp(&slides, &no_images(), SlideOrientation::Landscape).unwrap();
        let styles = read_zip_entry(&bytes, "styles.xml");
        assert!(styles.contains(r#"fo:page-width="25.4cm" fo:page-height="14.288cm""#));
        let content = read_zip_entry(&bytes, "content.xml");
        assert!(content.contains(r#"svg:x="1cm" svg:y="3.2cm" svg:width="23cm" svg:height="10cm""#));
    }

    #[test]
    fn build_odp_empty_slides_returns_error() {
        let slides: Vec<Slide> = Vec::new();
        assert!(build_odp(&slides, &no_images(), SlideOrientation::Landscape).is_err());
    }
}
