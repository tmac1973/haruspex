# Phase 08 — Image generation for the Shell assistant

Depends on: 07 (`generateForTool`, the `'image'` category) / Enables: —

## Goal

In the Shell tab with code mode on, the assistant can make game or app art
straight into the project it's working on. For example, "make a 32 px coin
sprite in assets/" produces a transparent, cropped, palette-reduced PNG at
that path.

It uses the asset job's single-entry processing: request scaffolds,
transparency, tiling for textures, normalisation and checks. It doesn't use
the style anchor or sheets (decision 4). The assistant can see what it made
when the model has vision, and tool progress reaches the Shell tab.

**What is missing today:**
- The Shell assistant has no binary writer for absolute paths; it only has
  `fs_write_bytes`, which is relative to a workdir.
- `runShellTurn` doesn't pass tool progress through (`runShellTurn.ts:114`).

## Files touched

- `src-tauri/src/fs_tools/absolute.rs`: `fs_write_bytes_absolute`.
- `src-tauri/src/lib.rs`: register it.
- New `src/lib/image/asset.ts`, with `makeSingleAsset`.
- New `src/lib/agent/tools/make-asset.ts`, with `make_asset`.
- `src/lib/agent/tools/registry.ts`: `make_asset` gated by name in both the
  Chat and code filters.
- `src/lib/shell/runShellTurn.ts` and `src/lib/stores/shell.svelte.ts`
  (around :931-963): forward `onToolProgress` and show it on the step.
- `src/lib/agent/jobs/types/asset-generation/request.ts`: export what
  `makeSingleAsset` needs, without behaviour change.
- Tests beside each; `./scripts/export-ipc-types.sh`.

## Steps

1. **`fs_write_bytes_absolute(path, bytes, overwrite, wsl_distro)`** has the
   same atomic-write and no-overwrite semantics as `fs_write_bytes`, on an
   absolute path.
   - It takes `wsl_distro`, as every `*_absolute` command does.
   - It creates missing parent directories, as `fs_write_text_absolute`
     does.
   - It refuses a path inside the app's data directory.
   - Reuse phase 04's protected targets if 04 has landed; otherwise check the
     data directory directly.
2. **`makeSingleAsset(input, opts)`** in `src/lib/image/asset.ts`.
   - `input`:
     - `kind`: `sprite`, `icon`, `texture` or `image`;
     - `prompt`;
     - `size`, the target edge in px. Defaults: sprite 64, icon 32,
       texture 128, image 1024.
     - `style?`, one line;
     - `palette?`, colours, from `palette_from` (step 3).
   - For `sprite`, `icon` and `texture`, follow the asset job's per-entry
     loop (`generate.ts:105-106`, `:153-160`):
     1. build an `AssetEntry` and a minimal `AssetSpec` in memory:
        - `style` is an `AssetStyle`, `{ prompt: input.style ??
          FALLBACK_STYLE }`;
        - `normalize` is `defaultProfile()` with `target_size = size`;
     2. resolve the kind's profile with `effectiveProfile(profile, kind)`
        **before** building the request, and apply the job's palette rule for
        a backend with alpha;
     3. call `buildEntryRequest` and `checkProfile`;
     4. **transparency:** for sprites and icons on a backend with
        transparency, set `transparent: true` on the request, as the sheet
        path does (`sheets.ts:177`). On a backend without it, keep
        `buildEntryRequest`'s keyed-background scaffold;
     5. pass the whole `ImageRequest` (negative prompt, seed and model
        included) to `generateForTool`;
     6. `normalizeImage` with the resolved profile;
     7. `checkImage`.
     - It retries once with a new seed when the check fails, and then
       returns the better result with its failed checks listed. It never
       throws away a usable image.
     - A texture whose seam pass failed comes back with the note "does not
       tile".
   - For `image`: one `generateForTool` call, with no normalisation.
   - Returns `{ bytes, width, height, checks: { passed, failed[] }, notes[],
     seed, model }`.
3. **The `make_asset` tool** (category `'image'`, code mode only).
   - Arguments:
     - `kind`, `prompt`, `path` (relative to the shell's cwd, or absolute);
     - `size?`, `style?`;
     - `palette_from?`, a path to an existing image whose palette to match.
       Read it, take `extractPalette`, and pass the colours. This keeps a
       session's art consistent without an anchor.
     - `overwrite?`, default false.
   - Execution:
     1. resolve the path with `resolveShellPath`;
     2. refuse with `localWriteBlocked`'s reason when the terminal is over ssh
        or in a container;
     3. call `makeSingleAsset` with `ctx.signal` and progress;
     4. write with `fs_write_bytes_absolute`.
   - The result gives the path, the pixel size, the checks, the notes, and the
     model and seed. Its `thumbDataUrl` shows the image on the step card.
   - Push the image onto `ctx.pendingImages`, so the assistant sees it next
     turn and can redo it. The Shell tab already runs with
     `visionSupported: true` (`shell.svelte.ts:934`), and `ToolContext` has no
     vision flag to check.
   - An existing file with `overwrite` false is refused, and the result says
     to choose another name or pass `overwrite`.
4. **Gating, by name rather than category.** `shouldIncludeCodeTool` drops
   unknown categories (`registry.ts:111-133`), and the `'image'` category
   would put the tool in Chat.
   - `make_asset` is added to the code-mode filter by name, when the image
     backend isn't `none`.
   - The Chat filter excludes it by name.
   - It is never offered in normal Shell mode.
5. **Progress.** `runShellTurn` passes `onToolProgress` through to the loop,
   so the Shell tab's step shows "Drawing… 40 s", as Chat does.
6. **Prompt.** The code-mode system prompt gets one sentence: when the user
   wants art for the project, use `make_asset`, at the size the project
   uses, and pass `palette_from` with an existing asset to keep a set
   consistent.

## Build gate

The overview's gate. `check-ipc` must pass.

## Test plan

- **Rust:**
  - `fs_write_bytes_absolute` writes atomically;
  - it refuses to overwrite by default;
  - it refuses a data-directory path.
- **TS, `makeSingleAsset`** (fake backend and normalize):
  - on a backend with transparency, a sprite request has
    `transparent: true`, is sized `size × upscale` (capped at 1024) and
    normalises as `sprite`;
  - on a backend without transparency, it carries the keyed-background
    scaffold instead;
  - a texture asks for seamless;
  - a failed check retries once, then returns the better result with the
    failures listed;
  - `image` skips normalisation.
- **TS, tool:**
  - offered only in code mode with a backend;
  - a relative path resolves against the shell cwd;
  - an ssh terminal is refused;
  - an existing file without `overwrite` is refused;
  - `palette_from` passes the extracted colours.
- **TS, `runShellTurn`:** a tool's progress callback reaches the step.
- **Manual:**
  - in a scratch game project in the Shell tab with code mode, ask for a
    32 px coin sprite into `assets/`, a 128 px grass texture, and then
    "another coin matching assets/coin.png";
  - the files exist, the sprite has a transparent background, the texture
    tiles 2×2 without a seam, and the second coin uses the first's colours.

## Commit

`feat(shell): the code-mode assistant can make sprites, icons and textures into the project`

## Rollback

Revert the commit and re-export the IPC types.
