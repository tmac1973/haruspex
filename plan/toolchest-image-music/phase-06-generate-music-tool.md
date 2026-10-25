# Phase 06 — The `generate_music` tool

**Depends on:** 03, 04, 05 · **Enables:** 07

## Goal
Let the model make music. `generate_music`:
- is offered in Chat and the Code tab (not Shell) when Settings → Music has a backend and
  the turn is interactive;
- shows phase progress on its step card;
- stores the audio in the audio cache, linked to the conversation;
- puts a player on the step card and tells the model to embed it in the
  answer.

In Code an optional `path` also writes the file into the project.
Cancelling the turn cancels the toolchest job.

## Files touched
- **`src/lib/agent/tools/music-gen.ts`** (new): the tool definition and
  executor, `category: 'music'`.
- **`src/lib/agent/tools/music-gen.test.ts`** (new).
- **`src/lib/agent/tools/types.ts`:** add `'music'` to the category union
  (L290-314). `pendingImages` is for feeding images back to the model, so
  audio does not use it.
- **`src/lib/agent/tools/registry.ts`:**
  - `musicGeneration: boolean` in options (L82);
  - schema gating `reg.category === 'music' && !opts.musicGeneration` (L206);
  - `musicGeneration: interactive && getSettings().musicBackendKind !== 'none'`
    (L328);
  - a runtime refusal mirroring images (L536-550): "Music generation is off —
    choose a backend in Settings → Music.";
  - `shouldIncludeChatTool`: `reg.category === 'music'` →
    `opts.musicGeneration`;
  - `shouldIncludeCodeTool` (L146-176):
    `if (name === 'generate_music') return opts.musicGeneration && isCodeTab(opts);`.
    This leaves out Code's Shell tab, and `shouldIncludeShellTool` already
    returns false for it;
  - `subtaskExcludes` (L228): add `generate_music`, as for `make_asset`
    (subtasks make no art);
  - the `withoutProjectWrite` helper and its use in `schemaFor`.
- **`src/lib/agent/tools/index.ts`:** import `music-gen.ts` beside
  `image-gen.ts`.
- **`src/lib/agent/tools/_assetIo.ts`:** reuse `writeAsset` for `path` writes
  (bytes from the cache through `audio_read_bytes`).
- **`src-tauri/src/audio_cache/commands.rs`:** `audio_read_bytes(hash)` → the
  bytes for a project write, capped at 50 MB.
- **`src-tauri/src/lib.rs`:** register it.
- **IPC:** `src/lib/ipc/commands.ts`, regenerated.
- **`src/lib/audio/eligible.ts`:** `AUDIO_TOOLS = ['generate_music']`.
- **`src/lib/code/system-prompt.ts`** (L68-72): one line for `generate_music`
  when the music kind isn't `none`. The chat system prompt
  (`src/lib/agent/system-prompt.ts`) does not list `generate_image` and gets
  no line; the tool schema's description carries it there.
- **`docs/guide/music.md`:** "Make a song in Chat" and "Add music to a
  project", with the tool's options.
- **`docs/guide/chat.md`:** one line pointing at the `music` page for making
  songs. There is no separate tools page; tools are described on their own
  feature pages, as `generate_image` is on `images`.
- **`docs/guide/code.md`:** one line on `path`.

## Steps
1. **Schema.**
   - `caption` (string, required): "Genre, mood, instruments and tempo feel, as
     comma-separated tags."
   - `lyrics` (string): "Song lyrics with [verse]/[chorus] section tags. Omit
     for instrumentals."
   - `instrumental` (boolean).
   - `duration_seconds` (number, 5–240, default from Settings).
   - `bpm` (integer, 40–220).
   - `key` (string, e.g. "C major").
   - `language` (string, ISO code of the lyrics).
   - `format` (`"mp3"` | `"wav"`, default `"mp3"`).
   - `title` (string, used for the player and filename). When it is omitted,
     the tool uses the first five words of `caption`, title-cased.
   - `path` (string, project-relative) and `overwrite` (boolean, default
     false, "Replace an existing file."): Code only.
     - The registered schema has both. `schemaFor` in `registry.ts` strips
       them for Chat with a `withoutProjectWrite(schema)` helper written like
       `withoutWhere` (L431).
     - At run time, a `path` with no `ctx.codeSessionId` is refused.
   - Descriptions are one short sentence each.
2. **Execute.**
   - Validate and clamp the arguments, and pick a random seed.
   - Use the `onProgress` ticker (1 s) with `describeMusicProgress`.
   - Call `resolveMusicBackend().generate(req, {signal: ctx.signal,
     onProgress, conversationId: ctx.conversationId, codeSessionId:
     ctx.codeSessionId})`, so the audio is linked to the chat or Code session.
   - A cancelled error is rethrown, as `image-gen.ts` does.
3. **Result to the model.** Return:
   `Made "<title>" (<duration> s, <bpm> bpm, <key>, seed <seed>). Put ![<title>](<url>) in your answer.`
   - plus `Wrote <path>.` when it wrote a file;
   - plus notes, e.g. "duration clamped to 240 s".
   - Set `artifacts: [{kind:'audio', mime, src: url, title}]` on the step
     output so the card plays it.
4. **Project write.** When `path` is given:
   - build `{path, overwrite: args.overwrite === true, io: assetIo(ctx)}` as
     `make-asset.ts` L318 does;
   - before generating, check the path can be written with `writeAsset(path,
     new Uint8Array(), overwrite, true, io)` (the same pre-check as
     `make-asset.ts` L124-125), so a bad path fails before minutes of work;
   - after generating, `audio_read_bytes(result.hash)`, then `writeAsset`;
   - if the extension in `path` doesn't match `format`, the tool uses the
     path's extension (`.wav` → wav, `.mp3` → mp3) and notes it; any other
     extension is refused up front.
5. **Safety net and prompts.** Set `AUDIO_TOOLS = ['generate_music']`; the
   Phase 04 call site picks it up. Add the Code system-prompt line.
6. **Guide.** Update `music.md`, `chat.md` and `code.md`. The PR body
   names them.

## Build gate
```bash
npm run check
npm run lint
npm run test
npm run format:check
cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt -- --check
./scripts/export-ipc-types.sh
git diff --exit-code src/lib/ipc
node scripts/guide-check.mjs
```

## Test plan
Automated:
- **`music-gen.test.ts`,** with a fake music backend registered in the
  registry:
  - clamps duration 300 → 240 and notes it;
  - default duration comes from settings;
  - instrumental with no lyrics;
  - the result text contains the `haruspex-audio` URL and the artifact;
  - in Chat, `path` and `overwrite` are absent from the schema;
  - the tool is absent in Shell, in Code's Shell tab and in subtasks;
  - in Code, a `path` with an unwritable location fails before
    `generate` is called;
  - `.wav` path overrides format;
  - cancel propagates.
- **`registry` tests:**
  - the tool is hidden with music `none` and in non-interactive turns;
  - the runtime refusal text names Settings → Music.
- **Rust:** `audio_read_bytes` returns stored bytes, and returns `Err("Audio not found")` for an
  unknown hash.

Manual:
- **Chat:** with the model on compute2 and music on asmodean, ask "make a
  45-second lo-fi track about rain". The card shows Queued → Composing →
  Synthesizing; the answer has a player that plays; it still
  plays after a restart.
- **Cancel:** cancel mid-run, and the toolchest job shows `cancelled`.
- **Code:** in a game project, "add background music at assets/bgm.mp3". The
  file exists in the project and the step card plays it.

## Commit
`feat(music): add the generate_music tool for chat and code`

## Rollback
Revert the PR. The tool disappears from schemas, and past messages keep
playing, because the players come from markdown and the cache (Phases 03–04).
`audio_read_bytes` is removed with it.
