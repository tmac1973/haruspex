# Phase 2 — One engine surface for Code sessions

**Depends on:** 1, Code tab phase 7 (claims; merged) · **Guide:** none (`no-docs`)

## Goal

Everything a client other than the window's own UI may do with a Code
session goes through one place: a **dispatcher** that takes plain-JSON
operations and a stream of plain-JSON **events** describing each session.
Phase 3 carries both over HTTP and a WebSocket. Phase 4's web client
rebuilds a session from the events. The driver moves onto it here, so its
tests exercise the surface the API will expose.

**The desktop UI does not change** (decided 2026-10-09). It keeps reading
`CodeSession` directly. The engine _watches_ the same store and turns what it
sees into events, and a test proves the events rebuild the session the store
holds.

## What exists (from `origin/main`, 2026-10-09)

- **`CodeSession`** (`stores/code.svelte.ts`, line 95) holds every field the
  UI renders as `$state`: `status`, `messages` / `messageSteps` / `messageStats`
  / `messageStops`, `searchSteps`, `streamingContent` / `roundText` (from
  `LiveTurn`), `steering`, `usage`, `lastError`, `saveError`, `folderMissing`,
  `background`, `shellWait`, `title`, `backend`, `effort`, `git`, `fileNotes`.
  - The methods are `send` (which steers when busy), `stop`, `cancelShellWait`,
    `setBackend` / `setEffort` / `rename` and `snapshot()`.
  - The registry has `openSession` (claims, or raises the owning window),
    `newSession`, `closeSession`, `forkSession`, `handOffSession` and
    `deleteSession`.
- **Each window is its own JS world.** It has its own registry, approval
  queues and watch list. Ownership lives in Rust (`code_tools/claims.rs`:
  `code_session_claim` / `release`, `code://claims`), and a dead window's
  claims are dropped on `WindowEvent::Destroyed` (`lib.rs`).
- **Prompts a Code turn can raise**, each per window:
  - command approval (`codeCommandApproval`, a FIFO queue, `requester` is a
    display label);
  - `ask_user_question` (`userQuestion`, single slot);
  - MCP tool approval (`mcpApproval`, single slot);
  - skill writes (`skillApproval`, queue);
  - repo trust (`askRepoTrust`, before the turn);
  - `open_in_shell` waits (`shellWait`, status `waiting-shell`).
- **Relay precedent:** `remote/relay.rs` + `remote/driver.ts`. The webview
  sends the _full_ text so far and Rust derives suffixes; the client sees a
  snapshot first, then events; `TextPump` keeps one invoke in flight.
- **Window ↔ window precedent:** `code/shellRelay.ts`, with `emitTo(label)`,
  `reqId = "<label>:<seq>"` and a 5 s ack timeout.

## 1. The engine module (`src/lib/engine/`)

One instance per window, started from `+layout.svelte` and from
`routes/code/[id]/+page.svelte`, the way `agentModals` are. It imports the
code store; the store never imports it.

### Operations

`dispatch(op): Promise<result>`. Each op is `{ type, ...args }` and each
result is JSON. An op names a session by id and never by folder.

| Op                                      | Does                                                                               | Notes                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `sessions.list`                         | Open sessions in every window plus saved ones: `{id, title, root, status?, owner}` | Saved list from `code_sessions` in the db; `owner` from `code_session_open_ids`                                |
| `session.get {id}`                      | `SessionState` (below)                                                             | The same JSON `driveHooks.codeSessions` builds today, moved here                                               |
| `session.open {id}`                     | Open in this window, or report the owner                                           | Unowned sessions open in the **main** window                                                                   |
| `session.new {root, backend?, effort?}` | `newSession`                                                                       | Same folder rules as the dialog (`releaseFolder`, one writer per folder)                                       |
| `session.send {id, text}`               | `session.send(text)`                                                               | Busy → becomes steering, as the composer does. Returns `{started}` or `{steered}`                              |
| `session.stop {id}`                     | `session.stop()`                                                                   |                                                                                                                |
| `session.cancelShellWait {id}`          |                                                                                    |                                                                                                                |
| `prompts.list`                          | Every pending prompt in this window (below)                                        |                                                                                                                |
| `prompts.answer {promptId, answer}`     | Resolve that prompt                                                                | Fails if `promptId` isn't the one showing, so a stale answer from a second screen can't answer the next prompt |

Not in v1: rename, fork, delete, close, backend/effort changes and background
process control. They are easy to add later, and none is needed to carry on
working remotely.

### Prompts

Give each prompt a `promptId` (`<window label>:<seq>`), a `kind` and a
`sessionId`. Only `command` and `question` can be answered through the
engine. The others are reported with `answerable: false` ("answer at the
desktop").

- **`command`** — needs `sessionId` on `CommandApprovalRequest`.
  `askAboutCommand` has the session's `approvalKey` (`code:<id>`); pass the
  id alongside `requester`. **This is the one change to the existing stores.**
- **`question`** — `userQuestion`'s pending slot. Code turns pass no
  `askUser`, so it's the global store; give it the session id the same way.
- **`mcp`, `skill`, `repo-trust`** — listed so a remote client can say why a
  turn is stuck. Answering them remotely is a follow-up.

### Events

`subscribe(listener) → unsubscribe` for every session in this window. Each
event is `{ seq, sessionId, type, ... }`, where `seq` counts per window.

| Type                        | Payload                                                                                                              | When                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `snapshot`                  | full `SessionState`                                                                                                  | On subscribe; after a turn is saved; when asked (`resync`)                       |
| `status`                    | `{status, busy}`                                                                                                     | `status` changes                                                                 |
| `live`                      | `{streamingContent, roundText}`                                                                                      | Coalesced: at most one per 50 ms, latest wins, a final one before `status: idle` |
| `steps`                     | `{searchSteps}`                                                                                                      | The step list changes (start, progress, done, with diffs)                        |
| `meta`                      | `{title, usage, lastError, saveError, folderMissing, steering, background, shellWait: {shellName, command} \| null}` | Any of those change                                                              |
| `prompt` / `prompt-cleared` | the prompt / `{promptId}`                                                                                            | Queue changes in this window                                                     |
| `closed`                    | `{}`                                                                                                                 | Session disposed or handed to another window                                     |

How events are produced:

- Each session gets an `$effect.root` that reads the fields for one event
  type and emits when they change. It reads only public `$state` and getters,
  and adds no callbacks to `CodeSession`.
- The thread itself (`messages` and friends) is sent only in `snapshot`
  events. It changes when a turn commits, which is followed by `persist()`,
  so "turn saved → snapshot" covers it. Between snapshots, `live` and `steps`
  carry the turn in progress.
- Full text, not suffixes, as in the relay: the engine is authoritative and
  clients never patch text.

### The reducer (`engine/reduce.ts`)

`reduce(state | null, event) → state` is pure and shared. It is what phase 4's
`RemoteCodeSession` is built on, and what the consistency test runs. A `seq`
gap means "ask for a snapshot", never "guess".

## 2. Routing across windows (Rust: `src-tauri/src/engine/`)

The webview half can't reach a session that another window owns, so ops go
through a small Rust hub, which phase 3's HTTP handlers will also call.

- **`engine_request(op)`** (Tauri command, and a Rust fn for phase 3):
  - Find the target window: the claim owner for the op's session, otherwise
    `main`. Ops with no session (`sessions.list`, `session.new`) go to `main`;
    `prompts.list` asks every window and merges the answers.
  - `emit_to(label, "engine://op", {reqId, op})`, then wait on a oneshot keyed
    by `reqId`.
  - Timeout of 10 s for everything except `session.send`, which answers once
    the turn has _started_. "No window can answer" is an error, never a hang
    (as `a_prompt_nobody_can_run_fails_instead_of_hanging`).
- **`engine_reply {reqId, result | error}`**: the webview's answer. Unknown or
  late `reqId`s are dropped.
- **`engine_events {events}`**: each window pushes its events, batched per
  animation frame. Rust stamps them with the window label and re-broadcasts
  them on a `tokio::broadcast` (capacity 256, like the relay). A lagging
  subscriber gets told to resync. Phase 2 has no subscriber outside tests and
  the driver; phase 3's WebSocket is the real one.
- **Gate:** every engine command is a no-op unless the owner API is enabled
  (phase 3's setting) or the build is an e2e build. Phase 2 lands with only the
  e2e gate, so a normal build does nothing new.
- `./scripts/export-ipc-types.sh` for the new commands and the `SessionState` /
  event types (`#[ts(export)]`), so the TypeScript and Rust shapes can't drift.

## 3. The driver moves onto it

- `window.__haruspexDrive` gains `engine(op)` (calls `engine_request`, so it
  goes through Rust like phase 3 will) and `engineEvents(since)` (a ring
  buffer of the last 2,000 events this window received). `codeSessions`,
  `activateSession` and `pendingApproval` become thin wrappers over engine ops.
- `drive send`, `approve` and `cancel` keep pressing the UI by default.
  `--via engine` uses the ops instead. The self-test runs one turn each way.
- `drive state` reads `session.get`. `drive events [--since N]` prints the
  event log.

## Tests

- **Consistency (the point of "keep the store"):** a vitest that runs a
  `CodeSession` through a scripted `runCodeTurn` (mocked as in
  `runCodeTurn.test.ts`): text deltas, two tool calls with progress and a
  diff, steering, then commit. It collects the engine's events and checks that
  `reduce` over them equals `session.get` at three points: mid-stream, mid-tool
  and after save. Repeat with a stop mid-turn and with a turn error.
- **Reducer:** a `seq` gap asks for a resync; `closed` drops the session; a
  snapshot replaces everything.
- **Prompts:**
  - answering with a stale `promptId` fails;
  - two queued command prompts come out in order with the right `sessionId`;
  - a stopped turn clears its prompt (`prompt-cleared`).
- **Rust hub:** routes to the owner, unowned to `main`, and a dead owner to
  `main`; times out; ignores unknown `reqId`s; tells a lagging subscriber to
  resync; and does nothing when gated off.
- **Self-test:** adds a `--via engine` turn and an approval answered through
  `prompts.answer`. It checks that the event log reduces to `drive state`'s
  session, which is the same consistency check against the real app.
- **Detached window:** the driver detaches a session (`detachSession`), then
  sends to it with `--via engine`. The turn runs in the detached window, and
  the main window's driver sees its events through the Rust hub.

## Done when

- Through `drive --via engine`, Claude can list, open, start, steer, stop and
  watch a Code session, and answer its command approvals, including one that
  lives in a detached window.
- The event stream rebuilds the same session the store holds.
- A normal build exposes nothing new.

## Throttling (carried over from phase 1)

Checked on the owner's real desktop (GNOME, `--show`), 2026-10-09: the same
~1,520-token reply took 5.2–5.3 s minimised and 5.2–5.5 s visible. There is no
throttling, so this phase needs no fix for it.
