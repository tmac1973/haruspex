# Phase 04 — Bundled ffmpeg, ffprobe and melt on the model's PATH

**Depends on:** 02, 03 · **Enables:** the PATH goal in the overview

## Goal

While Settings → Video editing is on, a Code tab command or a Shell tab
session that runs `ffmpeg`, `ffprobe` or `melt` gets the bundled copies.
With it off, the user's PATH is left as it is. Each tool is reached through a
small wrapper script that sets `media_env`'s variables just for that one
process, because putting our library path on the shell itself would break
the user's other tools.

## Files touched

- `src-tauri/src/media_env.rs` → `shim_dir(app)` is
  `app_local_data_dir/runtime-bin/media/`. `write_shims(app)` writes
  `ffmpeg`, `ffprobe` and `melt` there. On Linux and macOS these are
  wrapper scripts. On Windows they are copies of the bundled `.exe` files,
  which are small now that libav* is shared (see step 2).
  `remove_shims(app)` deletes the folder. A `static SHIMS_ON: AtomicBool`
  says whether they are in use.
- `src-tauri/src/video/commands.rs` → `#[tauri::command] media_shims_set(app,
  enabled: bool)` writes or removes the shims and sets `SHIMS_ON`.
- `src-tauri/src/lib.rs` → register `media_shims_set`.
- `src-tauri/src/code_tools/mod.rs` → `default_shell_command` and
  `powershell_command` prepend `shim_dir` to `PATH` when `SHIMS_ON` is true
  (through `runtimes::prepend_path`, made `pub(crate)`).
- `src-tauri/src/shell/session.rs` → the PTY builder prepends `shim_dir` to
  the `PATH` it copies when `SHIMS_ON` is true (on Windows it also applies
  step 2's variables). A session keeps the PATH it started with, so turning
  Video editing off affects new sessions only. The guide line says so. WSL sessions
  (`shell/wsl.rs`) never get it, since Windows binaries don't belong on a
  Linux PATH.
- `src/lib/video/binaries.ts` → `syncMediaShims()` calls
  `invoke('media_shims_set', { enabled })` with `videoEditingEnabled &&
  bundled tools found`. It's called once at startup and again whenever
  `videoEditingEnabled` or a tool choice changes, using the existing settings
  subscription in that file.
- `src/lib/ipc/gen/*` → regenerated.
- `docs/guide/video-editing.md` → one line: with Video editing on, the
  model's commands use the bundled tools.
- `docs/guide/code.md` and `docs/guide/shell.md` → the same line.

## Steps

1. Unix wrapper text, written with mode 0755:
   ```sh
   #!/bin/sh
   LD_LIBRARY_PATH="<media/lib>${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
   MLT_REPOSITORY="<…>" MLT_DATA="<…>" MLT_PROFILES_PATH="<…>" \
   MLT_PRESETS_PATH="<…>" QT_PLUGIN_PATH="<…>" QT_QPA_PLATFORM=offscreen \
   exec "<bundled binary>" "$@"
   ```
   On macOS the variable is `DYLD_LIBRARY_PATH`. Paths are single-quoted, with
   any embedded `'` escaped. The text comes from the same table `apply` uses,
   so the two can't drift: both are built from phase 02's `media_env::vars`.
2. Windows: no `.cmd` wrappers, because cmd.exe mangles `%` in arguments
   and model-written ffmpeg commands use it (`frame_%04d.png`). Instead:
   - `shim_dir` holds copies of the three bundled `.exe` files named
     `ffmpeg.exe`, `ffprobe.exe` and `melt.exe`.
   - While `SHIMS_ON`, the Code tab's PowerShell command gets `shim_dir`
     prepended to `PATH`, `media\lib` *appended* to `PATH` (Windows looks
     there last for DLLs, so no other program's DLLs are displaced), and the
     `MLT_*` and `QT_*` variables from `media_env::vars`. Those are inert for
     anything that isn't MLT or Qt.
3. Rewrite the shims on every `media_shims_set(true)`, so an app update that
   moves the install directory fixes them.
4. Tests: `write_shims` into a temp dir produces three executable files.
   - On Unix, each script names its binary and `media/lib`.
   - On Windows, each is a byte-identical copy of its bundled `.exe`.
   - `default_shell_command` (and `powershell_command` on Windows) puts the
     shim dir first on `PATH` only while `SHIMS_ON` is true. On Windows it also
     appends `media\lib` and sets the `MLT_*` and `QT_*` variables.

## Build gate

- `cargo fmt -- --check`, `cargo clippy -- -D warnings`, `cargo test`.
- `./scripts/export-ipc-types.sh` with no diff afterwards.
- `npm run check`, `npm run lint`, `npm run test`.
- `node scripts/guide-check.mjs < /dev/null`.

## Test plan

- Dev app, Video editing on, in the Code tab: the model runs
  `which ffmpeg melt && melt -version && ffmpeg -hide_banner -buildconf | head -3`.
  The output names the shim dir, MLT 7.40.0, and `--enable-shared`.
- Turn Video editing off and run the same in a new Code tab command: `which`
  finds the system's copies or nothing.
- In a new Shell tab with Video editing on, `ffmpeg -version` runs the
  bundled one, and the user's own `ls` and `git` still work (no library path
  leaked into the shell).
- On wintest, PowerShell in the Code tab runs `ffmpeg -version` and gets the
  copied `ffmpeg.exe` from the shim dir, finding its DLLs through the
  appended `media\lib`.

## Commit

`feat(code): bundled ffmpeg and melt on the model's path while video is on`

## Rollback

Revert the commit. Shims left in `runtime-bin/media/` are harmless once
nothing prepends that folder. Safe to revert on its own.
