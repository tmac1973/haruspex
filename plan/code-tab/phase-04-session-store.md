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
