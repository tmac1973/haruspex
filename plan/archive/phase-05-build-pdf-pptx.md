# Phase 05 — `build_pdf` + `build_pptx` decomposition

**Severity addressed:** 8 · **Effort:** ~4 hours · **Risk:** Medium

Resolves complexity-audit C-7 (`build_pdf` 441 LOC, depth 8) and C-8 (`build_pptx` 507 LOC, depth 8).

**Prerequisite:** Phase 02 complete — the doc builders now live in their own modules (`fs_tools/pdf_write.rs`, `fs_tools/pptx.rs`).

## Goal

Carve `build_pdf` and `build_pptx` (and opportunistically `build_odp`) into smaller, testable functions. Behaviour is byte-identical — the generated PDF/PPTX bytes must match what the pre-refactor builder produced for the same input.

## Files touched

- **EDIT** `src-tauri/src/fs_tools/pdf_write.rs`
- **EDIT** `src-tauri/src/fs_tools/pptx.rs`
- **EDIT (optional)** `src-tauri/src/fs_tools/odp.rs`

## Implementation

### Step 1 — `pdf_write.rs` decomposition

Goal: `build_pdf` ≤ 60 LOC; layout math in a struct.

```rust
// fs_tools/pdf_write.rs (sketch)
use printpdf::*;
use std::collections::HashMap;

// Existing types stay where they are.

const PAGE_WIDTH_MM: f32 = 215.9;
const PAGE_HEIGHT_MM: f32 = 279.4;
const MARGIN_MM: f32 = 20.0;
const CONTENT_WIDTH_MM: f32 = PAGE_WIDTH_MM - (MARGIN_MM * 2.0);

struct PdfLayout {
    cursor_y_mm: f32,
    page: PdfPage,
    ops: Vec<Op>,
}

impl PdfLayout {
    fn new() -> Self { /* … */ }
    fn ensure_space(&mut self, doc: &mut PdfDocument, needed_mm: f32) { /* … */ }
    fn write_text_line(&mut self, doc: &mut PdfDocument, words: &[StyledWord]) { /* … */ }
    fn write_image(&mut self, doc: &mut PdfDocument, img: &LoadedImage, registered: &HashMap<String, (XObjectId, u32, u32)>) { /* … */ }
    fn finalize(self, doc: &mut PdfDocument) { /* push remaining page */ }
}

fn register_images(doc: &mut PdfDocument, images: &HashMap<String, LoadedImage>)
    -> Result<HashMap<String, (XObjectId, u32, u32)>, String> { /* … */ }

pub fn build_pdf(lines: &[&str], images: &HashMap<String, LoadedImage>) -> Result<Vec<u8>, String> {
    let mut doc = PdfDocument::new("Document");
    let registered = register_images(&mut doc, images)?;
    let mut layout = PdfLayout::new();
    for raw in lines {
        match classify_line(raw) {
            LineKind::Heading(level, text) => layout.write_heading(&mut doc, level, &text),
            LineKind::Image(path) => layout.write_image(&mut doc, &images[&path], &registered),
            LineKind::Paragraph(runs) => layout.write_paragraph(&mut doc, &runs),
            LineKind::Bullet(runs) => layout.write_bullet(&mut doc, &runs),
            LineKind::Blank => layout.skip(BLANK_LINE_MM),
        }
    }
    layout.finalize(&mut doc);
    doc.save_to_bytes().map_err(|e| format!("PDF save failed: {e}"))
}

enum LineKind {
    Heading(u8, String),
    Image(String),
    Paragraph(Vec<InlineRun>),
    Bullet(Vec<InlineRun>),
    Blank,
}

fn classify_line(raw: &str) -> LineKind { /* heading detection, bullet detection, image detection */ }
```

Move existing helpers (`wrap_styled_words`, `wrap_to_width`, `format_table_as_monoblock`, `ascii_fold_for_pdf` if PDF-write-specific) into pdf_write.rs from `markdown_inline.rs` if and only if they're not used elsewhere. Re-check with `grep -rn "wrap_styled_words" src-tauri/src/`.

### Step 2 — `pptx.rs` decomposition

```rust
// fs_tools/pptx.rs (sketch)
use std::collections::{BTreeSet, HashMap};
use std::io::Cursor;
use zip::write::{SimpleFileOptions, ZipWriter};

fn assign_image_indices(slides: &[PptxSlide]) -> HashMap<&String, usize> { /* … */ }
fn collect_extensions<'a>(indices: &HashMap<&String, usize>, images: &'a HashMap<String, LoadedImage>) -> BTreeSet<&'a str> { /* … */ }

fn write_content_types(zip: &mut ZipWriter<Cursor<&mut Vec<u8>>>, exts: &BTreeSet<&str>, slide_count: usize) -> Result<(), String> { /* … */ }
fn write_root_rels(zip: &mut ZipWriter<Cursor<&mut Vec<u8>>>) -> Result<(), String> { /* … */ }
fn write_presentation_xml(zip: &mut ZipWriter<Cursor<&mut Vec<u8>>>, slide_count: usize) -> Result<(), String> { /* … */ }
fn write_slide(zip: &mut ZipWriter<Cursor<&mut Vec<u8>>>, idx: usize, slide: &PptxSlide, image_idx: Option<usize>) -> Result<(), String> { /* … */ }
fn write_slide_rels(zip: &mut ZipWriter<Cursor<&mut Vec<u8>>>, idx: usize, has_image: bool) -> Result<(), String> { /* … */ }
fn write_theme(zip: &mut ZipWriter<Cursor<&mut Vec<u8>>>) -> Result<(), String> { /* … */ }
fn write_slide_layout(zip: &mut ZipWriter<Cursor<&mut Vec<u8>>>) -> Result<(), String> { /* … */ }
fn write_slide_master(zip: &mut ZipWriter<Cursor<&mut Vec<u8>>>) -> Result<(), String> { /* … */ }
fn write_media(zip: &mut ZipWriter<Cursor<&mut Vec<u8>>>, idx: usize, path: &str, img: &LoadedImage) -> Result<(), String> { /* … */ }

pub fn build_pptx(slides: &[PptxSlide], images: &HashMap<String, LoadedImage>) -> Result<Vec<u8>, String> {
    if slides.is_empty() { return Err("At least one slide is required".to_string()); }
    let image_index = assign_image_indices(slides);
    let unique_exts = collect_extensions(&image_index, images);

    let mut buf = Vec::new();
    {
        let mut zip = ZipWriter::new(Cursor::new(&mut buf));
        write_content_types(&mut zip, &unique_exts, slides.len())?;
        write_root_rels(&mut zip)?;
        write_presentation_xml(&mut zip, slides.len())?;
        for (i, slide) in slides.iter().enumerate() {
            let idx = i + 1;
            let img_idx = slide.image.as_ref().and_then(|p| image_index.get(p).copied());
            write_slide(&mut zip, idx, slide, img_idx)?;
            write_slide_rels(&mut zip, idx, slide.image.is_some())?;
        }
        write_theme(&mut zip)?;
        write_slide_layout(&mut zip)?;
        write_slide_master(&mut zip)?;
        for (path, idx) in &image_index {
            if let Some(img) = images.get(*path) {
                write_media(&mut zip, *idx, path, img)?;
            }
        }
        zip.finish().map_err(|e| format!("ZIP finalize failed: {e}"))?;
    }
    Ok(buf)
}
```

### Step 3 — byte-identical regression check

Before starting the refactor, generate a reference PDF and PPTX using the **current** code. Save these as fixtures.

```bash
# In the running app, with a working dir set:
# Prompt: "Create report.pdf with a heading 'Test', a paragraph with **bold** text, a bullet list with three items, and an image."
# After it writes:
cp <workdir>/report.pdf /tmp/phase05-reference.pdf
# Prompt: "Create deck.pptx with two slides, each with a heading and one bullet."
cp <workdir>/deck.pptx /tmp/phase05-reference.pptx
```

After refactoring, generate the same fixtures with the same input and diff:

```bash
# Bytes won't match exactly because of timestamps in OPC metadata.
# Use file-content comparison instead:
diff <(pdftotext /tmp/phase05-reference.pdf -) <(pdftotext <workdir>/report.pdf -)
unzip -p /tmp/phase05-reference.pptx ppt/slides/slide1.xml > /tmp/ref-slide1.xml
unzip -p <workdir>/deck.pptx ppt/slides/slide1.xml > /tmp/new-slide1.xml
diff /tmp/ref-slide1.xml /tmp/new-slide1.xml
```

PDF text content must match. PPTX slide XML diff should be empty (or limited to insignificant whitespace).

## Build gate

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## Test plan

### Smoke

1. App launches; sidecar status `ready`.

### Targeted — PDF

2. Set a working directory.
3. *"Create a PDF `simple.pdf` with one heading 'Hi' and one paragraph 'world'."*
   - Open: heading and paragraph both render.
4. *"Create `complex.pdf` with: heading 'Section 1', a paragraph that contains **bold** and *italic* text, a bullet list of 4 items, then heading 'Section 2', then embed an image (use any image you have access to or describe one). Make it long enough to span 2 pages if possible."*
   - Open: bold/italic preserved, bullets render, image positioned correctly, page break occurs naturally.
5. Run the regression `pdftotext` diff from Step 3 above.

### Targeted — PPTX

6. *"Create `slides.pptx` with three slides: slide 1 is a title 'Phase 05', slide 2 has a bullet list of 3 items, slide 3 embeds an image."*
   - Open in LibreOffice Impress; verify all three slides render correctly and the image appears on slide 3.
7. Run the `unzip -p` XML diff from Step 3.

### Targeted — ODP (if you tackle it in this phase)

8. *"Create `slides.odp` with the same content as slides.pptx."*
   - Verify in LibreOffice Impress.

If all pass, commit:

```
refactor: decompose build_pdf and build_pptx (#TBD)

build_pdf split into PdfLayout struct + per-element methods +
classify_line(). build_pptx split into per-OPC-part write_*
functions. No behavioural change — generated files are
byte-equivalent for the same input (modulo OPC timestamps).

Resolves audits/code-complexity-2026-05-14.md C-7, C-8.
```

## Roll-back rule

If the regression diffs in Step 3 show meaningful content differences (not just whitespace / timestamps), revert. Re-attempt one builder at a time in separate PRs.
