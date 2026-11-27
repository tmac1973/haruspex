# Phase 02 — Reload watcher

**Depends on:** 01 · **Enables:** live reload in the preview window (03)

## Goal
When a file the preview server has served to a session changes on disk, emit
`preview://changed` to that session's preview window (`preview-<sessionId>`),
debounced, and only when the content actually changed.

## Files touched
- `src-tauri/src/preview/watch.rs` — new: `PreviewWatches`, a newtype around a
  second `fs_tools::editor::EditorWatches` instance whose emit sends
  `preview://changed`.
- `src-tauri/src/fs_tools/editor.rs` — expose what the newtype needs
  (`EditorWatches::new`, `watch`, `unwatch_label`, `disk_hash` as `pub(crate)`);
  no behaviour change for editor windows.
- `src-tauri/src/preview/mod.rs` — attach the `on_served` hook to
  `PreviewWatches::watch`; `preview_stop` calls `unwatch_label`.
- `src-tauri/src/lib.rs` — manage `PreviewWatches`; in `on_window_event`'s
  `Destroyed` branch, for a label starting `preview-`, call `preview_stop`'s
  inner function with the session id after the prefix (this also unwatches).

## Steps
1. `PreviewWatches::new(app)` builds `EditorWatches::new(move |label, _change| app.emit_to(label, "preview://changed", ()))`.
   The event carries no payload: the window reloads the whole page whichever
   file changed.
2. In `preview::PreviewServer`, set `on_served` at managed-state setup: for
   session `id` and absolute `path`, call
   `watches.watch(&format!("preview-{id}"), path, disk_hash(path))`. Watching
   the same path twice is a no-op in `EditorWatches::watch`.
3. Rely on `EditorWatches`' existing debounce and content-hash comparison, so
   an editor's touch-without-change or an atomic rename that leaves the same
   bytes doesn't reload; a deleted file does emit (the page should reload and
   show the 404).
4. `preview_stop` calls `watches.unwatch_label("preview-<id>")` before
   dropping the mapping.
5. Window `Destroyed` for `preview-*` → stop that session's preview (mapping,
   watches, and the listener if it was the last). No `preview-*` window can
   exist until phase 03 adds the prefix, so this branch is covered by a unit
   test calling the stop function here and by phase 03's hand test.

## Build gate
- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test preview editor`
- `npm run check`

## Test plan
- Unit test with a capturing emit closure: serve a file, overwrite it with new
  bytes → one `preview://changed` for that label within the debounce; write the
  same bytes → none; change an unserved file in the same folder → none.
- `preview_stop` then a change → no emit.
- Existing `editor.rs` tests still pass unchanged.

## Commit
`feat(code): reload a preview when a file it served changes`

## Rollback
Revert the commit; phase 01's server keeps working without reloads. The
`editor.rs` visibility changes are harmless to leave.
