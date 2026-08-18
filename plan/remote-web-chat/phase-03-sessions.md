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
