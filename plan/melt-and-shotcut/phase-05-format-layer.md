# Phase 05 — A format-neutral project layer (Kdenlive only)

**Depends on:** nothing · **Enables:** 06 and 07 (Shotcut reading and writing
plug into it)

## Goal

Put the format-neutral parts of `video/kdenlive/` behind a `ProjectDoc` enum
with one variant, `Kdenlive`. Everything outside the format modules calls
`ProjectDoc` instead of `kdenlive::`. This is a pure refactor: no behaviour
changes, and every existing test passes unchanged except for the import
paths. That's what lets Shotcut be added as a second variant without changing how
those files call into a project. Phase 08 still edits `project.rs`, but only
to find `.mlt` files and choose the editor.

## Files touched

- `src-tauri/src/video/mlt/mod.rs` (new) → `pub mod xml; pub mod fps;` plus
  `mlt_path` (moved from `kdenlive/mod.rs`), which works for any MLT XML.
- `src-tauri/src/video/mlt/xml.rs` ← moved from `kdenlive/xml.rs` unchanged
  (`Tree`, `Node`, `Splices`, `escape`).
- `src-tauri/src/video/mlt/fps.rs` ← `Fps` and its methods, moved out of
  `kdenlive/doc.rs`.
- `src-tauri/src/video/timeline.rs` (new) ← the neutral types: `Media`,
  `Source`, `Placement`, `Edited` (from `kdenlive/edit.rs`), plus `Span`,
  `source_at`, `Line` and `lines` (from `kdenlive/timeline_map.rs`, which
  keeps only its Kdenlive `spans`).
- `src-tauri/src/video/format.rs` (new) → `pub enum Format { Kdenlive }`,
  deriving `Serialize`, `Deserialize` (`rename_all = "lowercase"`) and
  `ts_rs::TS` with `#[ts(export)]`, with `extension()` and `from_path()`, and `pub enum ProjectDoc {
  Kdenlive(kdenlive::doc::Doc) }` with `open`, `template`, `set_profile`,
  `current`, `apply`, `save`, `summary`, `spans`, `fps`, `editable`. Each is a
  one-arm `match` into `kdenlive::`.
- `src-tauri/src/video/kdenlive/*.rs` → import the moved types from
  `video::mlt` and `video::timeline`.
- `src-tauri/src/video/kdenlive/mod.rs` → `ProjectSummary` moves to
  `format.rs`. Its `kdenlive_version: String` becomes `editor: Format` plus
  `editor_version: String`.
- `src-tauri/src/video/project.rs`, `tasks.rs`, `commands.rs`,
  `transcribe.rs`, `subtitles.rs` → call `ProjectDoc` / `format::` instead
  of `kdenlive::`. `kdenlive_files` becomes `project_files(dir)` and still
  matches only `.kdenlive` (phase 08 adds `.mlt`).
- `src/lib/ipc/gen/ProjectSummary.ts`, `Format.ts` → regenerated.
- `src/lib/video/report.ts`, `src/lib/agent/tools/video.ts` → read
  `summary.editor` / `summary.editorVersion` instead of `kdenliveVersion`.
  The text the model sees is unchanged in this phase.

## Steps

1. Move `xml.rs` and `Fps` with `git mv`, so history follows the files, then
   fix the imports.
2. Move the neutral types into `timeline.rs`. `Media.file_hash` stays: both
   formats record a hash.
3. Add `format.rs` and route callers through it one file at a time, running
   `cargo test video::` after each.
4. Rename the summary field in Rust, run `./scripts/export-ipc-types.sh`, and
   fix the TypeScript.
5. `rg 'kdenlive::' src-tauri/src --glob '!video/kdenlive/**' --glob
   '!video/format.rs'` must come back empty.

## Build gate

- `cargo fmt -- --check`, `cargo clippy -- -D warnings`, `cargo test`.
- `./scripts/export-ipc-types.sh` with no diff afterwards.
- `npm run check`, `npm run lint`, `npm run test`.

## Test plan

- The whole existing `video::` suite passes. The Kdenlive fixtures and the
  real render test in `tasks.rs` are the regression net.
- `rg` check from step 5.
- One manual cut and render in the dev app against a `.kdenlive`, opened in
  Kdenlive afterwards, to confirm nothing changed.

## Commit

`refactor(video): put kdenlive behind a format-neutral project layer`

## Rollback

Revert the commit and regenerate the IPC types. It's a pure move, so it's
safe to revert as long as phases 06–08 aren't on top of it.
