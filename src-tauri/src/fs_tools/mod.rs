pub mod absolute;
pub mod bytes;
pub mod created;
pub mod document_write;
pub mod docx;
pub mod download;
pub mod editor;
pub mod fuzzy;
pub mod images;
pub mod odf;
pub mod odp;
pub mod path;
pub mod pdf_read;
pub mod pptx;
pub mod preview;
pub mod slides;
pub mod text;
pub mod xlsx;
pub mod xml;

#[cfg(test)]
mod test_support;

pub(crate) use path::ensure_parent_dir;
pub use path::resolve_in_workdir;
pub(crate) use path::workdir_path;
pub use pdf_read::init_pdfium;

use path::{stat_within_limit, MAX_DOC_READ_BYTES};
use std::path::Path;

/// Shared command body for the document readers (docx / xlsx / pdf): resolves
/// and guards the source (must be a file, within the doc-read size cap), then
/// runs `extract` on a blocking thread. `fmt` names the format in error
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
    use super::images::LoadedImage;
    use super::odp::build_odp;
    use super::slides::{Slide, SlideBullet, SlideLayout, SlideOrientation};

    use super::test_support::{assert_odf_mimetype, read_zip_entry, read_zip_entry_bytes};

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
