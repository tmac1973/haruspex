# Plan: Shared Rust Inference Queue → Multi Shell Tabs → Detachable Shell Windows

## Goal

Allow several shell sessions open at once — first as tabs inside the main window,
then detachable into their own OS windows — all sharing the single local
`llama-server` sidecar (port 8765) with cross-window prompt queueing.

The work is sequenced so each phase is independently shippable and de-risks the
next:

1. **Phase 1 — Move the inference queue into Rust** (shared across all webviews).
2. **Phase 2 — Multiple shell tabs** inside the main window.
3. **Phase 3 — Detach a shell tab** into its own OS window.

## Decisions (locked)

| Topic | Decision |
|---|---|
| Queue mechanism | **Rust semaphore gate.** Rust owns slot-grant + ticket registry only. Frontend `invoke('inference_acquire')` → awaits → keeps doing its **own** streaming `fetch` to :8765 → `invoke('inference_release')`. Rust broadcasts queue state via a Tauri event. Streaming/SSE path is untouched. |
| Orphaned slot cleanup | **Both:** primary reclaim via window-destroyed listener (release everything owned by that window label); backstop via a **heartbeat-refreshed lease** so a legitimately long multi-tool turn cannot be falsely reclaimed. |
| Shell tabs UI | **Sub-tab strip inside the Shell view.** Main TabBar (Chat / Jobs / Shell) unchanged; selecting Shell shows a secondary strip of shell tabs with a `+` button. |
| Detach model | **Move out + re-attach.** Detaching removes the tab from the main strip; PTY + chat state live on in a new window showing just that shell. Re-attach (or closing the window) returns it to the strip. One owner at a time — no dual rendering of a single PTY. |
| Scrollback on detach | **Rust ring buffer.** PTY state (cwd, env, running processes) is preserved for free since the PTY never dies; only xterm's painted history is lost. Rust keeps a bounded per-session ring buffer of recent raw bytes (`shell_get_scrollback`) that the new window replays before going live. |
| Chat thread on detach | **In-memory handoff only.** Snapshot `messages[]` to Rust state on detach, re-hydrate in the new window. RAM only — survives detach/re-attach but not an app restart, preserving today's "chat is session-scoped, never persisted" policy. |

---

## Current architecture (baseline)

Inference admission control is a **per-webview JS singleton** — this is the only
reason it can't coordinate across windows.

- `src/lib/agent/inferenceQueue.svelte.ts` — `withInferenceSlot()`, capacity 1
  for local mode / unbounded for remote+`allowParallelInference`. Pure semaphore;
  does not touch HTTP.
- Consumers: `src/lib/shell/runShellTurn.ts` (`consumer: 'shell'`),
  `src/lib/stores/chat.svelte.ts:888` (`'chat'`),
  `src/lib/agent/jobs/runner.svelte.ts` (job consumer).
- Actual inference HTTP POST + SSE parse: `src/lib/api.ts:251,314` (direct
  `fetch` to `${baseUrl}/v1/chat/completions`), driven by
  `src/lib/agent/loop.ts` (`runAgentLoop`).
- Per-consumer ticket is rendered in `src/lib/components/shell/ChatSidebar.svelte:82,96`
  (`getShellTicket`). `getQueueSnapshot`/`getRunningCount` are currently only
  used by tests.

Shell state is also a singleton (`src/lib/stores/shell.svelte.ts`, module-level
`$state`, single `activeSession`) — Phase 2 fixes this. The chat store already
demonstrates the multi-instance pattern (`conversations[]` + active id).

Rust side:
- `src-tauri/src/lib.rs` — `.manage(...)` registrations (lines 43–60),
  `invoke_handler!` (line 61), `.setup()` (line 42). Shutdown of sidecars +
  `ShellManager` on exit.
- `src-tauri/src/shell/` — `ShellManager` (`HashMap<SessionId, Session>`),
  already supports N PTYs via `alloc_id()`.
- `src-tauri/src/inference.rs` — **remote-server probing/model normalization
  only** (not the queue). The queue will be a new module `inference_queue.rs`.
- Windows: `src-tauri/tauri.conf.json` declares one static window; no
  `WebviewWindow` usage anywhere yet.

---

## Phase 1 — Move the inference queue into Rust

**Outcome:** identical behavior to today, but the gate is shared process-wide, so
any number of webviews serialize against one local slot. No UI/behavior change
visible yet (still one window) — this is the load-bearing refactor.

### 1a. Rust: queue state + commands

New module `src-tauri/src/inference_queue.rs`:

- `struct InferenceQueue` (managed via `app.manage(...)` in `lib.rs`), holding:
  - capacity (1 local; unbounded when remote + parallel — read per-acquire, same
    rule as `currentCapacity()` today),
  - `running: usize`,
  - `tickets: Vec<Ticket>` where `Ticket { id, consumer, state, owner_window, enqueued_at, lease_expires_at }`,
  - a FIFO of pending waiters (each backed by a `tokio::sync::oneshot` or a
    notify), plus an id counter.
- Commands (add to `invoke_handler!`):
  - `inference_acquire(consumer, window_label) -> Ticket` — registers a waiting
    ticket, emits queue event, resolves when admitted (or rejects on the
    caller's abort — see 1b).
  - `inference_release(id)` — drops ticket, decrements running, pumps next,
    emits.
  - `inference_heartbeat(id)` — refreshes `lease_expires_at`.
  - `inference_queue_snapshot() -> Vec<Ticket>` — for late-joining windows to
    hydrate.
- Broadcast: emit `inference://queue` (full snapshot) to **all** windows on
  every state change (`app.emit(...)`).
- Cleanup:
  - **Window listener** in `lib.rs` `.on_window_event` / `WindowEvent::Destroyed`
    → release all tickets where `owner_window == label`.
  - **Lease sweep**: a background task ticks (e.g. every 30s) and releases
    tickets whose `lease_expires_at` has passed. TTL generous (e.g. 5 min);
    frontend heartbeats every ~30–60s while holding a slot so long turns never
    expire.

### 1b. Frontend: rewrite `inferenceQueue.svelte.ts` as a thin client

Keep the **same public API** (`withInferenceSlot`, `InferenceTicket`,
`getQueueSnapshot`, `getRunningCount`) so `runShellTurn.ts`, `chat.svelte.ts`,
and `runner.svelte.ts` don't change.

- `withInferenceSlot(opts, fn)`:
  1. `const t = await invoke('inference_acquire', { consumer, windowLabel })`
     (honor `opts.signal`: if aborted before grant, the acquire promise must
     reject and Rust must drop the waiting ticket — pass an abort path, e.g. an
     `inference_cancel_acquire(id)` command invoked on abort).
  2. start a heartbeat interval for `t.id`.
  3. `onAdmitted?.()`, then `await fn()` (unchanged — still the direct fetch).
  4. `finally`: clear heartbeat, `invoke('inference_release', { id: t.id })`.
- Replace local `queue`/`runningCount` `$state` with state hydrated from the
  `inference://queue` event (a module-level `listen(...)` started once),
  so `getQueueSnapshot()` / `getShellTicket()` keep working and now reflect
  **all** windows.
- `onTicket` still fires with the granted/queued ticket so `ChatSidebar`'s
  waiting/running indicator is unchanged.

### 1c. Tests

- Rust unit tests for `InferenceQueue`: capacity 1 serializes; release pumps
  FIFO; window-destroy releases owned tickets; lease expiry reclaims; heartbeat
  prevents expiry.
- Port the intent of `inferenceQueue.test.ts`. The current test imports internal
  module state; rework it to test the client wrapper against a mocked `invoke`,
  or move the authoritative concurrency tests to Rust and keep a thin client
  test. (`_resetForTests` shim stays for the client.)

**Risk / watch:** abort-before-grant must not leak a waiting ticket; lease TTL
must exceed worst-case turn gap between heartbeats. Verify chat + a job + shell
still serialize correctly in one window before moving on.

---

## Phase 2 — Multiple shell tabs (in-window)

**Outcome:** Shell view hosts N independent shells via a sub-tab strip; each has
its own PTY and its own chat sidebar; all share the Phase-1 queue automatically.

### 2a. De-singleton the shell store

Refactor `src/lib/stores/shell.svelte.ts` from module-level `$state` into a
**factory** `createShellSession(): ShellSessionStore` returning per-instance
state (mirror `chat.svelte.ts`'s `Conversation` pattern):

- Move `messages`, `streamingContent`, `isSubmitting`, `ticket`, `sidebarOpen`,
  `lastError`, `searchSteps`, `messageSteps`, `contextNotice`,
  `integrationMarkerCount/CompletedCommands`, `abortController`, `activeSession`,
  `composerFocusFn` into the instance.
- Convert exported free functions (`getShellMessages`, `bindShellSession`,
  `submit*`, `refreshShellIntegrationStatus`, etc.) into methods on the returned
  store.
- New module-level registry: `shellSessions: ShellSessionStore[]` +
  `activeShellId`, with `addShell()`, `closeShell(id)`, `setActiveShell(id)`,
  `getShells()`, `getActiveShell()`.

### 2b. Components

- `ShellTab.svelte` → split: a `ShellWorkspace.svelte` container that renders the
  **sub-tab strip** + the active shell, and a per-instance `ShellPane.svelte`
  (today's Terminal + ChatSidebar) that takes a `ShellSessionStore` prop instead
  of reading globals.
- `Terminal.svelte` / `ChatSidebar.svelte`: take the store instance via prop/
  context rather than importing the singleton. `bindShellSession` becomes
  `store.bindShellSession`.
- Keep-alive: today `+page.svelte` keeps the single ShellTab mounted so the PTY
  survives tab switches. Extend this — **all** shell panes stay mounted (hidden
  via CSS) so background PTYs and in-flight turns keep running; only the active
  one is visible. (Watch xterm.js `FitAddon` sizing on show/hide.)

### 2c. Sub-tab strip UI

- New `ShellTabStrip.svelte`: renders `getShells()` with active highlight, close
  buttons, and a `+` that calls `addShell()` (spawns a new PTY via existing
  `ShellManager` path). Layout per the chosen mock:
  `[ sh1* | sh2 | sh3 | + ]` above the terminal/sidebar split.
- Closing a tab: confirm if a turn is in-flight; tear down PTY
  (`shell_close`/manager) + abort its turn + release any held slot.

### 2d. Tests

- Store factory: two sessions hold independent `messages`/`isSubmitting`;
  closing one doesn't touch the other.
- Two shells queue correctly against the single slot (relies on Phase 1).

**Risk / watch:** xterm resize/fit when panes are hidden then shown; ensure each
shell's `consumer: 'shell'` ticket is distinguishable in the queue UI (consider
labeling tickets with the shell tab name).

---

## Phase 3 — Detach a shell tab into its own window

**Outcome:** a shell tab can pop out into its own OS window (move semantics);
re-attach or window-close returns it to the strip. Shares the Phase-1 queue
natively (it's already process-wide).

### 3a. Routing + window

- New SvelteKit route `src/routes/shell/[id]/+page.svelte` that renders a single
  `ShellPane` for the given shell id, **without** TabBar/strip/main layout.
  (SPA + static adapter already in use; ensure the dynamic route prerenders to
  the SPA fallback.)
- Detach action in `ShellTabStrip`: `WebviewWindow` create (frontend
  `@tauri-apps/api/webviewWindow`) pointing at `#/shell/<id>` (hash or path per
  router config), titled with the shell name.

### 3b. Ownership handoff (move, not mirror)

This is the crux — the PTY lives in Rust and is fine; the **frontend shell store
instance + its xterm/scrollback live in a webview** and cannot be shared between
two webviews. So:

- Treat the **shell session as Rust-owned** (PTY already is) and have whichever
  window renders it bind to it by id. On detach:
  1. Mark the shell `detached` + record owning window label in a small shared
     registry (Rust state or a `tauri-plugin-store`/event-synced map).
  2. Main window removes the pane from its strip (stops rendering, unsubscribes
     from `shell://output`).
  3. New window mounts `ShellPane`, binds to the same `sessionId`, subscribes to
     `shell://output`, and re-hydrates scrollback (see 3c).
- Re-attach / detached-window close: reverse — registry flips back, main strip
  re-adds the tab and re-binds. The window-destroyed listener from Phase 1 also
  ensures any held inference slot is released.

### 3c. Scrollback + chat rehydration

Only **cosmetic** xterm history and the in-webview chat thread are lost on
handoff — all PTY *process* state (cwd, env, running foreground processes,
OSC-133 captures) is preserved for free because the PTY never restarts.

- **Scrollback — Rust ring buffer (decided).** Each `Session` keeps a bounded
  per-session ring buffer of recent raw PTY bytes (e.g. ~256 KB). New command
  `shell_get_scrollback(sessionId) -> bytes`; the receiving window replays it
  into a fresh xterm, *then* subscribes to live `shell://output`. Works even if
  the source window already closed. A TUI caught mid-redraw self-corrects on the
  next paint (the resize that detach triggers usually forces one).
- **Chat thread — in-memory handoff only (decided).** The shell store instance
  can't cross webviews, so on detach snapshot `messages[]` to a small Rust-side
  stash (`shell_stash_chat(sessionId, messages)`); the new window pulls it
  (`shell_take_chat(sessionId)`) on mount. RAM only — survives detach/re-attach,
  **not** an app restart. This keeps today's "chat is session-scoped, never
  persisted" policy intact (no disk writes, no launch-time restore questions).

### 3d. Lifecycle / edge cases

- App exit already shuts down all PTYs (`lib.rs`); ensure detached windows close
  with the app.
- Prevent double-detach / detaching the last/active tab oddities.
- Settings/theme: detached window must load the same settings store (it will via
  the shared route bundle, but verify the Tauri pathname gotcha — route guards
  must use `page.route.id`, not pathname, per project memory).

### 3e. Tests / manual verify

- Manual: detach sh2, run a prompt in it while running one in main window →
  confirm they serialize through the shared queue with correct waiting/running
  badges in both windows.
- Crash the detached window mid-turn → slot is reclaimed (Phase 1 listener),
  main window's queue recovers.
- Re-attach restores tab with scrollback + chat thread intact.

---

## Cross-cutting risks

- **Streaming stays in the frontend** (per decision) — each window does its own
  fetch to :8765. The queue guarantees only one runs at a time (local), so no
  llama-server contention, but confirm the SSE path is unaffected by the
  acquire/release wrapping.
- **Abort semantics** across the invoke boundary: aborting a queued (not yet
  granted) turn must remove the Rust ticket; aborting a running turn aborts the
  fetch and releases the slot.
- **Lease tuning:** heartbeat interval ≪ TTL; long tool-running turns must keep
  heartbeating even while awaiting a tool.
- **xterm in multiple/hidden panes:** fit/resize correctness.
- **Persistence scope creep:** Phase 3's cross-webview chat-thread state is
  **in-memory handoff only** (decided) — no disk writes, no launch-time restore.
  Revisit only if durable shell-chat history is explicitly wanted later.

## Suggested PR breakdown

1. PR1: Rust `inference_queue` + frontend client rewrite (Phase 1). No UX change.
2. PR2: shell store factory + `ShellPane`/strip + multi-tab (Phase 2).
3. PR3: detach route + window + ownership handoff + scrollback rehydration
   (Phase 3).
