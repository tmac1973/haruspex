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
