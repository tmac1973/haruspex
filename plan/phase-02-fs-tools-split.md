# Phase 02 — `fs_tools.rs` → module tree

**Severity addressed:** 10 · **Effort:** ~1 day · **Risk:** Medium

Resolves complexity-audit C-2 (5 625 LOC monolith).

## Goal

Split `src-tauri/src/fs_tools.rs` (5 625 LOC) into a `src-tauri/src/fs_tools/` module tree organized by file format and concern. **Zero behavioural change** — every Tauri command keeps its name and signature; only the location of the implementation moves.

## Files touched

- **DELETE** `src-tauri/src/fs_tools.rs`
- **NEW** `src-tauri/src/fs_tools/mod.rs` — re-exports + the `fs_*` Tauri commands
- **NEW** `src-tauri/src/fs_tools/path.rs` — `resolve_in_workdir`, `fs_find_available_path`, `fs_list_dir`, `DirListing`, `IMAGE_EXT_RE`
- **NEW** `src-tauri/src/fs_tools/markdown_inline.rs` — `parse_inline_markdown`, `InlineRun`, `StyledWord`, `wrap_styled_words`, `wrap_to_width`, `format_table_as_monoblock`, `MonoLine`
- **NEW** `src-tauri/src/fs_tools/pdf_read.rs` — `fs_read_pdf`, `reconstruct_page_layout`, `ascii_fold_for_pdf`
- **NEW** `src-tauri/src/fs_tools/pdf_write.rs` — `build_pdf` (will be decomposed in Phase 05)
- **NEW** `src-tauri/src/fs_tools/docx.rs` — `build_docx`, `extract_docx_text`, `extract_markdown_image_paths`
- **NEW** `src-tauri/src/fs_tools/odt.rs` — `build_odt`
- **NEW** `src-tauri/src/fs_tools/pptx.rs` — `build_pptx`, `PptxSlide`
- **NEW** `src-tauri/src/fs_tools/odp.rs` — `build_odp`
- **NEW** `src-tauri/src/fs_tools/xlsx.rs` — `build_xlsx`, `build_ods`, `XlsxSheet`, `fs_read_xlsx`, `fs_write_xlsx`
- **NEW** `src-tauri/src/fs_tools/image.rs` — `fs_read_image`, `LoadedImage`, image-loading helpers
- **NEW** `src-tauri/src/fs_tools/download.rs` — `fs_download_url`
- **NEW** `src-tauri/src/fs_tools/text.rs` — `fs_write_text`, `fs_edit_text`, `fs_read_text`
- **EDIT** `src-tauri/src/lib.rs` — module declaration is already `mod fs_tools;`, no change needed.

## Implementation

### Step 1 — create the directory and `mod.rs`

```bash
mkdir -p src-tauri/src/fs_tools
```

```rust
// src-tauri/src/fs_tools/mod.rs
mod download;
mod docx;
mod image;
mod markdown_inline;
mod odp;
mod odt;
mod path;
mod pdf_read;
mod pdf_write;
mod pptx;
mod text;
mod xlsx;

// Re-export the public Tauri commands at the same path lib.rs uses today.
pub use download::fs_download_url;
pub use docx::fs_write_docx;
pub use image::fs_read_image;
pub use odp::fs_write_odp;
pub use odt::fs_write_odt;
pub use path::{fs_find_available_path, fs_list_dir, resolve_in_workdir};
pub use pdf_read::fs_read_pdf;
pub use pdf_write::fs_write_pdf;
pub use pptx::fs_write_pptx;
pub use text::{fs_edit_text, fs_read_text, fs_write_text};
pub use xlsx::{fs_read_xlsx, fs_write_ods, fs_write_xlsx};
```

Verify by grepping `lib.rs`:

```bash
grep -n "fs_tools::" src-tauri/src/lib.rs
```

Each entry there must have a matching `pub use` in `mod.rs`.

### Step 2 — extract one file at a time

For each new module, do this loop:

1. Open `fs_tools.rs` and find the function(s) listed for that module.
2. Cut them into the new file. Add `pub` to anything `mod.rs` re-exports; leave the rest private to the module.
3. Add `use` statements at the top of the new file for any cross-module items (e.g. `use super::path::resolve_in_workdir;`).
4. Run `cargo check --manifest-path src-tauri/Cargo.toml` after every extraction. Fix the errors before moving on.

**Suggested order** — pull leaf utilities first so later modules can import them:

1. `path.rs` (no internal deps)
2. `image.rs` (uses path)
3. `markdown_inline.rs` (no internal deps)
4. `text.rs` (uses path)
5. `pdf_read.rs` (uses path)
6. `download.rs` (uses path)
7. `xlsx.rs` (uses path)
8. `docx.rs` (uses path, image, markdown_inline)
9. `odt.rs` (uses path, image, markdown_inline)
10. `pptx.rs` (uses path, image, markdown_inline)
11. `odp.rs` (uses path, image, markdown_inline)
12. `pdf_write.rs` (uses path, image, markdown_inline)

### Step 3 — delete the original `fs_tools.rs`

Once `fs_tools.rs` is empty (or contains only the `mod.rs` content already moved), delete it.

```bash
rm src-tauri/src/fs_tools.rs
```

Confirm `cargo check` passes.

### Step 4 — fix any pub visibility issues

Some helpers were previously private to `fs_tools.rs` and free to use anywhere in the file. After the split, callers in sibling modules need `pub(crate)` or `pub(super)`. `cargo check` will surface every one of these — fix them by **widening visibility minimally** (`pub(super)` first, `pub(crate)` if the symbol crosses module boundaries).

## Build gate

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri dev   # full app build
```

## Test plan

Goal: every `fs_*` Tauri command still works end-to-end.

### Smoke

1. App launches.
2. Set a working directory (use the **working-dir** button in the chat UI).

### Targeted

Paste each of these into the chat. Replace `<workdir>` references mentally with the directory you set.

### Agent prompts

3. **fs_list_dir + fs_read_text**
   > Show me the file listing of my working directory, then read the first text file you find.

4. **fs_write_text**
   > Create a file called `note.txt` with the contents "phase-02 smoke test" in my working directory.
   - Verify on disk: `cat <workdir>/note.txt`.

5. **fs_write_pdf**
   > Create a one-page PDF called `report.pdf` with a heading "Hello", a paragraph, and a bullet list of three items.
   - Open it in a PDF viewer; verify all three elements render.

6. **fs_write_docx + fs_write_odt**
   > Create both `report.docx` and `report.odt` with a heading "Test", one paragraph, and one bold word.
   - Open both in LibreOffice; verify they render.

7. **fs_write_xlsx + fs_write_ods**
   > Create a spreadsheet `data.xlsx` with two sheets — "Sheet A" containing `[["x","y"],["1","2"]]`, "Sheet B" containing `[["a"],["b"]]`. Then make the same content as `data.ods`.
   - Open both; verify two sheets in each.

8. **fs_write_pptx + fs_write_odp**
   > Create a two-slide presentation `deck.pptx` — slide 1 says "Phase 02", slide 2 says "fs_tools split". Do the same as `deck.odp`.
   - Open both; verify two slides each.

9. **fs_read_pdf** (use the `report.pdf` from step 5)
   > Read `report.pdf` back to me and summarize it.
   - The model should describe the heading, paragraph, and bullets it just wrote.

10. **fs_read_image + fs_read_xlsx**
    - Save any PNG to your workdir as `pic.png`.
    > Look at `pic.png` and describe what you see. Then read `data.xlsx` and tell me what's in Sheet B.

11. **fs_download_url**
    > Download https://example.com/index.html and save it to my workdir as `example.html`.
    - Verify the file exists on disk.

12. **fs_edit_text**
    > In `note.txt`, replace "smoke test" with "passed".
    - `cat <workdir>/note.txt` shows the edit.

If all twelve pass, commit:

```
refactor: split fs_tools.rs into per-format module tree (#TBD)

5 625 LOC monolith split into src-tauri/src/fs_tools/{path,
image, markdown_inline, text, pdf_read, pdf_write, docx, odt,
pptx, odp, xlsx, download}.rs. No behavioural change; every
fs_* Tauri command keeps its name and signature.

Resolves audits/code-complexity-2026-05-14.md C-2.
```

## Roll-back rule

If any test from 3–12 produces a different result than before this phase, revert the entire phase and split into two PRs — one moving the leaf modules (path, image, markdown_inline, text, pdf_read, download, xlsx), one moving the heavier doc builders.
