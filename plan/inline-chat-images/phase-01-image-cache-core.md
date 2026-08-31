# Phase 01 — Image cache, provenance schema and fetch pipeline

**Depends on:** nothing · **Enables:** every later phase — the protocol handler
serves from this cache, the sources write provenance into it, and the
resolution pass calls its command.

## Goal

Build the Rust side of image handling: a content-addressed on-disk cache, the
`images` / `conversation_images` schema that records where every image came
from and under what licence, and a fetch pipeline that honours the user's proxy
and enforces size and type limits. Nothing renders yet. At the end of this
phase a Tauri command can be handed a list of URLs and a conversation id and
will return cache entries for the ones it successfully fetched.

## Files touched

- `src-tauri/src/db/mod.rs` — add `images` and `conversation_images` to the
  `migrate()` statement block (additive, `CREATE TABLE IF NOT EXISTS`, same
  style as the `memories` table at line 530).
- `src-tauri/src/image_cache/mod.rs` — **new.** Cache directory resolution,
  content-addressed read/write, LRU eviction, orphan sweep.
- `src-tauri/src/image_cache/fetch.rs` — **new.** The fetch pipeline: URL
  validation, proxied request, size ceiling, content-type and decode
  verification.
- `src-tauri/src/image_cache/license.rs` — **new.** Licence-code normalisation
  and the `embeddable` derivation.
- `src-tauri/src/image_cache/commands.rs` — **new.** `image_resolve` and
  `image_cache_stats` Tauri commands.
- `src-tauri/src/lib.rs` — declare the module; register the new commands in the
  `invoke_handler!` list at line 112.
- `src-tauri/Cargo.toml` — add the `image` crate for decode verification.
- `src/lib/ipc/commands.ts` — add the two command names.
- `src/lib/ipc/gen/` — regenerated, not hand-edited.

## Steps

1. **Schema.** Append to the `migrate()` statement block in `db/mod.rs`:

   ```sql
   CREATE TABLE IF NOT EXISTS images (
       hash TEXT PRIMARY KEY,          -- sha256 of the bytes, also the filename
       source_url TEXT NOT NULL,       -- URL it was fetched from
       source TEXT NOT NULL,           -- 'commons' | 'openverse' | 'wikipedia' | 'page_og'
       mime TEXT NOT NULL,
       width INTEGER NOT NULL,
       height INTEGER NOT NULL,
       bytes INTEGER NOT NULL,
       license TEXT,                   -- normalised code, e.g. 'cc-by-sa-4.0', 'pd', 'unknown'
       attribution TEXT,               -- creator / credit line, plain text
       description_url TEXT,           -- page to link the caption to
       embeddable INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL,
       last_used_at INTEGER NOT NULL
   );

   CREATE UNIQUE INDEX IF NOT EXISTS idx_images_source_url ON images(source_url);
   CREATE INDEX IF NOT EXISTS idx_images_last_used ON images(last_used_at);

   CREATE TABLE IF NOT EXISTS conversation_images (
       conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
       image_hash TEXT NOT NULL REFERENCES images(hash) ON DELETE CASCADE,
       PRIMARY KEY (conversation_id, image_hash)
   );

   CREATE INDEX IF NOT EXISTS idx_conversation_images_hash
       ON conversation_images(image_hash);
   ```

   `source_url` is uniquely indexed so a URL already fetched resolves from the
   cache without a network request, even across conversations.

2. **Cache directory.** `<app_data_dir>/images/`, resolved with the same
   `app_data_dir()` call used by `models.rs:551` and `db/memory_commands.rs:23`.
   Files are named `<hash>` with no extension; `mime` in the table is the
   authority on type. Create the directory on first use.

3. **Fetch pipeline** (`fetch.rs`), for one URL:
   - `validate_url()` from `proxy::extract` — reuse it directly; it already
     blocks private ranges and non-HTTP schemes.
   - Build the client with `proxy::extract::build_fetch_client(proxy)` so the
     user's configured HTTP proxy applies. This is the whole point of the
     phase; do not construct a bare `reqwest::Client`.
   - Reject before download if the `Content-Length` header exceeds **5 MB**.
   - Stream the body with a hard 5 MB cap, aborting if the cap is passed —
     a server may omit or lie about `Content-Length`.
   - Reject unless the response `Content-Type` is one of `image/jpeg`,
     `image/png`, `image/webp`, `image/gif`, `image/avif`.
   - **Decode-verify**: run the bytes through `image::load_from_memory` and
     take `width` / `height` from the decoded image. Bytes that fail to decode
     are rejected and nothing is cached. This is what stops a server that
     claims `image/png` while returning an HTML error page from poisoning the
     cache.
   - SVG is deliberately absent from the accepted list: it is script-capable
     markup, and the decode check cannot vet it.
   - 10-second timeout per image.

4. **Content addressing.** sha256 the verified bytes. If a row with that hash
   exists, skip the disk write and reuse it. Write to
   `<cache>/<hash>.part` then rename into place, so a crash mid-write cannot
   leave a truncated file that later reads treat as valid.

5. **Licence normalisation** (`license.rs`). Map each source's licence string
   to a stable code and derive `embeddable`:
   - Public domain / CC0 / `pdm` → `pd`, embeddable.
   - `by`, `by-sa` (any version) → `cc-by-*`, embeddable **with attribution**.
   - Anything containing `nc` or `nd` → recorded verbatim, `embeddable = 0`.
   - Unrecognised or missing → `unknown`, `embeddable = 0`.
   - `page_og` source → always `unknown`, `embeddable = 0`, regardless of what
     the page claimed.

   `embeddable` is written now and read by nothing in this project. It exists
   so the future document-embedding PR can filter on it without re-fetching
   anything. Store the normalised code **and** keep the raw licence string in
   `license` if normalisation fails, so a later pass can improve the mapping
   against real data.

6. **`image_resolve` command.** Signature:
   `image_resolve(conversation_id: String, requests: Vec<ImageRequest>, proxy: Option<ProxyConfig>) -> Vec<ResolvedImage>`,
   where `ImageRequest` carries `url` plus the provenance the caller already
   knows (`source`, `license`, `attribution`, `description_url` — all optional,
   populated for `image_search` results and empty for `og:image`).
   For each request: return the existing row if `source_url` matches, else
   fetch. On success insert into `images`, insert into `conversation_images`,
   bump `last_used_at`, and return the row. On failure return nothing for that
   URL — **failures are omitted from the result, never returned as an error
   entry**, so the caller's "drop silently" behaviour needs no special casing.
   Fetch the requests concurrently, capped at 4 in flight.

7. **Eviction.** After each successful `image_resolve` batch, if the sum of
   `bytes` exceeds **500 MB**, delete rows in ascending `last_used_at` order
   until under the cap, removing each file as it goes. Rows referenced by a
   `conversation_images` row are still evictable — the conversation keeps the
   original URL in its message text, so a later open re-fetches. The cap is a
   disk limit, not a retention promise.

8. **Orphan sweep.** Add a `sweep_orphans()` run at startup and after a
   conversation delete: any `images` row with no `conversation_images` rows is
   deleted along with its file, and any file in the cache directory with no
   matching row is deleted. The `ON DELETE CASCADE` on `conversation_images`
   handles the row removal when a conversation goes; the sweep collects the now
   unreferenced image rows and their bytes. This is what makes "delete the
   conversation, delete its images" true.

9. **Types.** `ImageRequest` and `ResolvedImage` get `#[derive(ts_rs::TS)]` and
   `#[ts(export)]`. Run `./scripts/export-ipc-types.sh` and commit the
   generated files — CI fails otherwise.

## Build gate

```bash
cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test
./scripts/export-ipc-types.sh   # must produce no uncommitted diff
cd .. && npm run check
```

## Test plan

Rust unit tests in `image_cache/`:

- **Decode verification** — bytes of an HTML error page served as
  `Content-Type: image/png` are rejected and nothing is written to disk.
- **Size ceiling** — a body over 5 MB aborts mid-stream and caches nothing,
  both with an honest and an absent `Content-Length`.
- **Content addressing** — the same bytes fetched from two different URLs
  produce one row and one file.
- **Licence mapping** — a table test over the real strings observed on
  2026-08-30: `by-nc`, `by-sa`, `by`, `by-nc-nd`, `by-nc-sa`, `CC BY-SA 4.0`,
  `Public domain`, `""`. Assert the `nc` and `nd` cases are `embeddable = 0`.
- **Eviction** — with the cap lowered by a test constant, the least recently
  used rows and their files go first and the cap is respected.
- **Orphan sweep** — deleting a conversation removes its images' bytes; an
  image referenced by a second conversation survives.
- **Failure omission** — a batch of three URLs where one 404s returns two
  entries and no error.

Manual: set an HTTP proxy in Settings, call `image_resolve` from the devtools
console, and confirm the request appears in the proxy log rather than going
direct.

## Commit

```
feat(images): content-addressed image cache with provenance and proxied fetch
```

## Rollback

Revert the commit. The two new tables are additive and unreferenced by any
other query, so leaving them in a database that has been rolled back is
harmless — `CREATE TABLE IF NOT EXISTS` makes re-applying safe. Delete
`<app_data_dir>/images/` to reclaim disk. Nothing user-visible changes either
way, because nothing renders images yet.
