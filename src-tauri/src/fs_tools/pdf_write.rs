//! PDF generation via `printpdf`. Markdown-shaped input is preprocessed
//! by `super::markdown_inline` (headings, tables, inline emphasis) and
//! images are loaded by `super::images`. The renderer flows pages
//! automatically and folds non-ASCII characters to ASCII so the built-in
//! Helvetica font's WinAnsi encoding doesn't mojibake.

use super::images::{load_markdown_images, LoadedImage};
use super::markdown_inline::{
    ascii_fold_for_pdf, is_horizontal_rule, normalize_list_marker, parse_inline_markdown,
    preprocess_lines, runs_to_words, wrap_styled_words, DocumentBlock, ImageAlignment, InlineRun,
};
use super::path::{
    refuse_if_exists, resolve_in_workdir, workdir_path, write_bytes_to_workdir, MAX_WRITE_BYTES,
};
use std::collections::HashMap;

/// Font family selector — Helvetica for normal prose, Courier for
/// monospace tables where column alignment via space padding matters.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum FontFamily {
    Helvetica,
    Courier,
}

/// Approximate character width in points for Helvetica at given size.
/// Used for line-fit estimates during word wrap.
fn char_width_pt(font_pt: f32) -> f32 {
    font_pt * 0.55
}

/// Classify a raw line into (rendered_text, font_size_pt, leading_pt,
/// is_heading). Headings get larger sizes and looser leading; body
/// lines get standard.
fn classify(line: &str, h1: f32, h2: f32, h3: f32, body: f32) -> (String, f32, f32, bool) {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix("# ") {
        (rest.to_string(), h1, h1 * 0.5, true)
    } else if let Some(rest) = trimmed.strip_prefix("## ") {
        (rest.to_string(), h2, h2 * 0.5, true)
    } else if let Some(rest) = trimmed.strip_prefix("### ") {
        (rest.to_string(), h3, h3 * 0.5, true)
    } else {
        (line.to_string(), body, body * 0.4, false)
    }
}

fn pick_font(family: FontFamily, bold: bool, italic: bool) -> printpdf::BuiltinFont {
    use printpdf::BuiltinFont::*;
    match (family, bold, italic) {
        (FontFamily::Helvetica, true, true) => HelveticaBoldOblique,
        (FontFamily::Helvetica, true, false) => HelveticaBold,
        (FontFamily::Helvetica, false, true) => HelveticaOblique,
        (FontFamily::Helvetica, false, false) => Helvetica,
        (FontFamily::Courier, true, true) => CourierBoldOblique,
        (FontFamily::Courier, true, false) => CourierBold,
        (FontFamily::Courier, false, true) => CourierOblique,
        (FontFamily::Courier, false, false) => Courier,
    }
}

/// Emit page-start ops. `Op::SetTextCursor` serializes to the PDF
/// `Td` operator which is RELATIVE, so we can't use it for absolute
/// positioning. `Op::SetTextMatrix(Translate(x, y))` serializes to
/// `Tm` which is absolute in page coordinates (origin at bottom-left).
fn start_page_ops(ops: &mut Vec<printpdf::Op>) {
    use printpdf::*;
    ops.push(Op::SaveGraphicsState);
    ops.push(Op::StartTextSection);
    // Black fill so text is visible (default is actually black but be explicit).
    ops.push(Op::SetFillColor {
        col: Color::Rgb(Rgb {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            icc_profile: None,
        }),
    });
}

fn finish_page_ops(ops: &mut Vec<printpdf::Op>) {
    use printpdf::*;
    ops.push(Op::EndTextSection);
    ops.push(Op::RestoreGraphicsState);
}

/// Register each unique referenced image with the PDF document once
/// up front. Returns a map keyed by the workdir-relative path so the
/// rendering loop can look up the document's XObjectId and natural
/// pixel dimensions when it embeds an image.
fn register_images(
    doc: &mut printpdf::PdfDocument,
    images: &HashMap<String, LoadedImage>,
) -> Result<HashMap<String, (printpdf::XObjectId, u32, u32)>, String> {
    use printpdf::*;
    let mut registered: HashMap<String, (XObjectId, u32, u32)> = HashMap::new();
    for (path, img) in images {
        let mut warnings = Vec::new();
        let raw = RawImage::decode_from_bytes(&img.bytes, &mut warnings)
            .map_err(|e| format!("Failed to decode image {}: {}", path, e))?;
        let (w, h) = (raw.width as u32, raw.height as u32);
        let id = doc.add_image(&raw);
        registered.insert(path.clone(), (id, w, h));
    }
    Ok(registered)
}

/// Build a simple PDF from markdown-ish text. Supports:
///   - `#`, `##`, `###` headings (rendered bold, larger)
///   - `**bold**`, `*italic*`, `` `code` ``, `[text](url)` inline markdown
///   - `-` / `*` / `+` bullet lists (converted to `•`)
///   - `![alt](path)` on a line by itself — embeds the referenced image
///     pre-loaded into `images` (paths point into the workdir).
///
/// Content is word-wrapped to fit the page and flows across multiple pages.
pub(super) fn build_pdf(
    lines: &[&str],
    images: &std::collections::HashMap<String, LoadedImage>,
) -> Result<Vec<u8>, String> {
    use printpdf::*;

    let mut doc = PdfDocument::new("Document");
    let registered_images = register_images(&mut doc, images)?;

    // US Letter: 215.9 mm × 279.4 mm. Keep a 20 mm margin on all sides.
    let page_width_mm = 215.9_f32;
    let page_height_mm = 279.4_f32;
    let margin_mm = 20.0_f32;
    let content_width_mm = page_width_mm - (margin_mm * 2.0);

    // Font sizes (points)
    let body_pt = 11.0_f32;
    let h1_pt = 20.0_f32;
    let h2_pt = 16.0_f32;
    let h3_pt = 13.0_f32;

    // Convert mm to Pt (1 mm ≈ 2.8346 pt)
    let mm_to_pt = 2.834_645_7_f32;
    let content_width_pt = content_width_mm * mm_to_pt;

    let top_y_mm = page_height_mm - margin_mm;
    let bottom_y_mm = margin_mm;
    let margin_pt = margin_mm * mm_to_pt;

    let mut all_pages: Vec<PdfPage> = Vec::new();
    let mut current_ops: Vec<Op> = Vec::new();
    let mut cursor_y_mm = top_y_mm;

    start_page_ops(&mut current_ops);

    // (font_pt, family, bold, italic) — tracks the last SetFont op so we
    // can avoid re-emitting it when the next run has the same style.
    let mut last_font: Option<(u32, FontFamily, bool, bool)> = None;

    // Preprocess: split the input into DocumentBlocks. Markdown tables
    // become MonoBlocks (aligned monospace), everything else becomes Line.
    let preprocessed = preprocess_lines(lines);

    // Helper that emits a page break at the current cursor position. Used
    // when a line won't fit in the remaining vertical space. Horizontal
    // rules (`---`) are NOT treated as page breaks — they're skipped
    // entirely, since in markdown they're typically section dividers, and
    // forcing a page break on every divider produced too many pages.
    let page_break = |current_ops: &mut Vec<Op>,
                      all_pages: &mut Vec<PdfPage>,
                      cursor_y_mm: &mut f32,
                      last_font: &mut Option<(u32, FontFamily, bool, bool)>| {
        finish_page_ops(current_ops);
        all_pages.push(PdfPage::new(
            Mm(page_width_mm),
            Mm(page_height_mm),
            std::mem::take(current_ops),
        ));
        *cursor_y_mm = top_y_mm;
        start_page_ops(current_ops);
        *last_font = None;
    };

    for block in &preprocessed {
        match block {
            DocumentBlock::Line(line) => {
                if line.trim().is_empty() {
                    cursor_y_mm -= 4.0;
                    continue;
                }

                // Horizontal rules (`---`, `***`, `___`) are treated as
                // visual section dividers with a bit of extra spacing — NOT
                // page breaks. The previous `--- = page break` rule pushed
                // every divider to a new page, which generated 5–10 page
                // breaks in a single report.
                if is_horizontal_rule(line) {
                    cursor_y_mm -= 4.0;
                    continue;
                }

                // Fold Unicode to ASCII before anything else sees the line
                // so the PDF only ever contains ASCII bytes (sidesteps the
                // lopdf WinAnsi bug documented in `ascii_fold_for_pdf`).
                let folded = ascii_fold_for_pdf(line);

                let (text_after_heading, font_pt, spacing_after_pt, is_heading) =
                    classify(&folded, h1_pt, h2_pt, h3_pt, body_pt);

                // Always run inline parsing, even for headings. Models
                // routinely emit `### **Section Title**` — if we skipped
                // inline parsing inside headings the literal `**` would
                // end up rendered in the PDF. Force `bold = true` on every
                // resulting run so the heading stays visually bold
                // regardless of its markdown shape.
                let runs = if is_heading {
                    let mut parsed = parse_inline_markdown(&text_after_heading);
                    if parsed.is_empty() {
                        parsed.push(InlineRun {
                            text: text_after_heading,
                            bold: true,
                            italic: false,
                        });
                    } else {
                        for run in &mut parsed {
                            run.bold = true;
                        }
                    }
                    parsed
                } else {
                    let normalized = normalize_list_marker(&text_after_heading);
                    parse_inline_markdown(&normalized)
                };

                let words = runs_to_words(&runs);
                if words.is_empty() {
                    cursor_y_mm -= spacing_after_pt / mm_to_pt;
                    continue;
                }

                let max_chars =
                    ((content_width_pt / char_width_pt(font_pt)).floor() as usize).max(1);
                let wrapped_lines = wrap_styled_words(&words, max_chars);
                let line_height_mm = (font_pt * 1.2) / mm_to_pt;
                let font_pt_key = font_pt.to_bits();

                for wrapped_line in wrapped_lines {
                    if cursor_y_mm - line_height_mm < bottom_y_mm {
                        page_break(
                            &mut current_ops,
                            &mut all_pages,
                            &mut cursor_y_mm,
                            &mut last_font,
                        );
                    }

                    let baseline_pt = (cursor_y_mm - line_height_mm) * mm_to_pt + (font_pt * 0.2);
                    current_ops.push(Op::SetTextMatrix {
                        matrix: TextMatrix::Translate(Pt(margin_pt), Pt(baseline_pt)),
                    });

                    for (idx, sw) in wrapped_line.iter().enumerate() {
                        let bold = sw.bold;
                        let italic = sw.italic;
                        let key = (font_pt_key, FontFamily::Helvetica, bold, italic);
                        if last_font != Some(key) {
                            let font = pick_font(FontFamily::Helvetica, bold, italic);
                            current_ops.push(Op::SetFont {
                                font: PdfFontHandle::Builtin(font),
                                size: Pt(font_pt),
                            });
                            current_ops.push(Op::SetLineHeight {
                                lh: Pt(font_pt * 1.2),
                            });
                            last_font = Some(key);
                        }

                        let piece = if idx == 0 {
                            sw.word.clone()
                        } else {
                            format!(" {}", sw.word)
                        };
                        current_ops.push(Op::ShowText {
                            items: vec![TextItem::Text(piece)],
                        });
                    }

                    cursor_y_mm -= line_height_mm;
                }

                cursor_y_mm -= spacing_after_pt / mm_to_pt;
            }

            DocumentBlock::MonoBlock(mono_lines) => {
                // Tables render as pre-aligned monospace lines in Courier.
                // The line text already contains exact column padding from
                // `format_table_as_monoblock`, so we emit each line as one
                // ShowText op at the correct baseline with no inline parsing
                // or wrapping.
                let font_pt = body_pt;
                let line_height_mm = (font_pt * 1.2) / mm_to_pt;
                let font_pt_key = font_pt.to_bits();

                // Small visual gap before the table.
                cursor_y_mm -= 2.0;

                for mono in mono_lines {
                    if cursor_y_mm - line_height_mm < bottom_y_mm {
                        page_break(
                            &mut current_ops,
                            &mut all_pages,
                            &mut cursor_y_mm,
                            &mut last_font,
                        );
                    }

                    let bold = mono.bold;
                    let key = (font_pt_key, FontFamily::Courier, bold, false);
                    if last_font != Some(key) {
                        let font = pick_font(FontFamily::Courier, bold, false);
                        current_ops.push(Op::SetFont {
                            font: PdfFontHandle::Builtin(font),
                            size: Pt(font_pt),
                        });
                        current_ops.push(Op::SetLineHeight {
                            lh: Pt(font_pt * 1.2),
                        });
                        last_font = Some(key);
                    }

                    let baseline_pt = (cursor_y_mm - line_height_mm) * mm_to_pt + (font_pt * 0.2);
                    current_ops.push(Op::SetTextMatrix {
                        matrix: TextMatrix::Translate(Pt(margin_pt), Pt(baseline_pt)),
                    });

                    // Fold non-ASCII (same WinAnsi bug defense as Line path).
                    let text = ascii_fold_for_pdf(&mono.text);
                    current_ops.push(Op::ShowText {
                        items: vec![TextItem::Text(text)],
                    });

                    cursor_y_mm -= line_height_mm;
                }

                // Small visual gap after the table.
                cursor_y_mm -= 3.0;
            }
            DocumentBlock::Image(path, opts) => {
                // Look up the pre-registered image. If it's missing (loading
                // failed earlier or the model referenced a path we didn't
                // load), render a one-line italic placeholder so the
                // document still flows.
                let Some(&(ref image_id, px_w, px_h)) = registered_images.get(path) else {
                    let line_height_mm = (body_pt * 1.2) / mm_to_pt;
                    if cursor_y_mm - line_height_mm < bottom_y_mm {
                        page_break(
                            &mut current_ops,
                            &mut all_pages,
                            &mut cursor_y_mm,
                            &mut last_font,
                        );
                    }
                    let font_pt_key = body_pt.to_bits();
                    let key = (font_pt_key, FontFamily::Helvetica, false, true);
                    if last_font != Some(key) {
                        current_ops.push(Op::SetFont {
                            font: PdfFontHandle::Builtin(pick_font(
                                FontFamily::Helvetica,
                                false,
                                true,
                            )),
                            size: Pt(body_pt),
                        });
                        last_font = Some(key);
                    }
                    let baseline_pt = (cursor_y_mm - line_height_mm) * mm_to_pt + (body_pt * 0.2);
                    current_ops.push(Op::SetTextMatrix {
                        matrix: TextMatrix::Translate(Pt(margin_pt), Pt(baseline_pt)),
                    });
                    let placeholder = format!("[image: {}]", path);
                    current_ops.push(Op::ShowText {
                        items: vec![TextItem::Text(ascii_fold_for_pdf(&placeholder))],
                    });
                    cursor_y_mm -= line_height_mm;
                    continue;
                };

                // Compute display size in points. Treat the bitmap's native
                // pixel size as 96 dpi (a reasonable default for screenshots
                // and matplotlib output). If the user specified width%, that
                // becomes a fraction of the content width; otherwise fit
                // to content width on overflow. Aspect ratio is preserved.
                let dpi = 96.0_f32;
                let natural_w_pt = (px_w as f32) * (72.0 / dpi);
                let natural_h_pt = (px_h as f32) * (72.0 / dpi);
                let (display_w_pt, display_h_pt) = match opts.width_fraction {
                    Some(frac) => {
                        let w = content_width_pt * frac;
                        let h = if natural_w_pt > 0.0 {
                            natural_h_pt * (w / natural_w_pt)
                        } else {
                            natural_h_pt
                        };
                        (w, h)
                    }
                    None => {
                        let scale = (content_width_pt / natural_w_pt).min(1.0);
                        (natural_w_pt * scale, natural_h_pt * scale)
                    }
                };
                let display_h_mm = display_h_pt / mm_to_pt;
                let translate_x_pt = match opts.alignment {
                    ImageAlignment::Left => margin_pt,
                    ImageAlignment::Center => margin_pt + (content_width_pt - display_w_pt) / 2.0,
                    ImageAlignment::Right => margin_pt + (content_width_pt - display_w_pt),
                };

                // Force a page break if the image won't fit in the remaining
                // vertical space. Don't try to shrink past natural size to fit
                // — the page break preserves intent better than a tiny image.
                if cursor_y_mm - display_h_mm < bottom_y_mm {
                    page_break(
                        &mut current_ops,
                        &mut all_pages,
                        &mut cursor_y_mm,
                        &mut last_font,
                    );
                }

                // Small vertical gap above the image so it doesn't kiss the
                // line of text immediately above.
                cursor_y_mm -= 2.0;

                let y_baseline_pt = (cursor_y_mm - display_h_mm) * mm_to_pt;

                // printpdf draws raster XObjects outside the text section. We
                // close the section, emit the image op, then reopen it so the
                // following text blocks render correctly. SetFont state is
                // section-scoped, so reset our tracker.
                current_ops.push(Op::EndTextSection);
                // printpdf 0.9 applies a baseline px-to-pt transform at
                // `dpi` *first*, then multiplies by `scale_x`/`scale_y`.
                // With dpi=None (default 300), 1 px = 0.24 pt up front;
                // a "scale 0.5" then meant "half of natural-at-300dpi",
                // not "half of an inch worth of pixels". We tell printpdf
                // to treat the bitmap as 96 dpi (a screenshot/matplotlib
                // assumption that lines up with `natural_w_pt` below) and
                // pass `scale_x` as the fraction of *that* baseline we
                // want. The two together produce display_w_pt exactly.
                current_ops.push(Op::UseXobject {
                    id: image_id.clone(),
                    transform: XObjectTransform {
                        translate_x: Some(Pt(translate_x_pt)),
                        translate_y: Some(Pt(y_baseline_pt)),
                        rotate: None,
                        scale_x: Some(display_w_pt / natural_w_pt),
                        scale_y: Some(display_h_pt / natural_h_pt),
                        dpi: Some(dpi),
                    },
                });
                current_ops.push(Op::StartTextSection);
                last_font = None;

                cursor_y_mm -= display_h_mm;
                cursor_y_mm -= 3.0;
            }
        }
    }

    finish_page_ops(&mut current_ops);
    all_pages.push(PdfPage::new(
        Mm(page_width_mm),
        Mm(page_height_mm),
        current_ops,
    ));

    let bytes = doc
        .with_pages(all_pages)
        .save(&PdfSaveOptions::default(), &mut Vec::new());

    Ok(bytes)
}

#[tauri::command]
pub async fn fs_write_pdf(
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

    // Pre-load every `![alt](path)` image while we still have async runtime
    // access. build_pdf itself does no I/O.
    let images = load_markdown_images(&workdir, &content)?;

    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let lines: Vec<&str> = content.lines().collect();
        build_pdf(&lines, &images)
    })
    .await
    .map_err(|e| format!("PDF build task failed: {}", e))??;

    write_bytes_to_workdir(&resolved, &bytes).await
}
