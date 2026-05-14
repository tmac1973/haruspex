pub mod docx;
pub mod download;
pub mod images;
pub mod markdown_inline;
pub mod odp;
pub mod odt;
pub mod path;
pub mod pdf_read;
pub mod pdf_write;
pub mod pptx;
pub mod text;
pub mod xlsx;

pub use path::resolve_in_workdir;
pub use pdf_read::init_pdfium;

#[cfg(test)]
mod tests {
    use super::docx::build_docx;
    use super::images::{
        extract_markdown_image_paths, image_pixel_dimensions, load_markdown_images, px_to_emu,
        LoadedImage, MAX_DOC_IMAGE_WIDTH_EMU,
    };
    use super::markdown_inline::{
        ascii_fold_for_pdf, escape_xml, format_table_as_monoblock, is_horizontal_rule,
        is_table_separator, normalize_list_marker, pad_right, parse_heading, parse_inline_markdown,
        parse_standalone_image_line, preprocess_lines, runs_to_words, strip_inline_markdown,
        wrap_styled_words, wrap_to_width, DocumentBlock, ImageAlignment, ImageOptions, InlineRun,
    };
    use super::odp::build_odp;
    use super::odt::build_odt;
    use super::path::{refuse_if_exists, resolve_in_workdir, workdir_path};
    use super::pdf_write::build_pdf;
    use super::pptx::{build_pptx, PptxBullet, PptxLayout, PptxSlide};
    use super::xlsx::XlsxSheet;
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn make_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_fs_test_{}", name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_inline_markdown_bold_italic() {
        let runs = parse_inline_markdown("plain **bold** and *italic* end");
        let collected: Vec<(String, bool, bool)> = runs
            .iter()
            .map(|r| (r.text.clone(), r.bold, r.italic))
            .collect();
        // Expected: "plain " plain, "bold" bold, " and " plain, "italic" italic, " end" plain
        assert_eq!(collected.len(), 5);
        assert_eq!(collected[0], ("plain ".to_string(), false, false));
        assert_eq!(collected[1], ("bold".to_string(), true, false));
        assert_eq!(collected[2], (" and ".to_string(), false, false));
        assert_eq!(collected[3], ("italic".to_string(), false, true));
        assert_eq!(collected[4], (" end".to_string(), false, false));
    }

    #[test]
    fn parse_inline_markdown_strips_code_and_links() {
        let runs = parse_inline_markdown("use `cargo` then see [docs](https://example.com).");
        // Concatenated plain text should have the backticks and link URL stripped.
        let joined: String = runs.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(joined, "use cargo then see docs.");
        // None of the runs should carry the URL itself.
        assert!(!joined.contains("https://"));
        assert!(!joined.contains('`'));
        assert!(!joined.contains('['));
    }

    #[test]
    fn parse_inline_markdown_unclosed_emphasis_is_tolerated() {
        // Unclosed ** — everything after becomes bold, but at least the
        // literal asterisks don't leak through to the PDF.
        let runs = parse_inline_markdown("before **unfinished");
        let joined: String = runs.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(joined, "before unfinished");
    }

    #[test]
    fn normalize_list_marker_disambiguates_star_and_plus() {
        // `- ` passes through unchanged (already unambiguous)
        assert_eq!(normalize_list_marker("- one"), "- one");
        // `* ` and `+ ` get rewritten so the inline parser doesn't mistake
        // the opening `*` for italic emphasis
        assert_eq!(normalize_list_marker("* two"), "- two");
        assert_eq!(normalize_list_marker("+ three"), "- three");
        // Indented list marker preserves indentation
        assert_eq!(normalize_list_marker("  * nested"), "  - nested");
        // Numbered lists pass through untouched
        assert_eq!(normalize_list_marker("1. first"), "1. first");
        // Leading `*italic*` shouldn't match (no space after opening *)
        assert_eq!(normalize_list_marker("*italic*"), "*italic*");
    }

    #[test]
    fn ascii_fold_for_pdf_replaces_bullets_and_arrows() {
        // Bullets, arrows, and smart punctuation — the exact characters
        // that previously produced `â€¢` / `â†'` mojibake in the PDF.
        assert_eq!(ascii_fold_for_pdf("a \u{2022} b"), "a - b");
        assert_eq!(ascii_fold_for_pdf("\u{2192} and \u{2193}"), "-> and v");
        assert_eq!(ascii_fold_for_pdf("\u{2190}\u{2191}\u{2194}"), "<-^<->");
        // Smart quotes
        assert_eq!(ascii_fold_for_pdf("\u{2018}hi\u{2019}"), "'hi'");
        assert_eq!(ascii_fold_for_pdf("\u{201C}hi\u{201D}"), "\"hi\"");
        // Dashes and ellipsis
        assert_eq!(ascii_fold_for_pdf("a\u{2013}b"), "a-b");
        assert_eq!(ascii_fold_for_pdf("a\u{2014}b"), "a--b");
        assert_eq!(ascii_fold_for_pdf("loading\u{2026}"), "loading...");
    }

    #[test]
    fn ascii_fold_for_pdf_strips_accents() {
        assert_eq!(ascii_fold_for_pdf("café"), "cafe");
        assert_eq!(ascii_fold_for_pdf("naïve"), "naive");
        assert_eq!(ascii_fold_for_pdf("Ångström"), "Angstrom");
        assert_eq!(ascii_fold_for_pdf("mañana"), "manana");
        assert_eq!(ascii_fold_for_pdf("Straße"), "Strasse");
    }

    #[test]
    fn ascii_fold_for_pdf_handles_box_drawing() {
        // Box-drawing characters fold to ASCII pipes/dashes/pluses so any
        // ASCII-art tables or diagrams the model emits stay legible.
        assert_eq!(ascii_fold_for_pdf("\u{250C}\u{2500}\u{2510}"), "+-+");
        assert_eq!(
            ascii_fold_for_pdf("\u{2502} a \u{2502} b \u{2502}"),
            "| a | b |"
        );
    }

    #[test]
    fn ascii_fold_for_pdf_passes_through_ascii() {
        let text = "Hello, World! 123 + 456 = 579. `code` and **bold**.";
        assert_eq!(ascii_fold_for_pdf(text), text);
    }

    #[test]
    fn is_horizontal_rule_matches_common_forms() {
        assert!(is_horizontal_rule("---"));
        assert!(is_horizontal_rule("----"));
        assert!(is_horizontal_rule("***"));
        assert!(is_horizontal_rule("___"));
        assert!(is_horizontal_rule("  ---  "));
        assert!(is_horizontal_rule("- - -"));
        assert!(is_horizontal_rule("-- -")); // 3 dashes with a space is still a valid HR
                                             // Not rules
        assert!(!is_horizontal_rule("--")); // only 2 dashes
        assert!(!is_horizontal_rule("abc"));
        assert!(!is_horizontal_rule(""));
        assert!(!is_horizontal_rule("-*-"));
    }

    #[test]
    fn format_table_as_monoblock_strips_inline_markdown_from_cells() {
        // The exact failure mode the user reported: table cells contain
        // `**Bold**` for emphasis, which the Courier table renderer was
        // dumping verbatim. After stripping, the asterisks should be gone
        // but the content preserved.
        let header = vec!["**Feature**".to_string(), "Service".to_string()];
        let rows = vec![
            vec!["**Cost:**".to_string(), "Low".to_string()],
            vec!["`focus`".to_string(), "*IT*".to_string()],
            vec!["[link](url)".to_string(), "Med".to_string()],
        ];
        let out = format_table_as_monoblock(&header, &rows);
        let all_text: String = out
            .iter()
            .map(|l| l.text.clone())
            .collect::<Vec<_>>()
            .join("\n");

        // Literal markdown syntax characters must not leak into any line.
        assert!(!all_text.contains("**"));
        assert!(!all_text.contains('`'));
        assert!(!all_text.contains("["));
        assert!(!all_text.contains("]("));

        // But the underlying content survives.
        assert!(all_text.contains("Feature"));
        assert!(all_text.contains("Cost:"));
        assert!(all_text.contains("focus"));
        assert!(all_text.contains("IT"));
        assert!(all_text.contains("link"));
    }

    /// Parse the bytes returned by build_odt / build_ods / build_odp as a
    /// zip archive and verify the ODF first-entry-stored-mimetype
    /// invariants: (1) first file is named "mimetype", (2) it uses
    /// Stored compression, (3) its contents match the expected media
    /// type for the format. Shared helper for the three ODF tests below.
    fn assert_odf_mimetype(bytes: &[u8], expected_mime: &str) {
        let cursor = std::io::Cursor::new(bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("valid zip");
        let mut first = zip.by_index(0).expect("at least one entry");
        assert_eq!(first.name(), "mimetype", "first entry must be mimetype");
        assert_eq!(
            first.compression(),
            zip::CompressionMethod::Stored,
            "mimetype must be stored uncompressed"
        );
        let mut content = String::new();
        use std::io::Read;
        first.read_to_string(&mut content).unwrap();
        assert_eq!(content, expected_mime);
    }

    /// Read an entire file out of a zip archive as a UTF-8 string.
    fn read_zip_entry(bytes: &[u8], name: &str) -> String {
        let cursor = std::io::Cursor::new(bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("valid zip");
        let mut entry = zip
            .by_name(name)
            .unwrap_or_else(|_| panic!("{} missing", name));
        let mut content = String::new();
        use std::io::Read;
        entry.read_to_string(&mut content).unwrap();
        content
    }

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
    fn build_pdf_embeds_referenced_image_without_panicking() {
        // We can't easily decode the PDF stream here to confirm the image
        // is positioned correctly, but we can at least verify the builder
        // accepts a markdown body with an image reference and produces a
        // non-empty PDF.
        let mut images = std::collections::HashMap::new();
        images.insert(
            "chart.png".to_string(),
            LoadedImage {
                bytes: make_png(80, 60),
                extension: "png".to_string(),
            },
        );
        let bytes = build_pdf(
            &[
                "# Report",
                "Some prose.",
                "![chart](chart.png)",
                "More prose.",
            ],
            &images,
        )
        .unwrap();
        assert!(!bytes.is_empty());
        // PDFs start with %PDF-
        assert!(bytes.starts_with(b"%PDF-"));
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

    /// Build a PptxBullet at level 0 (the default). Shorthand used in
    /// tests that just want a flat bullet list without nesting.
    fn b(text: &str) -> PptxBullet {
        PptxBullet {
            text: text.to_string(),
            level: 0,
        }
    }

    /// Build a PptxSlide with only title + bullets populated; everything
    /// else defaults. Matches the original pre-extension ergonomics so
    /// existing tests stay focused on what they're checking.
    fn content_slide(title: &str, bullets: Vec<PptxBullet>) -> PptxSlide {
        PptxSlide {
            title: title.to_string(),
            bullets,
            subtitle: None,
            image: None,
            layout: PptxLayout::Content,
        }
    }

    /// Empty images map helper — used by tests that don't exercise
    /// image embedding so the call sites stay readable.
    fn no_images() -> std::collections::HashMap<String, LoadedImage> {
        std::collections::HashMap::new()
    }

    #[test]
    fn build_pptx_produces_required_package_parts() {
        let slides = vec![
            content_slide(
                "Introduction",
                vec![b("First point"), b("Second point"), b("Third point")],
            ),
            content_slide("Conclusion", vec![b("Wrap it up")]),
        ];
        let bytes = build_pptx(&slides, &no_images()).unwrap();

        // Every part PowerPoint needs to open the file must be present.
        let required = [
            "[Content_Types].xml",
            "_rels/.rels",
            "ppt/presentation.xml",
            "ppt/_rels/presentation.xml.rels",
            "ppt/slideMasters/slideMaster1.xml",
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            "ppt/slideLayouts/slideLayout1.xml",
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            "ppt/theme/theme1.xml",
            "ppt/slides/slide1.xml",
            "ppt/slides/slide2.xml",
            "ppt/slides/_rels/slide1.xml.rels",
            "ppt/slides/_rels/slide2.xml.rels",
        ];
        for name in required {
            read_zip_entry(&bytes, name);
        }

        // Slide 1 should contain the title and all three bullets.
        let slide1 = read_zip_entry(&bytes, "ppt/slides/slide1.xml");
        assert!(slide1.contains("Introduction"));
        assert!(slide1.contains("First point"));
        assert!(slide1.contains("Second point"));
        assert!(slide1.contains("Third point"));
        // And title is rendered at 32pt bold.
        assert!(slide1.contains(r#"sz="3200""#));
        assert!(slide1.contains(r#"b="1""#));
        // Bullets at 18pt.
        assert!(slide1.contains(r#"sz="1800""#));

        // Slide 2 gets its own content.
        let slide2 = read_zip_entry(&bytes, "ppt/slides/slide2.xml");
        assert!(slide2.contains("Conclusion"));
        assert!(slide2.contains("Wrap it up"));

        // Content Types enumerates both slide parts.
        let ct = read_zip_entry(&bytes, "[Content_Types].xml");
        assert!(ct.contains("slide1.xml"));
        assert!(ct.contains("slide2.xml"));

        // Presentation rels has master + both slide rels.
        let rels = read_zip_entry(&bytes, "ppt/_rels/presentation.xml.rels");
        assert!(rels.contains("slideMaster1.xml"));
        assert!(rels.contains("slides/slide1.xml"));
        assert!(rels.contains("slides/slide2.xml"));
    }

    /// Read a zip entry's raw bytes (used by the image-embedding tests
    /// to verify binary parts were written verbatim).
    fn read_zip_entry_bytes(bytes: &[u8], name: &str) -> Vec<u8> {
        let cursor = std::io::Cursor::new(bytes);
        let mut zip = zip::ZipArchive::new(cursor).expect("valid zip");
        let mut entry = zip
            .by_name(name)
            .unwrap_or_else(|_| panic!("{} missing", name));
        let mut out = Vec::new();
        use std::io::Read;
        entry.read_to_end(&mut out).unwrap();
        out
    }

    #[test]
    fn build_pptx_section_layout_emits_centered_title_without_body() {
        let slides = vec![PptxSlide {
            title: "Part One".to_string(),
            subtitle: Some("Foundations".to_string()),
            bullets: vec![],
            image: None,
            layout: PptxLayout::Section,
        }];
        let bytes = build_pptx(&slides, &no_images()).unwrap();
        let slide1 = read_zip_entry(&bytes, "ppt/slides/slide1.xml");

        // Section title uses the 44pt font and centered alignment.
        assert!(slide1.contains(r#"sz="4400""#));
        assert!(slide1.contains(r#"algn="ctr""#));
        // No 32pt content-slide title in a section slide.
        assert!(!slide1.contains(r#"sz="3200""#));
        // Title text and subtitle both present.
        assert!(slide1.contains("Part One"));
        assert!(slide1.contains("Foundations"));
        // No content shape named "Content" — section slides skip the body.
        assert!(!slide1.contains(r#"name="Content""#));
    }

    #[test]
    fn build_pptx_nested_bullets_emit_lvl_attribute() {
        let slides = vec![PptxSlide {
            title: "Nested".to_string(),
            subtitle: None,
            bullets: vec![
                PptxBullet {
                    text: "Top level".to_string(),
                    level: 0,
                },
                PptxBullet {
                    text: "Child A".to_string(),
                    level: 1,
                },
                PptxBullet {
                    text: "Grandchild".to_string(),
                    level: 2,
                },
            ],
            image: None,
            layout: PptxLayout::Content,
        }];
        let bytes = build_pptx(&slides, &no_images()).unwrap();
        let slide1 = read_zip_entry(&bytes, "ppt/slides/slide1.xml");

        // Each level maps to a distinct lvl / font-size / margin.
        assert!(slide1.contains(r#"lvl="0""#));
        assert!(slide1.contains(r#"lvl="1""#));
        assert!(slide1.contains(r#"lvl="2""#));
        assert!(slide1.contains(r#"sz="1800""#)); // level 0 → 18pt
        assert!(slide1.contains(r#"sz="1600""#)); // level 1 → 16pt
        assert!(slide1.contains(r#"sz="1400""#)); // level 2 → 14pt
                                                  // Per-level left margin increases.
        assert!(slide1.contains(r#"marL="457200""#));
        assert!(slide1.contains(r#"marL="914400""#));
        assert!(slide1.contains(r#"marL="1371600""#));
    }

    #[test]
    fn build_pptx_deserializes_plain_string_bullets() {
        // Round-trip via JSON to confirm the untagged enum accepts the
        // old shape: bullets as an array of plain strings. This is how
        // existing model-generated tool calls look.
        let json = r#"{
            "title": "Plain",
            "bullets": ["first", "second", "third"]
        }"#;
        let slide: PptxSlide = serde_json::from_str(json).unwrap();
        assert_eq!(slide.title, "Plain");
        assert_eq!(slide.bullets.len(), 3);
        for bullet in &slide.bullets {
            assert_eq!(bullet.level, 0);
        }
        assert_eq!(slide.bullets[0].text, "first");
    }

    #[test]
    fn build_pptx_deserializes_structured_bullets_with_level() {
        let json = r#"{
            "title": "Mixed",
            "bullets": [
                "flat string",
                { "text": "nested", "level": 1 },
                { "text": "deep", "level": 2 }
            ],
            "layout": "content"
        }"#;
        let slide: PptxSlide = serde_json::from_str(json).unwrap();
        assert_eq!(slide.bullets.len(), 3);
        assert_eq!(slide.bullets[0].level, 0);
        assert_eq!(slide.bullets[1].level, 1);
        assert_eq!(slide.bullets[1].text, "nested");
        assert_eq!(slide.bullets[2].level, 2);
        assert_eq!(slide.layout, PptxLayout::Content);
    }

    #[test]
    fn build_pptx_deserializes_section_layout() {
        let json = r#"{
            "title": "Part Two",
            "bullets": [],
            "layout": "section",
            "subtitle": "Deep Dive"
        }"#;
        let slide: PptxSlide = serde_json::from_str(json).unwrap();
        assert_eq!(slide.layout, PptxLayout::Section);
        assert_eq!(slide.subtitle.as_deref(), Some("Deep Dive"));
    }

    #[test]
    fn build_pptx_embeds_referenced_images() {
        let fake_png = b"\x89PNG\r\n\x1a\nfake-png-bytes-for-test".to_vec();
        let mut images = std::collections::HashMap::new();
        images.insert(
            "hero.png".to_string(),
            LoadedImage {
                bytes: fake_png.clone(),
                extension: "png".to_string(),
            },
        );

        let slides = vec![PptxSlide {
            title: "With Image".to_string(),
            subtitle: None,
            bullets: vec![b("context line")],
            image: Some("hero.png".to_string()),
            layout: PptxLayout::Content,
        }];
        let bytes = build_pptx(&slides, &images).unwrap();

        // Media file was written under the expected deterministic name.
        let media = read_zip_entry_bytes(&bytes, "ppt/media/image1.png");
        assert_eq!(media, fake_png);

        // Content_Types gets a Default for the png extension.
        let ct = read_zip_entry(&bytes, "[Content_Types].xml");
        assert!(ct.contains(r#"<Default Extension="png" ContentType="image/png"/>"#));

        // Slide XML has a p:pic referencing rId2 (rId1 is the layout).
        let slide1 = read_zip_entry(&bytes, "ppt/slides/slide1.xml");
        assert!(slide1.contains("<p:pic>"));
        assert!(slide1.contains(r#"r:embed="rId2""#));

        // Slide rels has both the layout and image relationships.
        let rels = read_zip_entry(&bytes, "ppt/slides/_rels/slide1.xml.rels");
        assert!(rels.contains(r#"Id="rId1""#));
        assert!(rels.contains(r#"Id="rId2""#));
        assert!(rels.contains("image1.png"));
    }

    #[test]
    fn build_pptx_deduplicates_shared_image_across_slides() {
        // Two slides referencing the same image path should share a
        // single ppt/media/image1.png file, not generate two copies.
        let fake_png = b"\x89PNGdedup".to_vec();
        let mut images = std::collections::HashMap::new();
        images.insert(
            "logo.png".to_string(),
            LoadedImage {
                bytes: fake_png.clone(),
                extension: "png".to_string(),
            },
        );
        let slides = vec![
            PptxSlide {
                title: "A".to_string(),
                subtitle: None,
                bullets: vec![b("one")],
                image: Some("logo.png".to_string()),
                layout: PptxLayout::Content,
            },
            PptxSlide {
                title: "B".to_string(),
                subtitle: None,
                bullets: vec![b("two")],
                image: Some("logo.png".to_string()),
                layout: PptxLayout::Content,
            },
        ];
        let bytes = build_pptx(&slides, &images).unwrap();

        // Only one media file, with the first-appearance index.
        let _ = read_zip_entry_bytes(&bytes, "ppt/media/image1.png");
        let cursor = std::io::Cursor::new(&bytes);
        let zip = zip::ZipArchive::new(cursor).unwrap();
        let media_entries: Vec<_> = zip
            .file_names()
            .filter(|n| n.starts_with("ppt/media/"))
            .collect();
        assert_eq!(media_entries.len(), 1);

        // Both slide rels point at the same image1.png.
        let rels1 = read_zip_entry(&bytes, "ppt/slides/_rels/slide1.xml.rels");
        let rels2 = read_zip_entry(&bytes, "ppt/slides/_rels/slide2.xml.rels");
        assert!(rels1.contains("image1.png"));
        assert!(rels2.contains("image1.png"));
    }

    #[test]
    fn build_odp_section_layout_uses_section_title_style() {
        let slides = vec![PptxSlide {
            title: "Part Two".to_string(),
            subtitle: Some("Applications".to_string()),
            bullets: vec![],
            image: None,
            layout: PptxLayout::Section,
        }];
        let bytes = build_odp(&slides, &no_images()).unwrap();
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
        let slides = vec![PptxSlide {
            title: "Nested".to_string(),
            subtitle: None,
            bullets: vec![
                PptxBullet {
                    text: "Parent".to_string(),
                    level: 0,
                },
                PptxBullet {
                    text: "Child".to_string(),
                    level: 1,
                },
                PptxBullet {
                    text: "Grandchild".to_string(),
                    level: 2,
                },
            ],
            image: None,
            layout: PptxLayout::Content,
        }];
        let bytes = build_odp(&slides, &no_images()).unwrap();
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
        let slides = vec![PptxSlide {
            title: "Architecture".to_string(),
            subtitle: None,
            bullets: vec![b("overview")],
            image: Some("diagram.jpg".to_string()),
            layout: PptxLayout::Content,
        }];
        let bytes = build_odp(&slides, &images).unwrap();
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
    fn build_pptx_empty_slides_returns_error() {
        let slides: Vec<PptxSlide> = Vec::new();
        assert!(build_pptx(&slides, &no_images()).is_err());
    }

    #[test]
    fn build_pptx_escapes_xml_in_title_and_bullets() {
        let slides = vec![content_slide(
            "A & B <vs> C",
            vec![b("1 < 2"), b(r#"He said "hi""#)],
        )];
        let bytes = build_pptx(&slides, &no_images()).unwrap();
        let slide1 = read_zip_entry(&bytes, "ppt/slides/slide1.xml");
        assert!(slide1.contains("&amp;"));
        assert!(slide1.contains("&lt;"));
        assert!(slide1.contains("&gt;"));
        assert!(slide1.contains("&quot;"));
        // Raw angle brackets in the user text should not appear as part
        // of the run text (the structural XML itself still has <a:t> etc).
        assert!(!slide1.contains("A & B <vs>"));
    }

    #[test]
    fn build_odp_produces_valid_odf_zip_with_slides() {
        let slides = vec![
            content_slide("Overview", vec![b("Item one"), b("Item two")]),
            content_slide("Details", vec![b("Only item")]),
        ];
        let bytes = build_odp(&slides, &no_images()).unwrap();
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
    fn build_odp_empty_slides_returns_error() {
        let slides: Vec<PptxSlide> = Vec::new();
        assert!(build_odp(&slides, &no_images()).is_err());
    }

    #[test]
    fn strip_inline_markdown_removes_syntax_chars() {
        assert_eq!(strip_inline_markdown("**bold**"), "bold");
        assert_eq!(
            strip_inline_markdown("plain *italic* mix"),
            "plain italic mix"
        );
        assert_eq!(strip_inline_markdown("`code`"), "code");
        assert_eq!(strip_inline_markdown("[label](https://x)"), "label");
        assert_eq!(
            strip_inline_markdown("**Cost:** $5 *per* `month`"),
            "Cost: $5 per month"
        );
        // Plain ASCII passes through untouched.
        assert_eq!(
            strip_inline_markdown("no markdown here"),
            "no markdown here"
        );
    }

    #[test]
    fn format_table_as_monoblock_aligns_columns() {
        let header = vec![
            "Feature".to_string(),
            "MSP".to_string(),
            "MSSP".to_string(),
            "MDR".to_string(),
        ];
        let rows = vec![
            vec![
                "Cost".to_string(),
                "Low".to_string(),
                "Med".to_string(),
                "High".to_string(),
            ],
            vec![
                "Focus".to_string(),
                "IT".to_string(),
                "Sec".to_string(),
                "IR".to_string(),
            ],
        ];
        let out = format_table_as_monoblock(&header, &rows);

        // First line should be the (bold) header row.
        assert!(out[0].bold);
        assert!(out[0].text.contains("Feature"));
        assert!(out[0].text.contains("MSP"));
        assert!(out[0].text.contains("MSSP"));
        assert!(out[0].text.contains("MDR"));

        // Second line should be the dashed separator under the header.
        assert!(!out[1].bold);
        assert!(out[1].text.contains("---"));

        // Each MonoLine should have the same rendered width (padded).
        let widths: Vec<usize> = out.iter().map(|l| l.text.chars().count()).collect();
        assert!(widths.windows(2).all(|w| w[0] == w[1]));

        // Data rows should exist and be non-bold.
        assert!(out.iter().any(|l| !l.bold && l.text.contains("Cost")));
        assert!(out.iter().any(|l| !l.bold && l.text.contains("Focus")));
    }

    #[test]
    fn preprocess_lines_rewrites_tables_to_monoblock() {
        let lines = vec![
            "Intro paragraph.",
            "",
            "| A | B | C |",
            "| :--- | :--- | :--- |",
            "| 1 | 2 | 3 |",
            "",
            "After table.",
        ];
        let out = preprocess_lines(&lines);

        // The table should become exactly one MonoBlock.
        let mono_count = out
            .iter()
            .filter(|b| matches!(b, DocumentBlock::MonoBlock(_)))
            .count();
        assert_eq!(mono_count, 1);

        // And surrounding text should still be Line blocks.
        let line_texts: Vec<&str> = out
            .iter()
            .filter_map(|b| match b {
                DocumentBlock::Line(s) => Some(s.as_str()),
                _ => None,
            })
            .collect();
        assert!(line_texts.contains(&"Intro paragraph."));
        assert!(line_texts.contains(&"After table."));

        // And the raw table syntax should NOT show up as a Line anywhere.
        assert!(!line_texts.iter().any(|l| l.contains("| :---")));
    }

    #[test]
    fn preprocess_lines_passes_through_without_tables() {
        let lines = vec!["# Title", "", "A paragraph.", "- A bullet"];
        let out = preprocess_lines(&lines);
        let line_texts: Vec<&str> = out
            .iter()
            .filter_map(|b| match b {
                DocumentBlock::Line(s) => Some(s.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            line_texts,
            vec!["# Title", "", "A paragraph.", "- A bullet"]
        );
        // No tables → no MonoBlocks
        assert!(!out.iter().any(|b| matches!(b, DocumentBlock::MonoBlock(_))));
    }

    #[test]
    fn wrap_to_width_breaks_on_whitespace() {
        let lines = wrap_to_width("hello world foo bar", 10);
        assert_eq!(lines, vec!["hello", "world foo", "bar"]);
    }

    #[test]
    fn wrap_to_width_hard_wraps_long_words() {
        let lines = wrap_to_width("abcdefghijklmnop short", 5);
        // First three are the long word split at 5-char intervals,
        // then "short" on its own line.
        assert_eq!(lines, vec!["abcde", "fghij", "klmno", "p", "short"]);
    }

    #[test]
    fn pad_right_truncates_when_too_long() {
        assert_eq!(pad_right("abcdef", 3), "abc");
        assert_eq!(pad_right("ab", 5), "ab   ");
        assert_eq!(pad_right("", 3), "   ");
    }

    #[test]
    fn is_table_separator_recognizes_gfm_separators() {
        assert!(is_table_separator("| --- | --- |"));
        assert!(is_table_separator("| :--- | ---: | :---: |"));
        assert!(is_table_separator("|---|---|"));
        assert!(!is_table_separator("| a | b |"));
        assert!(!is_table_separator("abc"));
    }

    #[test]
    fn ascii_fold_for_pdf_drops_unknown() {
        // Characters we don't explicitly handle get dropped rather than
        // leaking mojibake. Emoji, CJK, etc.
        assert_eq!(ascii_fold_for_pdf("hi 🎉 bye"), "hi  bye");
        assert_eq!(ascii_fold_for_pdf("hello 你好"), "hello ");
    }
}
