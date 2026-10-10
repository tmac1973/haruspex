# Phase 4 — The web client: Code sessions in a browser

**Depends on:** 3 · **Guide:** `remote-control`; `settings` (one line)

## Goal

The owner opens a page on another device (over Tailscale, say) and carries on
with the Code sessions running on their desktop: see the list, follow a
session as it runs, send and steer, stop, answer approvals and questions.
Turns run on the desktop, as always (overview decision 2).

## Decision changed

**Overview decision 8 ("the real Svelte components") is narrowed** (owner,
2026-10-09). Mapping the Code tab showed that its shell (header, transcript,
composer, sidebar, tab strip, branch control, background chip) talks to the
desktop throughout: git, folder dialogs, editor windows, skills, TTS,
claims. Reusing it whole meant either forwarding raw Tauri commands over
HTTP (shell and filesystem access, refused) or refactoring about 12 working
desktop components.

So the web client **shares the render pieces and has its own small shell**:

- **Shared:** `renderMarkdown`, `CodeSteps` (and through it `CommandCard`,
  `DiffCard`, `SearchStep`'s step rendering), `ThinkingPanel`,
  `ContextGauge`, `StopIndicator`, `ThinkingIndicator`, `Modal`.
- **Its own:** the session list, the transcript wrapper, the composer, the
  prompt cards, the connection bar.
- **The desktop UI does not change,** beyond one optional prop.

## Decisions

| #   | Question                  | Decision                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Build                     | **A plain Svelte + Vite app** (`src/web/`, `vite.web.config.ts`), not a second SvelteKit build: no layout bootstrap, no `build/` clash. It imports `#lib/...` like the app. The output goes to `src-tauri/web-client/` (gitignored).                                                                                                         |
| 2   | Serving                   | **The owner API serves it at `/app/`**, from the bundled resource `web-client/` (`tauri.conf.json` `bundle.resources`). `GET /` redirects there.                                                                                                                                                                                             |
| 3   | Pairing                   | **Add device also gives a one-time link and QR code**, valid for 10 minutes. The code rides in the URL _fragment_, so it never reaches a server log or the history's request line. The page swaps it for an `HttpOnly; SameSite=Strict` cookie holding the device token, plus `Secure` when the request came over HTTPS (`tailscale serve`). |
| 4   | CSRF with cookies         | **A cookie-authenticated request must send `X-Haruspex: 1`** (a custom header, which forces a CORS preflight that this server never answers), and the Origin rule from phase 3 still applies. Bearer requests are unchanged.                                                                                                                 |
| 5   | Events in the browser     | **`EventSource` on `/api/v1/events`**, with the cookie. On `ready` the page re-reads every session it follows; on a `seq` gap it asks for `session.resync`.                                                                                                                                                                                  |
| 6   | `open_in_shell` from afar | **Unchanged behaviour.** The turn waits for the command to be run in a desktop Shell tab; the page shows what it waits on and offers Cancel (`session.cancelShellWait`).                                                                                                                                                                     |
| 7   | File links                | **Not links.** `CodeSteps` gets an optional `onOpenFile` prop; the web client passes one that does nothing (and paths render as text). The desktop keeps opening the editor.                                                                                                                                                                 |
| 8   | Images                    | **Not in v1.** A message image shows as "image on the desktop". Serving the image cache over the API is a follow-up.                                                                                                                                                                                                                         |
| 9   | New session               | **A folder path typed or picked from recent ones** (roots of saved sessions). The desktop checks it exists. No file browser.                                                                                                                                                                                                                 |
| 10  | CSP for `/app/`           | `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'`.                                                                                                                                                                                                |

## 1. Rust (`src-tauri/src/owner/`)

- **`pairing.rs`:** `PairingCodes`, an in-memory map `code -> (client_id, token, expires)`.
  - `issue(client, token) -> code` (24 random bytes, hex).
  - `redeem(code) -> Option<token>`, which is one use only and refuses after expiry.
  - Expired codes are swept on each call.
- **`owner_client_create`** also returns `pairCode` (and the UI builds the link `http(s)://<address>:<port>/app/#pair=<code>`). `owner_client_pair { id }` issues a fresh code for an existing device. The token isn't kept, so this mints a new token for it, and the old one stops working.
- **Server:**
  - `POST /api/v1/pair {code}` (open, throttled like a wrong token) answers `Set-Cookie: haruspex_owner=<token>; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000[; Secure]`, plus `{ ok }`.
  - `POST /api/v1/logout` clears it.
  - **Auth:** a bearer token, else the `haruspex_owner` cookie _with_ `X-Haruspex: 1` (else 403 "missing X-Haruspex header").
  - **`GET /app/*`:** static files from the resource dir, or the dev fallback `<manifest>/web-client` in debug builds. Content types by extension, `index.html` for unknown paths (SPA), the CSP above, and `Cache-Control: no-cache` for `index.html` (hashed assets cache forever).
  - Path traversal is refused: paths are normalised, `..` is rejected, and the result must stay under the root.
- `GET /` redirects to `/app/`.

## 2. The web client (`src/web/`)

- **`main.ts`:** mounts `App.svelte`. It imports `src/app.css` for the theme tokens and sets the theme from `prefers-color-scheme`.
- **`api.ts`:**
  - `op(op)` is a `fetch POST /api/v1/op` with `credentials: 'same-origin'` and `X-Haruspex: 1`.
  - `events(onEvent, onState)` wraps `EventSource` (auto-reconnect; `ready` triggers a resync).
  - `pair(code)`.
- **`sessions.svelte.ts`:** a `Mirror` per followed session (phase 2's `reduce`), the session list, and prompts by id from prompt events.
- **Components:**
  - `App` (pairing screen when there's no cookie, else the list and the session)
  - `SessionList` (open first, then saved; New session with folder input)
  - `SessionView` (header: title, folder, status, `ContextGauge`; transcript; shell-wait banner; prompt cards; composer)
  - `Transcript` (user and assistant messages via `renderMarkdown`, reasoning via `ThinkingPanel`, steps via `CodeSteps` from `messageSteps` / `searchSteps`, live text)
  - `Composer` (Send, which steers while running; Stop)
  - `PromptCard` (command: Allow once / Allow for this session / Deny; question: options plus free text; others: "Answer this at the desktop")
- **Layout:** one column on phones (the list becomes a back button), two columns from 900 px.
- **`npm run build:web`** builds it; `npm run dev:web` runs a dev server proxying `/api` to `127.0.0.1:8788`.
- **`tauri.conf.json`:** `beforeBuildCommand` becomes `npm run build && npm run build:web`, and the resource is `web-client/`. `scripts/ci-placeholder-sidecars.sh` makes `src-tauri/web-client/` for CI's Rust jobs.

## 3. Settings and guide

- **Settings → Remote control:** after Add device, show the **link and QR code** (reusing `remote_link_qr` and `qrPath`) next to the token, with "Opens on one device, within 10 minutes." Each device gains **New link**.
- **Guide `remote-control`:** "Use it from a browser" replaces "no web page yet"; what the page does and doesn't do (no images, no file links, no Shell, no chat).

## Tests

- **Rust:**
  - a code redeems once and not after expiry;
  - `/api/v1/pair` sets the cookie (`Secure` only with `X-Forwarded-Proto: https`);
  - cookie auth needs `X-Haruspex`;
  - a cookie on a cross-origin request is refused;
  - `/app/` serves `index.html` with the CSP, and an asset with its content type;
  - `/app/../secrets` and encoded traversal get 404;
  - `/` redirects.
- **Web (vitest, jsdom):**
  - `sessions.svelte.ts` folds events and resyncs on a gap;
  - `PromptCard` answers with the shown `promptId`;
  - `Composer` sends, then steers while busy;
  - pairing reads the fragment and clears it from the address bar.
- **Playwright** (`e2e/web/`): the built web client against a fake owner API (a small Node server replaying engine events): pair, open a session, send, approve, and see the turn finish.
- **Driver:** `drive web-url` prints a pairing link for the running test app, so the web client can be checked by hand, or with the browser pane, against a real model.

## Done when

From a phone browser on the tailnet, the owner can pair once, then open a Code session running on the desktop, send a message, approve its command, and watch it finish. The desktop's own UI is unchanged.

## As built (2026-10-09)

Branch `remote-api/p04-web-client`. Differences from the plan above:

- **Events are read with `fetch`, not `EventSource`.** `EventSource` can't
  send `X-Haruspex`, and the server keeps that rule for every
  cookie-authenticated request, `GET /api/v1/events` included. `api.ts`
  parses the stream and reconnects with backoff (0.5 s, doubling to 10 s).
- **Settings → Remote control → Link address** (`ownerApiLinkBase`). It's the
  address put in pairing links and QR codes, needed behind `tailscale serve`,
  where other devices use the tailnet name rather than `127.0.0.1`.
- **The app's global styles moved** from `+layout.svelte`'s `:global` rules
  into `src/lib/styles/app.css` (unchanged apart from dropping the wrapper),
  so the web client shares the theme tokens and the `.btn` / `.field` /
  `.toggle-row` classes. The highlight.js dark colours stayed in the layout.
- **Continue** after a forced stop sends the desktop's own "Please continue"
  message.
- **A session closed on the desktop** stays on screen with "Closed on your
  computer" and **Open it again**. A session moved to another window picks
  up from that window's first snapshot.
- **No Playwright suite for the web client.** It's covered by:
  - 10 vitest cases (`src/web/web.test.ts`);
  - 6 checks in the driver's self-test (served page and CSP, pairing once,
    cookie needs `X-Haruspex`, listing);
  - one hand check in a browser, against the owner's vLLM server: pair, run a
    turn, deny an `rm -rf`, then the phone layout.
- **Bundle size:** 571 kB (190 kB gzipped). `CodeSteps` → `SearchStep` pulls
  in the chat store and much of the agent. Splitting `SearchStep`'s render
  from its actions would shrink it; it's a follow-up, not a blocker on a
  tailnet.
