# Phase 6b — Editor windows

**Depends on:** 6 · **Guide:** `code.md` (Edit files), `shortcuts.md`
(Editor windows)

## Goal

The user asked: "Can we make the editor be detached from the main window, and
autoload changes to the file, and have multiple editors open at the same
time?" Phase 6 opened files from the Code tab in the Jobs review modal, which
covers the window, shows one set of files at a time and never notices the
agent changing a file underneath.

## Decisions (settled 2026-10-08)

- **One editor window per project folder, with file tabs.** Opening a file
  adds a tab to that folder's window, or focuses its tab if it is already
  open, and raises the window. A new folder gets a new window. A tab action,
  "Move to new window", splits one file into its own window.
- **Only the Code tab uses windows:** `open_in_editor`, clickable paths in the
  transcript, and the file names on diffs.
- **The Jobs guided-planning checkpoint keeps its modal.** `editWorkdirFiles`
  → `FileEditorModal` waits for the user to finish, which a window can't.
- **Auto-reload with file watching** (`notify`: inotify / FSEvents), every
  file open in any editor window:
  - changes are debounced, and compared by content hash so the editor's own
    saves don't loop;
  - a clean file reloads silently, keeping the cursor and scroll position;
  - a dirty file shows "Changed on disk — Reload / Keep mine";
  - saving checks the file didn't change since it was loaded, else asks
    "Overwrite" or "Reload first";
  - a deleted file shows "Deleted on disk", and saving recreates it;
  - watches stop when a tab or window closes, and all of them on exit.
- **Window:** title `<file> — <folder> — Haruspex Editor`, theme follows
  Settings, a dirty dot on the tab, Ctrl/⌘+S saves, Ctrl/⌘+W closes a tab,
  closing a window with unsaved tabs asks first, size and position kept per
  folder, works whichever main tab is showing.
- **`open_in_editor` still returns at once**, and says which window or tabs
  opened.

## As built

- **Watcher** (`src-tauri/src/fs_tools/editor.rs`, `EditorWatches`, managed
  state). Watches the file's *directory*, non-recursive, refcounted per
  directory: our `write_atomic` and most editors replace a file by rename,
  which an inode watch on the file would lose. Each (file, window label) pair
  holds the content hash that window last read or saved. The notify callback
  only forwards paths to a debounce thread (150 ms quiet, 1 s cap) and never
  takes the state lock — `watch()` is called under that lock and waits on the
  watcher's own thread. Access events are dropped except close-after-write,
  or our own re-read in the flush would trigger the next one. After the
  burst, the file is hashed once and only windows whose hash differs get
  `editor://file-changed` `{ path, hash }` (`hash: null` = deleted), sent
  with `emit_to(label)`. The watcher and its thread are created on the first
  watch and dropped when nothing is open.
- **Commands:** `editor_read_file` (read + watch for the calling window;
  missing file → `content: null`), `editor_save_file` (unless `force`,
  `Conflict { hash }` when the disk hash isn't `expected_hash`; records the
  new hash *before* writing), `editor_unwatch_file`, `editor_find_open` (the
  window that has each file open, for routing). All go through
  `resolve_in_workdir`, so a window can't reach outside its folder.
  `WindowEvent::Destroyed` drops the window's watches; `RunEvent::Exit` drops
  them all.
- **Own saves:** the saving window's hash is updated before the write, so the
  watcher skips it; a second window showing the same file still hears about
  it. The frontend also ignores an event whose hash it already has.
- **Shared logic:** `src/lib/editor/document.svelte.ts` (`EditorDocument`:
  baseline/draft/hash, dirty, `diskChanged`, `save(force)`, `reload`,
  `keepMine`) with an injected `EditorIO`: `plainIO` (`fs_read_text_full` /
  `fs_write_text overwrite`, the modal's old calls, unchanged) and `watchedIO`
  (the editor commands). `FileEditorModal` now uses it; its behaviour and
  tests are unchanged. `workspace.svelte.ts` holds a window's tabs and the
  close questions.
- **Cursor:** CodeMirror's `setValue` now applies the minimal change (common
  prefix/suffix, `minimalChange`), so selection and scroll survive a reload.
- **Routing:** `src/lib/editor/windows.ts`. Label `editor-<fnv1a(root)>`;
  split windows add `-<time>`. `EditorRouter.open` asks `editor_find_open`
  first and sends already-open files to whichever window has them (split
  windows included), the rest to the folder's window. A new window can't
  hear events until it loads, so its files queue until it emits
  `editor://ready`; then `editor://open { files }` is sent. The route is
  `/editor?root=…`; the layout treats it as detached (no bootstrap, no MCP
  servers, no chrome).
- **Capabilities:** `capabilities/editor.json` for `editor-*` (core, create
  window for splits, zoom, close/destroy/title/focus/unminimize — no shell,
  sidecars or dialogs). `default.json` gains set-focus and unminimize so the
  main window can raise an editor.
- **Main window closing:** Rust calls `close()` on every `editor-*` window
  when `main` is destroyed, so one with unsaved edits asks first.
  Detached shell windows don't do this (they stay open after the main window
  closes); editors match the plan's "close too" instead.
- **Divergence — MCP shutdown:** the `Destroyed` handler stopped every MCP
  server when *any* window closed (a detached shell included). It now runs
  only for `main`; closing an editor window would otherwise have killed the
  user's MCP servers.
- **Geometry:** saved to `localStorage` (`haruspex.editorWindow.<key>`) on
  close, for the folder's own window only, and used when it next opens.
- **Theme:** applied at load like every window, and re-applied from the
  `storage` event when Settings changes it in the main window.
- **Not done:** the editor still has no line positioning (`:line` opens at
  the top), and no syntax highlighting beyond markdown. A tab with unsaved
  edits can't be moved to a new window (save first).
