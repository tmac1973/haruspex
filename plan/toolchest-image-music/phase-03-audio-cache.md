# Phase 03 — Audio cache and the `haruspex-audio:` scheme

**Depends on:** nothing (it can be built in parallel with 01–02, but is
numbered after them) · **Enables:** 04 (players need a URL that resolves), 05
(storing the test clip), 06 (storing tool output)

## Goal
Give Haruspex somewhere durable to keep generated audio, because toolchest
deletes it after 24 h.

- Files are content-addressed under `<app_data>/audio/`, with rows linked to
  conversations.
- The webview reads them over a `haruspex-audio:` scheme that supports Range
  requests, so seeking works.
- The remote-control web client reads them over `/api/v1/audio/<hash>`.
- No UI renders a player yet; Phase 04 adds that.

## Files touched
- **`src-tauri/src/audio_cache/mod.rs`** (new):
  - `cache_dir(app)` → `<app_data>/audio/`;
  - `pub const MAX_AUDIO_BYTES: u64 = 50 * 1024 * 1024` and
    `MAX_AUDIO_CACHE_BYTES = 2 GiB`, both defined here only;
  - `hash_bytes` (shared with images: same sha256 helper, re-exported from
    `image_cache`);
  - `write_bytes`, `evict_to_cap`, `sweep_orphans`.
- **`src-tauri/src/audio_cache/commands.rs`** (new):
  - `audio_store_url(url, api_key, mime_hint, title, conversation_id,
    code_session_id)`. Every "50 MB" below means `MAX_AUDIO_BYTES` from
    `mod.rs`:
    downloads with the `comfy.rs` no-proxy client and streams to disk, so the
    bytes never cross IPC;
  - `audio_rehydrate(hashes, conversation_id, code_session_id)`;
  - `audio_cache_size()`, `audio_cache_clear()`, `audio_sweep()`.
- **`src-tauri/src/audio_cache/protocol.rs`** (new): the `haruspex-audio`
  handler, which serves the stored mime and honours `Range`
  (206 / `Content-Range`).
- **`src-tauri/src/db/mod.rs`:** a migration creating the `audio`,
  `conversation_audio` and `code_session_audio` tables.
- **`src-tauri/src/db/audio.rs`** (new):
  - `insert_audio`, `link_audio`, `audio_by_hash`, `touch_audio`;
  - `audio_total_bytes`, `audio_to_evict(cap)` (unlinked only, oldest
    `last_used` first), `unreferenced_audio_hashes`, `delete_audio`.
- **`src-tauri/src/lib.rs`:**
  - `mod audio_cache;`;
  - `register_asynchronous_uri_scheme_protocol("haruspex-audio", …)` beside
    `haruspex-img` (L109);
  - the commands;
  - `audio_sweep` at startup next to `image_sweep`.
- **`src-tauri/tauri.conf.json`** (L24): CSP
  `media-src 'self' blob: data: haruspex-audio: http://haruspex-audio.localhost`.
- **`src/lib/sanitize.ts`** (L24-33): add `haruspex-audio` to
  `ALLOWED_URI_REGEXP` and its Windows `http://haruspex-audio.localhost/` form,
  with the comment updated.
- **`src/lib/sanitize.ts` tags:** no change. DOMPurify's default allow-list
  already includes `audio`, `source`, `figure` and `figcaption`, and the
  sanitizer adds no `FORBID_TAGS` for them (it forbids form tags only).
- **`src/lib/audio/url.ts`** (new): `audioSrc(hash)` (platform form, like
  `images/url.ts`) and `LOCAL_AUDIO_URL` regex.
- **`src-tauri/src/owner/server.rs`:**
  - an `Audio` trait beside `Images` (L76-94): `audio(hash)` → `(mime, path)`;
  - `.route("/api/v1/audio/{hash}", get(audio))` with Range support, behind
    the same pairing auth as `/api/v1/image`.
- **`src/web/images.ts`** → new **`src/web/audio.ts`:** maps `haruspex-audio:`
  URLs to `/api/v1/audio/<hash>` for the web client.
- **IPC:** `src/lib/ipc/commands.ts` and `src/lib/ipc/gen/*`, regenerated.

## Steps
1. **Migration.**
   - `audio(hash TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
     duration_ms INTEGER, title TEXT, source TEXT NOT NULL, created INTEGER
     NOT NULL, last_used INTEGER NOT NULL)`.
   - `conversation_audio(conversation_id TEXT NOT NULL REFERENCES
     conversations(id) ON DELETE CASCADE, audio_hash TEXT NOT NULL REFERENCES
     audio(hash) ON DELETE CASCADE, PRIMARY KEY(conversation_id, audio_hash))`.
   - `code_session_audio(code_session_id TEXT NOT NULL REFERENCES
     code_sessions(id) ON DELETE CASCADE, audio_hash TEXT NOT NULL REFERENCES
     audio(hash) ON DELETE CASCADE, PRIMARY KEY(code_session_id, audio_hash))`.
     Code-tab tools carry `ctx.codeSessionId` instead of a conversation id
     (`agent/tools/types.ts` L193). Without this table, Code-tab audio would
     be swept an hour after it was made.
   - Add an index on `audio_hash` for each link table.
   - "Linked" everywhere below means a row in either link table.
   - Add these in `migrate()` using `CREATE TABLE IF NOT EXISTS`, as the
     images tables do (L657-690).
   - Every store and rehydrate command takes `conversation_id: Option<String>`
     and `code_session_id: Option<String>`, and links to whichever is given.
2. **Storage.**
   - Write to `<hash>.<ext>`, with the extension from the mime: `audio/mpeg` →
     `mp3`, `audio/wav` → `wav`, `audio/ogg` → `ogg`, `audio/flac` → `flac`.
     Any other mime is refused.
   - Size limits: an empty body is refused, and anything over
     `MAX_AUDIO_BYTES` gives "Audio is over 50 MB".
3. **`audio_store_url`.**
   - Stream the response into a temp file, hashing as it goes, and abort past
     50 MB.
   - Rename the file to its hash and insert the row (source `"generated"`).
   - Link it to whichever of `conversation_id` / `code_session_id` is given,
     then run `evict_to_cap`.
   - The mime comes from Content-Type, falling back to `mime_hint`.
   - Return `{hash, mime, bytes}`.
4. **Eviction.** `evict_to_cap(2 GiB)` deletes only audio with no row in
   either link table, oldest `last_used` first. Linked audio is never
   evicted, so the cache may exceed the cap; Settings → Music shows the size.
5. **Sweep.**
   - Startup `audio_sweep` deletes files and rows with no row in either link
     table that are older than 1 hour.
   - The 1 hour grace covers a chat not saved yet, which mirrors the image
     test "a chat not saved yet does not lose the picture".
   - It also deletes stray files that have no row.
6. **Clear.** `audio_cache_clear` deletes every unlinked file. A
   "Clear unused audio" action leaves linked audio alone.
7. **Protocol.**
   - Parse `haruspex-audio://localhost/<hash>` and check it with
     `is_valid_hash`.
   - Look up the row, `touch_audio`, then serve the file. A
     `Range: bytes=a-b` request gets 206 with `Content-Range` and
     `Accept-Ranges: bytes`; without Range, 200.
   - Unknown hash → 404.
8. **CSP and sanitizer.** Add the scheme to both. Write a
   `sanitize.test.ts` case where
   `<audio src="haruspex-audio://localhost/<hash>">` survives and
   `<audio src="file:///…">` does not.
9. **Web client.**
   - Implement `Audio` for the owner server from the same DB and dir.
   - The route reuses the image route's auth extractor.
   - `src/web/audio.ts` rewrites both URL forms,
     `haruspex-audio://localhost/<h>` and the Windows form
     `http://haruspex-audio.localhost/<h>`, to `/api/v1/audio/<h>`, the same
     way `src/web/images.ts` handles images.
10. **IPC.** Regenerate the IPC types.

## Build gate
```bash
cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt -- --check
npm run check
npm run lint
npm run test
npm run format:check
./scripts/export-ipc-types.sh
git diff --exit-code src/lib/ipc
npm run build:web
```

## Test plan
Automated (Rust, `TestDir` plus an in-memory DB, as in
`image_cache/commands.rs` tests):
- **Store, link, sweep:** stored audio linked to a conversation, and stored
  audio linked to a Code session, both survive `sweep_orphans`;
  unlinked audio older than 1 h is swept; unlinked audio newer than 1 h is
  kept.
- **Size limits:** 50 MB + 1 is refused; exactly 50 MB is accepted; an empty
  body is refused.
- **Eviction:** `evict_to_cap` never removes linked audio, and removes unlinked
  audio oldest first.
- **Range:** the protocol's range parser returns the right slice and headers
  for `bytes=0-`, `bytes=100-199` and `bytes=-50`; an out-of-range request
  gives 416.
- **`audio_store_url`:** against a local `axum` test server, a 1 KB mp3 is
  stored with mime `audio/mpeg`, and a 60 MB body aborts with nothing left on
  disk.
- **Web route:** `owner/server.rs` serves `/api/v1/audio/<hash>` with Range,
  and returns 401 without pairing.
- **Sanitizer:** `sanitize.test.ts` covers the cases in step 8.

Manual: store a test mp3 from the devtools console through
`invoke('audio_store_url', …)`. Then
`new Audio('haruspex-audio://localhost/<hash>').play()` plays it, and dragging
the seek position works.

## Commit
`feat(audio): add a content-addressed audio cache served as haruspex-audio:`

## Rollback
Revert the PR. The new tables are left behind by `CREATE TABLE IF NOT EXISTS`
and are harmless; nothing else reads them. No existing image path changes,
apart from the shared `hash_bytes` re-export, which is behaviour-neutral.
