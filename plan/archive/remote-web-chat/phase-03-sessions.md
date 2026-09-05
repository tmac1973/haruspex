# Phase 03 — Sessions, History, and More Than One Guest

Makes a remote session a real conversation rather than a series of unrelated
questions. Depends on phases 01–02.

## Steps

### 1. A conversation per client

A conversation is just a row — `id, title, created_at, updated_at` — with
messages hanging off it (`db/mod.rs:344`). A remote session creates one on its
first message and reuses it thereafter, which means the host sees it in the
sidebar, it persists across restarts, and it can be read, renamed or deleted
like any other thread. Nothing new to store, nothing new to back up.

Client identity is a random id the browser keeps in `localStorage`, minted on
first use. Not an account: it distinguishes "this browser" from "that browser"
so two guests do not land in one thread, and so a reload continues rather than
restarts.

Title them so their origin is obvious at a glance — `Remote — <client label>`,
where the label is whatever the guest typed on first connect (or "Guest" if
they typed nothing).

### 2. History and context

Remote turns run through `runEphemeralTurn`, which is single-turn by nature, so
the driver is responsible for building the message list from the conversation's
stored history — the same shape the chat store assembles, minus the pieces that
do not apply (no working-directory system prompt, no local file context).

**Context management is the part to get right rather than discover.** A guest
who chats for an hour will exceed the window exactly as a local user does. The
app already has compaction for the chat path; the remote driver either reuses
it or applies the simpler rule of trimming oldest-first, and the choice should
be made deliberately in this phase rather than left until someone's long
session fails.

### 3. More than one guest

Sessions are independent: separate conversations, separate histories, separate
SSE streams. Contention is the queue's business and is already handled — on the
local lane they take turns; on a parallel-capable backend they overlap.

Bound it: a maximum concurrent-session count, and an idle timeout after which a
session's stream is closed (the conversation stays). The failure this prevents
is not malice, it is four phones left open on a coffee table.

### 4. Tests

- Two clients get two conversations; neither sees the other's history.
- A reload with the same client id continues the same conversation.
- A conversation created remotely appears in the local list and opens normally.
- Trimming/compaction keeps a long session working rather than erroring at the
  context limit.

## Verification

- Two browsers, two questions, two threads, both readable locally afterwards.
- Chat long enough to cross the context window and confirm the session survives.

## As built (2026-08-17)

**The conversation id is derived, not stored.** `remote-<sessionId>`, so there
is no session→conversation map to keep, and nothing to lose when the host
restarts Haruspex: a guest who comes back tomorrow lands in their own thread
because the id falls out of the id their browser already had. This needed one
change elsewhere — `create_conversation` is now `INSERT OR IGNORE`, since "create
it if it isn't there" is the honest operation when the same id legitimately
recurs. Local chat mints a fresh UUID per conversation and is unaffected.

**Context management: summarise, with trimming as the safety net.** The plan
left this choice open. It reuses the app's own summariser, so a guest's
conversation keeps its meaning rather than silently losing its beginning — and
it runs **inside the inference slot**, because summarising is itself a model
call and running it outside the queue would let a guest collide with the person
at the keyboard, which is the exact thing the queue exists to prevent.

The fallback matters more than the summary. If the summary call fails — model
stopped, backend unreachable — the alternative to trimming oldest-first is a
turn that dies at the context limit while the guest watches. So a failed summary
drops the oldest turns and carries on, and the rewritten history is persisted so
the next turn does not pay for it again.

**The guest is asked their name once**, before their first message, with a Skip
button — a guest who would rather not say should still get an answer. The label
is bounded and stripped of control characters in Rust *and* when the title is
built, because it lands in the host's sidebar and in log lines.

**Threads appear live in the host's sidebar.** The driver creates conversations
outside the chat store, so without `noteExternalConversation()` a guest could
talk to the machine for an hour with no sign of it in the UI until the next
launch.

**A stopped answer is saved too.** The partial text goes into the history, not
just onto the guest's screen — a history that omitted the answer they can see
would make the next turn incoherent.

**Bounds were already in place** from phase 01: eight concurrent sessions, and a
15-minute idle timeout that drops the session. The conversation stays, because
it is a database row and not session state.

## Still owed

The two verification items are manual and undone: two browsers side by side, and
a session long enough to cross the context window. The summarise-and-trim path
is unit-tested against a stubbed summariser, which is not the same as watching a
real conversation cross a real context limit.
