# Phase 05 — Remote control follows lean mode

**Depends on:** 01, 04 · **Enables:** nothing later; it closes the last way
into Code while lean mode is on

## Goal

The Remote control web client (Settings → Remote control) obeys the same rules
as the desktop window:

- Chat turns started from it already get the lean tool set from phase 01,
  because they run through the same `getToolSchemas` in the main window.
- Code session operations are refused while lean mode is on.
- `jobs.types` lists only Research.
- The web page shows Chat only, with a "Lean mode" badge that has no settings
  link.

The client has only Read scope for settings-like data, and `settings.get`
needs Settings scope. So this phase adds one Read-scope op, `app.mode`.

## Files touched

- `src/lib/engine/types.ts`: add `{ type: 'app.mode' }` to the op union.
- `src/lib/engine/dispatch.ts`:
  - answer `app.mode`;
  - refuse the Code session ops in lean mode (`session.new`, `session.open`,
    `session.send`, `session.compact`, `session.fork`,
    `session.cancelShellWait`).
- `src/lib/engine/dispatch.test.ts`: lean tests.
- `src-tauri/src/owner/clients.rs`: `"app.mode"` gets `Scope::Read` in
  `required_scope`, plus an assertion in its tests.
- `src/lib/engine/jobs.svelte.ts`: `jobs.types` leaves out
  `pausedByLean` types.
- `src/web/store.svelte.ts`: fetch `app.mode`, expose `lean`, and force
  `tab = 'chat'`.
- `src/web/components/SessionList.svelte`: hide the Code tab button.
- `src/web/App.svelte`: render the badge.
- `docs/guide/remote-control.md`: one paragraph on lean mode.
- `docs/guide/remote-control-api.md`: document `app.mode` and the lean refusal.

## Steps

1. **Op type.** Add `{ type: 'app.mode' }` to the engine op union in
   `types.ts`.
2. **Rust scope.** In `required_scope` (`clients.rs:47`), add `"app.mode"` to
   the `Scope::Read` arm. Add
   `assert_eq!(required_scope("app.mode"), Some(Scope::Read));` beside the
   existing assertions (~:413). `dispatch.scopes.test.ts` then passes, because
   every answered op has a Rust scope.
3. **Dispatch.** In `dispatch.ts`:
   - `case 'app.mode': return { lean: getSettings().leanMode };`
   - Before the `session.*` cases that start or drive a turn (`session.new`,
     `session.open`, `session.send`, `session.compact`, `session.fork`,
     `session.cancelShellWait`), throw
     `new Error('Lean mode is on: turn it off in Settings → General to use Code sessions.')`
     when `getSettings().leanMode` is set. Read-only ops (`sessions.list`,
     `session.get`, `session.readFile`, `session.resync`) and `session.stop`,
     `session.close`, `session.delete` stay allowed, so a client can still see
     and tidy existing sessions.
4. **jobs.types.** In `dispatchJobs`, filter `listJobTypes()` with
   `!pausedByLean(t.id)` (from phase 04's `lean.ts`). `jobs.run` and
   `jobs.create` need no change: `enqueue` refuses paused types (phase 04),
   and `jobs.create` with a paused type throws
   `"Lean mode is on: only research jobs can be made."` Add that check next
   to the existing `job_type` check (`jobs.svelte.ts:188`).
5. **Web store.** In `store.svelte.ts`, add `lean = $state(false)`. On connect
   (where `connection` becomes ready, ~:119) and on every `status` event
   (~:379), call `sendOp({ type: 'app.mode' })` and set `lean`. When the
   result is `true`, also set `tab = 'chat'` in the same place. The default
   `tab` stays `'code'` for full mode.
6. **Web UI.** In `SessionList.svelte`, wrap the Code tab button (:60-62) in
   `{#if !store.lean}`. In `App.svelte`, when `store.lean`, render a small
   "Lean mode" pill in the list header with
   `title="Turn it off on the computer running Haruspex, in Settings → General."`
   It is not a link.
7. **Guide.** In `remote-control.md`, add one paragraph saying that in lean mode
   the web page shows Chat only and Code sessions cannot be started or sent to.
   In `remote-control-api.md`, document `app.mode` (Read scope, returns
   `{ lean }`) and the error text that the session ops return in lean mode.

## Build gate

```bash
npm run check && npm run lint && npm run format:check && npm run test && npm run build:web
cd src-tauri && cargo test owner:: && cargo clippy && cargo fmt -- --check
```

## Test plan

- Unit (`dispatch.test.ts`):
  - With lean on, `app.mode` returns `{ lean: true }`.
  - `session.send` and `session.new` throw the lean error.
  - `sessions.list` and `session.stop` still answer.
  - `jobs.types` returns only `research`.
- Rust: the `required_scope("app.mode")` assertion.
- `dispatch.scopes.test.ts` passes.
- Live:
  - Pair the web client and turn lean mode on at the desktop. Within one status
    event, the web page switches to Chat, the Code button goes, and the pill
    shows.
  - Send a chat from the web page. The debug log shows the lean tool list.
  - Turn lean mode off. The Code button returns.

## Commit

`feat(remote): apply lean mode to the Remote control client`

PR body names `docs/guide/remote-control.md` and
`docs/guide/remote-control-api.md`.

## Rollback

Revert the commit. The web client shows Code again, and `app.mode` disappears
from both the TS dispatcher and the Rust scope table in the same revert, so
they stay in step. Desktop lean mode is unaffected.
