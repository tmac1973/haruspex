# Phase 15 — Dead-link check

**Depends on:** 01, 02, 03, 13 · **Enables:** nothing later depends on it

## Goal
Each notebook has a "Check links" menu item. A notebook is also checked
automatically when it is opened, if its last check is more than a week old.
Broken links in text cards and URL cells get a warning mark, with the error
in a tooltip. Checks go through the app proxy. Local-network and localhost
links are skipped and marked "Not checked (local address)", not reported as
broken.

## Files touched
- `src-tauri/src/notebook_links.rs` (new): the command
  `notebook_links_check(notebook_id, urls, proxy)`.
  - Builds one client with `build_fetch_client(proxy)`
    (`src-tauri/src/proxy/extract.rs:338`), which applies the proxy, the SSRF
    redirect policy and the public-only resolver.
  - Up to 6 requests at a time, each a HEAD with a 10 s timeout.
  - Falls back to GET with the body read through `http_util::read_capped` at
    64 KB on 405, 403 or 501, or when HEAD fails at the network level.
  - **ok**: any 2xx, or a 3xx followed to a 2xx.
  - **broken**: 404, 410, any 5xx, DNS failure, connection refused, or a TLS
    error. The status text records which.
  - **skipped**: blocked by the public-only resolver (a local address). Also
    timeouts and 429, recorded as "Didn't answer", which is not broken.
  - Upserts each result into `notebook_link_status` (phase 01) and sets
    `notebooks.links_checked_at`.
  - Returns `[{url, ok, status}]`.
- `src-tauri/src/db/notebooks.rs`: `notebook_link_status_get(notebook_id)`
  and the upsert.
- `src-tauri/src/lib.rs`, IPC bindings and mocks: register the commands.
- `src/lib/notebooks/links.ts` (new):
  - `collectLinks(cards)`: http(s) links from text card markdown, through
    `marked`'s lexer, plus every URL cell; deduped
  - `checkNotebookLinks(id)`: calls the command with `getSettings().proxy`
  - `shouldAutoCheck(nb)`: `links_checked_at` older than 7 days, or null
    while the notebook has links
- `src/lib/notebooks/links.test.ts` (new).
- Link checking runs only on this computer's notebooks: the menu item, the
  auto-check and the marks apply when the open notebook's backend (phase 13)
  has `kind === 'local'`. A paired computer's notebook shows no link marks
  and no "Check links" item; its owner checks it when opened there.
- `src/lib/stores/notebooks.svelte.ts`:
  - after `openNotebook`, if the backend is local and `shouldAutoCheck`, run the check in the
    background (`void … .catch(console.warn)`)
  - keep the link status map for the open notebook
- `src/lib/components/notebooks/cards/TextCard.svelte` and `TableCard.svelte`:
  - broken links get a warning icon after them, with `title` set to the
    status
  - skipped links get no mark
- `src/lib/components/notebooks/NotebookView.svelte`:
  - a "Check links" menu item with a spinner
  - a one-line summary afterwards: "2 broken links", which scrolls to the
    first when clicked
- `docs/guide/notebooks.md`: "Find broken links".

## Steps
1. The Rust command. No mock HTTP server is added. The decisions are pure
   functions, tested directly:
   - `classify(outcome)` maps a status or error to ok, broken or skipped.
   - `needs_get_fallback(head_outcome)` decides the HEAD-to-GET retry.
   - The network call itself is covered by the manual test.
2. `links.ts` and its tests.
3. UI marks, menu item, auto-check on open.

## Build gate
- `cd src-tauri && cargo clippy -- -D warnings && cargo test`
- `./scripts/export-ipc-types.sh` (no drift)
- `npm run check && npm run lint && npm run test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- Rust: `needs_get_fallback` for 405, 403, 501 and a network error;
  `classify` for 200, 301→200, 404, 410, 500, 429, timeout, DNS
  failure, and a blocked local address.
- Unit: `collectLinks` from mixed markdown and tables; `shouldAutoCheck`
  boundaries.
- Manual:
  1. A notebook with one good link, one 404 link and one `http://192.168.1.1`
     link. Check links: one broken mark, and the local link unmarked.
  2. Reopen within a week: no automatic check.
  3. Set `links_checked_at` back 8 days in the DB and reopen: it re-checks.

## Commit
`feat(notebooks): flag broken links in notebooks`

## Rollback
Revert the commit. `notebook_link_status` rows stay and are ignored.
