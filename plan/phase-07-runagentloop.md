# Phase 07 — `runAgentLoop` decomposition

**Severity addressed:** 10 · **Effort:** ~1 day · **Risk:** HIGH

Resolves complexity-audit C-1 (601-line god function, cyclomatic ≈83, 14 mutable per-turn flags) and design-pattern P-2 (implicit state machine).

**Prerequisite:** Phase 04 complete (tool helpers stable).

## Goal

Decompose `runAgentLoop` (`src/lib/agent/loop.ts:242-842`) into:
- A `LoopContext` builder (options + per-turn state)
- A `NudgeState` class owning file-write / diversity / run_python heuristics
- A `runIteration(ctx, nudges)` function for one model call
- A slim top-level `runAgentLoop` ≤ 50 LOC

**Public signature unchanged:** `runAgentLoop(options: AgentLoopOptions): Promise<void>` is the contract every caller depends on.

## Files touched

- **EDIT** `src/lib/agent/loop.ts` — slim down
- **NEW** `src/lib/agent/loop/nudges.ts`
- **NEW** `src/lib/agent/loop/iteration.ts`
- **NEW** `src/lib/agent/loop/context.ts`
- **NEW** `src/lib/agent/loop/types.ts` — internal-only types (if `loop.ts` doesn't already have a clean home for them)

Existing exports of `loop.ts` (`runAgentLoop`, `isCodeContext`, etc.) **must remain at the same import paths**.

## Implementation

### Step 1 — write `nudges.ts` first

This is the safest extraction: pure state with explicit transition methods.

```ts
// src/lib/agent/loop/nudges.ts
import type { ChatMessage } from '$lib/api';

export const MAX_FILE_WRITE_RETRIES = 2;
export const RUN_PYTHON_FAILURE_NUDGE_THRESHOLD = 3;
const RUN_PYTHON_NUDGE_HINT =
	'\n\n(Hint: these attempts are repeatedly failing the same way. Step back and re-evaluate the approach before trying again.)';

export class NudgeState {
	fileWritten = false;
	fileWriteRetries = 0;
	webSearchUsed = false;
	fetchedUrls: Set<string> = new Set();
	diversityNudged = false;
	private consecutiveRunPythonFailures = 0;

	onToolExecuted(toolName: string, result: string, urlIfFetch?: string): void {
		if (toolName === 'web_search') this.webSearchUsed = true;
		if (toolName === 'fetch_url' && urlIfFetch) this.fetchedUrls.add(urlIfFetch);
		if (toolName.startsWith('fs_write_') || toolName === 'fs_download_url') {
			this.fileWritten = true;
		}
		if (toolName === 'run_python') {
			if (result.startsWith('Error:')) this.consecutiveRunPythonFailures++;
			else this.consecutiveRunPythonFailures = 0;
		}
	}

	needsFileWriteNudge(expectsFile: boolean): boolean {
		return (
			expectsFile &&
			!this.fileWritten &&
			this.fileWriteRetries < MAX_FILE_WRITE_RETRIES
		);
	}

	consumeFileWriteNudge(): ChatMessage {
		this.fileWriteRetries++;
		return {
			role: 'user',
			content: /* lift current FILE_WRITE_NUDGE_PROMPT from loop.ts */ ''
		};
	}

	needsDiversityNudge(): boolean {
		return this.webSearchUsed && this.fetchedUrls.size <= 1 && !this.diversityNudged;
	}

	consumeDiversityNudge(): ChatMessage {
		this.diversityNudged = true;
		return {
			role: 'user',
			content: /* lift current DIVERSITY_NUDGE_PROMPT */ ''
		};
	}

	maybeAppendRunPythonHint(result: string): string {
		return this.consecutiveRunPythonFailures >= RUN_PYTHON_FAILURE_NUDGE_THRESHOLD
			? result + RUN_PYTHON_NUDGE_HINT
			: result;
	}
}
```

Run `npm run check` after this file lands. **Do not** consume it yet; just verify the class compiles.

### Step 2 — write `context.ts`

```ts
// src/lib/agent/loop/context.ts
import type { AgentLoopOptions, PendingImage } from '../loop';

export interface LoopContext {
	options: AgentLoopOptions;
	messages: AgentLoopOptions['messages'];
	tools: ReturnType<typeof getToolSchemas>;
	pendingImages: PendingImage[];
	filesWrittenThisTurn: Set<string>;
	maxIterations: number;
}

export function buildLoopContext(options: AgentLoopOptions): LoopContext { /* … */ }
```

This is the part of `runAgentLoop` between lines 242 and ~265 (option destructure + tool schema fetch).

### Step 3 — write `iteration.ts`

This is the body of one iteration — the `while` block body in current `runAgentLoop`. Returns a small result type:

```ts
// src/lib/agent/loop/iteration.ts
export interface IterationResult {
	shouldContinue: boolean;
	finishReason?: 'length' | 'stop' | 'tool_calls' | 'content_filter';
}

export async function runIteration(
	ctx: LoopContext,
	nudges: NudgeState
): Promise<IterationResult> {
	// 1. inject pending images if any
	// 2. apply nudges if needed (consumeFileWriteNudge / consumeDiversityNudge)
	// 3. chatCompletion (or chatCompletionStream)
	// 4. emit onCallStats, append assistant message
	// 5. if tool_calls: execute them, append tool results, return { shouldContinue: true }
	// 6. else: handle finish_reason — bare-URL recovery, length-truncation retry, etc.
	// 7. return { shouldContinue: false }
}
```

Each step in the comment maps to a chunk currently in `loop.ts:307-820`. **Lift each chunk verbatim**, then refactor cosmetics afterwards. Do not change behaviour inside this PR.

### Step 4 — slim `loop.ts`

```ts
// src/lib/agent/loop.ts (post-refactor; runAgentLoop section)
export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
	const ctx = buildLoopContext(options);
	const nudges = new NudgeState();
	logDebug('agent', 'runAgentLoop start', { /* options summary */ });

	for (let i = 0; i < ctx.maxIterations; i++) {
		if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		const result = await runIteration(ctx, nudges);
		if (!result.shouldContinue) return;
	}

	logDebug('agent', 'runAgentLoop exhausted maxIterations');
}
```

`isCodeContext`, `looksLikeClarifyingQuestion`, `trimOldToolMessages`, `injectPendingImages` stay where they are (or move to `loop/helpers.ts` opportunistically — not required for this phase).

### Step 5 — incremental cutover

Do this in **three** local commits inside the same PR; squash before merge.

1. Commit A: add `nudges.ts`, `context.ts`, `iteration.ts`. Do not call them yet. Verify `npm run check` + `npm run test` + the app still launches and runs a chat (the new files are unused dead code at this point).
2. Commit B: in `runAgentLoop`, replace the relevant blocks with calls into the new modules. Verify the **agent prompts below** all pass.
3. Commit C: delete the now-dead code in `loop.ts`. Verify nothing imports the deleted symbols.

This shape means a failing test in Commit B can roll back to the green Commit A state without losing the new helper files.

## Build gate

```bash
npm run check
npm run lint
npm run test
```

## Test plan — agent prompts

These exercise the specific behaviours `runAgentLoop` is responsible for. **Run all of them.** This is the riskiest phase in the entire plan — incomplete testing here will be more expensive than the time it takes to test.

### Smoke

1. App launches. Sidecar ready.

### Single-call paths

2. **No tool call, plain answer:**
   *"What is the capital of France?"* → "Paris" or similar. No tool steps shown.
3. **Clarifying-question short-circuit:**
   *"Can you help me?"* → model asks a clarifying question; no tool calls fire.

### Tool-call paths

4. **One web search, one final answer:**
   *"What were the major Rust 2025 edition changes?"* → one web_search step, possibly a fetch_url step, then a synthesized answer.
5. **Multiple sequential tools:**
   Set a working dir. *"Write a one-paragraph PDF report about photosynthesis."* → produces an `fs_write_pdf` call after a research step.
6. **`run_python` happy path:**
   Enable sandbox. *"Run a Python snippet that prints the first 5 primes."* → one run_python call; output reported.

### Nudge paths (must all fire correctly)

7. **File-write nudge** (`MAX_FILE_WRITE_RETRIES`):
   Set a working dir. *"Write a file called `out.txt` with the contents 'hello'."*
   Watch the log: if the model "claims it wrote the file" without firing the tool, the nudge should append a recovery message and the model should fire `fs_write_text` on the next iteration. After 2 retries, the loop accepts the failure rather than nudging forever.
8. **Diversity nudge:**
   *"Research the topic 'Tauri vs Electron'. Cite multiple sources."* — if the model only fetches one URL, the diversity nudge prompts it to fetch more. Confirm a second fetch is attempted.
9. **`run_python` failure-nudge:**
   *"Run the Python `import nonexistent_module` three times in a row."* — after the third Error: the hint about "step back and re-evaluate" should be appended to the tool result. Confirm by inspecting the agent's next prose response.

### Edge paths

10. **Abort mid-stream:** start a long generation, hit the stop button. The loop exits cleanly; no errors in the App log tab.
11. **Length truncation:** ask for a very long answer (e.g. *"Write a 5000-word essay about the history of dogs."*). When `finish_reason === 'length'`, the loop should retry with a continuation prompt and the final reply should be coherent across the boundary.
12. **`expectsFileOutput` heuristic:** with no working dir set, *"Save your answer to a file called `out.txt`."* → the absence of a working dir means no file-write nudge; the model should be told it lacks the capability or fall back to inline output.
13. **Vision-aware fallback:** if your current model lacks vision, attach an image (or ask the agent to read a saved image). The image-handling tool should be filtered from the tool list — confirm via the search-step UI that no image tool is offered.

### Regression-flavoured

14. **Conversation continuity:** send three follow-ups; the assistant should reference earlier turns coherently.
15. **`keepRecentToolResults` setting on:** with the setting enabled, send a follow-up that references the previous turn's research — the model should be able to cite without re-fetching.

If any of 2–15 produces a different result than before this phase, **revert the entire PR**.

Commit:

```
refactor: decompose runAgentLoop into NudgeState + runIteration (#TBD)

601-line god function split into:
  - src/lib/agent/loop/nudges.ts   (NudgeState class)
  - src/lib/agent/loop/context.ts  (buildLoopContext)
  - src/lib/agent/loop/iteration.ts (runIteration)
runAgentLoop in loop.ts is now ≤50 LOC and only drives the for
loop. Tool-call dispatch, length-truncation retry, abort
handling, and image injection unchanged.

Resolves audits/code-complexity-2026-05-14.md C-1 and
design-patterns-2026-05-14.md P-2.
```

## Why this phase is high-risk

`runAgentLoop` is the hot path for **every** chat turn. Behaviour drift here is invisible in unit tests and only shows up under specific conversation shapes (e.g. the bare-URL recovery at `loop.ts:439-446` is only triggered when the model emits a single URL as its entire response). The 13 agent prompts above are calibrated to surface drift; run all of them.
