# Phase 4 — CodeSession store

**Depends on:** 1, 2, 3 · **Guide:** none (`no-docs`; still no UI)

## Goal

`src/lib/stores/code.svelte.ts`: the registry of open sessions and a
`CodeSession` class that runs turns. Headless — testable without the tab.

## Shape

```ts
class CodeSession {
	id: string; title: string; root: string;
	backend: BackendOverride | null; effort: string | null;
	messages: ChatMessage[];
	messageSteps / messageStats / messageStops / messageHistorySent;  // as the shell store
	status: 'idle' | 'queued' | 'running' | 'waiting-shell';
	steering: string[];          // queued while running
	background: BgProcess[];     // from code_bg_status, refreshed while any exist
	send(text): Promise<void>;
	stop(): void;
	setBackend(b) / setEffort(e) / rename(t);
}
// registry
openSessions, activeSessionId, openSession(id), newSession(root), closeSession(id)
```

## Turn runner (`src/lib/code/runCodeTurn.ts`)

Built on `runAgentLoop` directly, borrowing the relevant pieces of
`shell.svelte.ts`'s turn path (not importing it):

- `codeMode: true`, `shellMode: false`, `workingDir: root`, `writeRoot: root`,
  `codeSessionId: id`, `interactive: true`.
- `backend` / `reasoningEffort` from the session, else the global settings.
- `maxIterations: codeMaxIterations`, `maxResponseTokens: maxResponseTokensFileWrite`
  (same as Shell Code mode today).
- System prompt: reuse the coding prompt that Shell Code mode builds today
  (`buildCodeSystemPrompt` path in `shell.svelte.ts` ~L946), minus the
  terminal-specific lines; AGENTS.md + skills as there. Extract the shared
  builder to `src/lib/code/system-prompt.ts` so phase 8 can strip the coding
  prompt from the Shell without losing it here.
- `takeSteering: () => this.steering.splice(0)`.
- Persist after every turn and on stop: `code_session_save`. Title from the
  first user message (trimmed, 60 chars) when empty.
- Background watch completions for this owner queue a follow-up turn when idle
  (same "wait for an opportunity" rule as the shell).
- `closeSession` → `code_bg_stop_owner` (ask first in the UI if any are running).

## Empty threads

A fresh session and a fork at message 0 store a snapshot with no messages, and
`decodeCodeSession` returns `null` for that. Loading must treat `null` as an
empty session, not a missing or corrupt one.

## Queue state

`status = 'queued'` while the turn's first inference request is waiting in
`inferenceQueue` — expose a "waiting for slot" signal there if one doesn't
exist (check `inferenceQueue.svelte.ts` first).

## Approvals

`codeCommandApproval`'s session approval is keyed today by the shell session —
key it by an opaque string and pass `code:<id>`. Auto-approve reads the new
`codeAutoApprove` setting (moved in phase 5; read the existing key until then).

## Tests

Mock `runAgentLoop`: send → persists; steering passes through; stop
persists the partial turn; title derivation; watch completion queues a turn
only when idle; close stops background processes.

## Done when

A test can create a session, run a mocked turn, reload it by id, and get the
same thread.

## As built

- `stores/code.svelte.ts`: registry (`getOpenSessions`, `getActiveSession(Id)`,
  `setActiveSession`, `openSession`, `newSession`, `closeSession`) and
  `CodeSession`. `send` while a turn runs queues steering; undelivered steering
  comes back in `returnedSteering` (`takeReturnedSteering()` for the input box).
  Per-session `usage` for the context gauge (the global context store is left
  alone). `saveError` is set when a save fails.
- `code/runCodeTurn.ts` calls `runAgentLoop` directly (not `runTurnCore`) to
  read `CompletionMeta` and keep a stopped turn's finished part. It never
  throws: it returns `added` messages plus `outcome`. Delivered steering and the
  answer it interrupted stay in the thread; loop nudges don't.
- Queue state needed no new signal: `withInferenceSlot`'s `onTicket` /
  `onAdmitted` give `queued` → `running`. New consumer `'code'`.
- `code/system-prompt.ts` holds both coding prompts; the Shell's is unchanged
  byte for byte. The tab variant drops the terminal tools, the two-environments
  block and PID kills, and names `command_output` / `command_stop`.
- Session approval: `isSessionApproved(key)` / `approveSession(key)` /
  `resetSessionApproval(key)`. Shell uses `SHELL_APPROVAL_KEY`, a session
  `codeApprovalKey(id)`.
- `buildWatchNotification` moved to `shell/backgroundWatch.ts`, shared by both.
- `agent/tools/code-bg.ts` now holds the Code tab's background tools.
- Not done here: the rendered-thread trim the Shell does at 40 messages (the
  saved thread is the whole session; phase 5 decides how much to render), and
  the approval modal still takes one prompt at a time, so two sessions asking
  at once get a tool error for the second (phase 9).
