# Phase 5 — Chat in the web client

**Depends on:** 4 · **Guide:** `remote-control`

## Goal

From the web page, the owner reads the desktop's chats and carries one on:
send a message, watch the answer, stop it, continue or retry, and answer the
prompts a chat turn raises. Turns run on the desktop, through the desktop's
own chat, so everything chat does still works: tools, the working folder, the
Python sandbox, images, memory.

## What exists (from `origin/main`, 2026-10-10)

- **The chat store** (`stores/chat.svelte.ts`) runs **one turn at a time for
  the whole app**:
  - Its turn state is global: `isGenerating`, `streamingContent`, the error
    banner, the stop control.
  - A turn writes to the conversation it started in. The sandbox and memory
    look up the *open* conversation (`getActiveConversationId()`) as they
    run, so a turn has to stay in the conversation that's open.
- **Persistence:** `db_list_conversations`, `db_get_conversation` (messages
  with each answer's steps), and the `db.ts` wrappers. Stats, stops and
  source URLs aren't stored.
- **Remote chat's guest driver** (`remote/driver.ts`) runs its own reduced
  turns (web tools only). It isn't a base for this; see the decision below.

## Decision

**The page drives the desktop's chat** (owner, 2026-10-10). Splitting the chat
store per conversation, which would allow several chats at once, was the
alternative. It was turned down as the riskiest change in the plan, for a
benefit only someone using both screens at once would see.

What follows from it:

- **Sending opens that chat on the desktop.** `chat.send` makes its
  conversation the open one (`setActiveConversation`) and calls
  `sendMessage`, exactly as typing there would. The desktop's chat tab
  follows the page.
- **One chat turn at a time, as today.** While a turn runs, sending to
  *another* chat is refused ("A reply is being written in <title>; stop it
  or wait"). Sending to the same chat steers nothing: chat has no steering,
  so it's refused too while busy.
- **Reading never moves the desktop.** `chat.get` for a chat that isn't open
  loads it from the database without opening it.

## 1. Engine (webview, main window)

Chat lives in the main window only. A `chat.*` op names no Code session, so
the hub's existing routing sends it to `main`.

| Op | Does | Scope |
|---|---|---|
| `chats.list` | Every conversation: `{id, title, updatedAt, open, busy}` | read |
| `chat.get {id}` | `ChatState` (below): live if it's the open chat, else from the database | read |
| `chat.new` | `createConversation()`, returns `{id}` | drive |
| `chat.send {id, text}` | Open it if needed, then `sendMessage`; `{started}`, or refused while another chat runs | drive |
| `chat.stop {id}` | `cancelGeneration`, if `id` is the open chat and busy | drive |
| `chat.continue {id}` / `chat.retry {id}` | `continueTurn` / `retryLastTurn`, open chat only | drive |
| `chat.resync {id}` | A fresh snapshot event | read |

`ChatState`:

- `id`, `title`, `messages`, `messageSteps`, `messageStats`, `messageStops`;
- `open`, `busy`, `waitingForSlot`, `compacting`, `streamingContent`,
  `searchSteps`, `error`, `lastTurnFailed` (live only when it's the open
  chat);
- `contextUsage`, `workingDir`, `memoryEnabled`.

**Events.** A watcher on the chat store, built like the Code session
watchers: it compares against captured values and coalesces live text. It
follows the *open* chat and emits `chat-snapshot`, `chat-status`,
`chat-live`, `chat-steps` and `chat-meta` events keyed `chatId`, with a seq
per chat. When the open chat changes, the old one gets a final snapshot and
the new one a first snapshot. The pure reducer becomes generic, so the page
rebuilds chats and Code sessions the same way.

**Prompts.** `prompts.list` gains two answerable kinds: `sandbox` (Run this
Python? — Allow once / Allow for this chat / Deny) and `memory` (Remember
this? — Allow once / Allow for this session / Deny). `question` already works.
MCP and skill prompts stay answered at the desktop.

## 2. Owner API

The scope table (`owner/clients.rs`) learns the new ops. Nothing else changes:
chat events ride the same event stream.

## 3. Web client

- **The sidebar** gets two tabs, **Code** and **Chat**. Chat lists
  conversations newest first, marks the open one and a running one, and has
  **New chat**.
- **A chat view:**
  - a header with title, context gauge and working folder (read-only, with a
    tooltip that it's set on the desktop);
  - a transcript of messages, with each answer's steps rendered by
    `SearchStep`, stats, and Stop / Continue / Retry the way the desktop shows
    them;
  - prompt cards;
  - a composer that sends, or is disabled with a tooltip while another chat's
    turn runs.
- **Not in v1:** attaching images, deep research, the incognito switch,
  slash commands and the microphone. Each is a desktop composer control and
  a follow-up.

## Tests

- **Engine (vitest, with the chat store's module mocked at the Tauri
  boundary, as `chat.test.ts` does):**
  - `chat.send` opens the chat and sends;
  - a send to another chat while busy is refused;
  - `chat.get` for a chat that isn't open doesn't change the open one;
  - events rebuild the open chat mid-stream and after the turn is saved;
  - switching the open chat closes one mirror and opens the other.
- **Prompts:** sandbox and memory prompts list with their kind and answer
  only the one showing.
- **Owner scopes:** the new ops.
- **Web:** the store's chat list and mirror, the chat composer's disabled
  state, and the prompt cards for sandbox and memory.
- **Driver:** `drive chat-send` and the self-test, with a chat turn through
  the API against the fake model.

## Done when

From another computer's browser, the owner opens a past chat, sends a
message, approves the Python it wants to run, and watches the answer finish,
while the desktop's chat tab shows the same conversation.

## As built (2026-10-10)

Branch `remote-api/p05-chat`. As planned, with these notes:

- **The chat watcher reads the open chat inside every effect.** The first
  version kept it in a plain variable. In a fresh profile, with no chat
  open, the effects' first runs returned before reading anything reactive,
  so they tracked nothing and never ran again: the page got the first
  snapshot and no updates. Found in the browser check; there's now a test
  that starts with no chat open.
- **`chat.send` reports a refusal.** `sendMessage` resolves only when the
  turn ends; a refusal (the model not ready) resolves `false` at once, so the
  engine races it against 150 ms.
- **`SearchStep` takes `runControls`.** The page hides the sandbox's Cancel
  and Run again, which would run Python in the browser.
- **The prompt filters changed.** Chat prompts (sandbox, memory) carry
  `chatId`; a Code session's view shows only prompts without one, and a
  chat's view only its own.

**Checked:**
- 11 chat engine tests (with a fake chat store over Svelte state); sandbox
  and memory prompts in `engine.test.ts`; the web store's chat mirror and
  prompt filters; the composer and sandbox card.
- The driver self-test: a chat turn over HTTP against the fake model.
- In a browser against the owner's vLLM server: New chat, a message asking
  for Python, **Run this Python?** answered from the page (Allow once, then
  Deny), the reply streamed, and the desktop's chat tab showed the same
  conversation. (The test build had no Pyodide, so the Python itself failed;
  that's the build, not the feature.)
