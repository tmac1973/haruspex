# Phase 02 — The Page a Remote User Sees

One purpose-built page, served by phase 01. Not the app's UI: 19 files under
`components/`, `stores/` and `agent/` call `invoke()`, which does not exist in
a plain browser, so reusing them would mean reimplementing the IPC surface
over HTTP before a single message could be sent.

## Steps

### 1. Scope of the page

Hand-written HTML, CSS and a small script — no build step, no framework, no
bundle to keep in sync with the app's. It has to survive being opened by
someone who has never heard of Haruspex, on a phone, on a TV browser, one-handed
while a game is paused.

What it has:

- a message list, a text box, a send button
- streamed answers, rendered as plain text with minimal markdown (bold, code,
  links, lists — not the app's full renderer)
- a status line: connected, thinking, **waiting for the desktop**, error
- a stop button while a turn is running
- the host notice (step 3)

What it does not have: sidebar, settings, model choice, file upload, working
directory, microphone, tool output panels, search-step detail. Every one of
those is either meaningless remotely or an attack surface.

### 2. Streaming and status

The SSE stream carries four event kinds: `delta`, `done`, `error`, and
`queue`. The last is what makes contention legible rather than mysterious:
when the host is mid-turn on the local lane, the remote user sees "waiting for
the desktop…" instead of a spinner that looks broken. The queue snapshot
already contains this; the client is just rendering it.

Reconnection matters more here than in the app: a phone that locks its screen
drops the connection. The client reconnects to `/api/stream/:session` and the
server replays the in-flight turn's buffer, so a locked screen does not lose
the answer being written.

### 3. Say what this is

Near the input, permanently, not in a dismissible banner:

> Answers come from **<host name>**. Conversations are saved there and visible
> to whoever is using that machine.

Friends will assume a private chat window unless told otherwise. This is cheap
to state now and awkward to explain later, and it is the honest description of
a page that runs on someone else's computer, on their GPU, in their database.

### 4. Text-to-speech (optional, cheap)

Koko already serves an OpenAI-compatible API on port 3001, so this is a relay,
not synthesis work: a `POST /api/speak` that proxies text through to the
sidecar and streams the audio back, plus a speaker button per message.

Kept optional and last because it is the only part of this phase that can be
dropped without leaving a hole. If it slips, nothing else is blocked.

### 5. Tests

- Markdown rendering escapes HTML — the page renders model output, and the
  model output is attacker-influenceable via search results.
- SSE reconnect resumes an in-flight turn rather than starting a new one or
  showing a truncated answer.
- The queue event renders as "waiting", and clears when the turn starts.
- No token: the page renders the "needs a link" state and never the chat box.

## Verification

- Open it on a phone over WiFi, ask a question, watch it stream.
- Lock the phone mid-answer, unlock: the answer is complete, not truncated.
- Ask while the host is mid-turn: waiting state appears, then the answer.
- Read the page as someone who has never seen Haruspex — does it explain
  itself without a person standing next to you?

## As built (2026-08-17)

Three files under `src-tauri/src/remote/client/`, `include_str!`'d and served at
`/`, `/app.css` and `/app.js`. No build step, no framework, no bundle — the
page a guest gets is the file in the repo, byte for byte.

**Tested as it ships.** `src/lib/remote/client.test.ts` loads the real
`index.html` into jsdom and imports the real `app.js` from where Rust reads it,
then drives the page with a fake transport: 12 tests covering escaping, link
sanitising, streaming, the waiting state, reconnect-resume and the no-token
state. A test against a copy of the client would have passed while the served
page was broken.

**Reload works, via a cookie.** The plan had the client stash the token in
`localStorage`, which cannot work: the server gates `/` itself, so a reload
without `?t=` never reaches the JavaScript that would remember anything. A valid
link now sets `haruspex_remote` (`SameSite=Strict`, `HttpOnly`, one year), so a
bookmark or a home-screen shortcut still opens. `SameSite=Strict` is what keeps
that from being a CSRF hole; the JSON content type the API requires is the
second layer. An explicit token still beats the cookie, so rotating a link takes
effect immediately rather than after a guest clears their browser.

**Speech landed after all** — it was cheaper than expected. koko already speaks
an OpenAI-compatible dialect on loopback, so `POST /api/speak` is a proxy that
touches no Tauri state at all: relay to `127.0.0.1:3001`, wrap the raw PCM in a
44-byte WAV header (the sidecar returns headerless 16-bit mono at 24kHz, which
no `<audio>` element will play), stream it back. A host who has never turned TTS
on has no sidecar listening, and the guest gets "the host has not turned on
speech" rather than a hang. The button appears only on finished answers —
reading a half-written one aloud would synthesise a sentence about to change.

**Transcript is client-side for now.** The page keeps the last 50 messages in
`localStorage` so a reload is not amnesia. Phase 03 makes the conversation a
real database row and supersedes this; until then it is the only history there
is, and it is per-browser rather than per-host.

**The type checker now covers the client.** Importing `app.js` into a test pulls
it into the project's TypeScript program, which surfaced 51 findings. Rather
than silencing them, the file carries JSDoc types and materialises its DOM
lookups once behind an all-or-nothing guard — a page missing an element now
fails at boot instead of throwing halfway through a guest's first message.

## Still owed

Everything in Verification above is a manual check on real hardware, and none of
it has been done: no phone has opened this page. What the automated tests
establish is that the page's logic is right, not that it is usable one-handed on
a phone over WiFi.
