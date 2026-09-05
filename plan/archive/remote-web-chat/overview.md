# Remote Web Chat

Locked 2026-08-17.

## Problem

Haruspex is good at answering questions about the game you are playing, and
useless for it at the same time: the model wants the GPU the game is using. The
answer most people already have is a second machine in another room — but
reaching it means standing up Ollama or LM Studio and pointing a client at it,
which is not a thing a non-technical friend will do.

So: let Haruspex serve a small chat page over HTTP on the LAN. The gaming PC
opens a browser, types a question, and the answer comes from the Haruspex
running on the other machine. No install, no config, no command line — and
because the client is a browser, a phone or tablet works as well as a PC.

Scope is deliberately narrow. No microphone, no working directory, no shell, no
service or daemon mode: the user walks to the other machine, starts Haruspex,
and leaves it running. The local UI keeps working normally throughout.

## The structural fact that decides the design

**All model orchestration lives in the webview, in TypeScript.** `runAgentLoop`,
tool dispatch, streaming and compaction are frontend code; Rust holds sidecars,
the database, egress and admission control. Even the email sub-agent's
completion call is in TypeScript, and its module comment says why: "so it can
reuse the existing local-vs-remote inference routing."

That rules out both obvious designs:

- **Porting the loop to Rust** would fork the most load-bearing code in the app.
- **Serving the existing SvelteKit UI to a remote browser** looks free and is
  not: 19 files under `components/`, `stores/` and `agent/` call `invoke()`,
  and in a plain browser there is no Tauri IPC. It would mean reimplementing
  the command surface over HTTP.

What remains is the one that fits the codebase: **a thin client, with the local
app doing all the thinking.** Rust serves a purpose-built page and relays
messages; the webview runs the turn exactly as it does today.

## What already exists

More than expected, because the app was built for multiple windows:

- **Admission control is already process-wide and in Rust.**
  `InferenceQueue` (`inference_queue.rs`) exists precisely because "a
  per-webview JS semaphore can't coordinate once shells are detached into their
  own windows". Lane `local` has capacity 1, so a remote turn arriving during a
  local one *queues* with no new work. Remote/OpenRouter lanes follow
  `descriptor.allowParallel`, so parallel-capable backends already run
  concurrently. This is the concurrency requirement, already built.
- **The queue already broadcasts what the UI needs.** Every state change emits a
  full snapshot on `inference://queue` to every window, carrying each ticket's
  consumer and whether it is waiting or running — the data behind both the
  local indicator and the remote client's "waiting for the desktop" line.
- **Orphan cleanup already covers this shape.** A window-destroyed listener
  drops that window's tickets, with a 5-minute lease as a backstop for a holder
  that stops heartbeating.
- **There is a UI-less turn runner.** `runEphemeralTurn` — what jobs use —
  takes a message, a `toolAllowlist`, streaming callbacks and a backend
  override. A remote turn is a natural fit for it.
- **"Is a human present" is already modelled.** `ToolContext.interactive`
  exists, and `code.ts` *denies* risky shell commands when non-interactive
  rather than parking on a modal, so a remote user cannot stall the host on an
  approval dialog.
- **TTS would be a relay, not new work.** Koko already serves an
  OpenAI-compatible HTTP API on port 3001.

## Not a mirror

Remote and local sessions are independent. The chat store is singleton-shaped
around one active conversation — `getIsGenerating`, `getStreamingContent` and
`getSearchSteps` are global — so feeding a remote prompt into the local
session would have two turns fighting over one streaming buffer.

Each remote client therefore gets **its own conversation**, which is just a row
in `conversations` with messages hanging off it: it appears in the local
sidebar, persists, and can be read like any other thread. Live visibility comes
from a read-only **Remote activity** panel fed by the driver that is already
holding the deltas — no store surgery. Watching a remote thread stream *inside
the chat tab* would require making the chat store per-conversation, which is the
largest single piece of work available here and is deliberately out of scope.

## Goals

- A non-technical user opens a link on another machine and can ask questions.
- The local user keeps using Haruspex normally, at the same time.
- Collisions behave per backend: local inference queues the later turn with a
  visible-but-quiet notice; a parallel-capable remote backend runs both.
- The host can see who is connected and what is being asked, and can read the
  full conversations afterwards.
- Remote users get no filesystem, no shell, and no way to stall the host on a
  modal.
- Turning it off is one switch, and off is the default.

## Non-goals

- **Service / daemon mode.** Decided: the user starts the app by hand. Revisit
  only if the feature proves itself.
- **Mirroring a session between local and remote.** See above.
- **Microphone input** and **local working directories** for remote users.
- **HTTPS with a real certificate.** A self-signed cert on a LAN produces a
  browser warning that would defeat exactly the audience this is for. v1 is
  HTTP on the local network with a token, and the UI says so plainly rather
  than implying privacy it does not have.
- **Internet exposure.** LAN only. No port forwarding, no tunnel, no advice
  encouraging either.
- **Making the chat store per-conversation.** The prerequisite for in-tab live
  mirroring; not needed for anything here.

## Shape

| Phase | Theme | Notes |
|---|---|---|
| [00](phase-00-spike.md) | Does a backgrounded webview keep running? | Answer first — the whole design rests on it |
| [01](phase-01-server-and-relay.md) | HTTP server, token auth, SSE, the relay, the remote turn driver | The bulk of the Rust work |
| [02](phase-02-thin-client.md) | The page a remote user actually sees | Purpose-built, not the app's UI |
| [03](phase-03-sessions.md) | A conversation per client, history, multiple clients | |
| [04](phase-04-settings-and-visibility.md) | Enable switch, token, connected clients, activity panel | |

## Decisions taken

- **Thin client, local brain.** The alternatives are a Rust port of the agent
  loop or an HTTP reimplementation of 146 IPC commands. Neither is worth it for
  a chat box.
- **Separate conversations, not a shared session.** The store's shape says so,
  and the product argument agrees: two people should not land in one thread.
- **Off by default, and explicit about what it is.** The page tells remote users
  their conversations are visible on the host. Friends assume a private window
  unless told otherwise, and that is cheap to get right now and awkward later.
- **HTTP with a token, not HTTPS.** Certificate warnings would stop the exact
  users this exists for. The honest trade is stated in the UI rather than
  papered over.
- **The parallel-capacity gap is fixed separately, first.** The queue treats
  parallel lanes as *unbounded* rather than capped at the server's advertised
  slots, so a toolchest server reporting four slots will accept a fifth request
  and queue it internally where nothing can report it. The slot count is
  already collected (`remoteParallel`, currently display-only). That is a small
  standalone improvement to the existing app and should not wait behind this
  feature — see phase 00.
- **Remote turns run through `runEphemeralTurn`,** not the chat store, so they
  cannot disturb the local session's state.
