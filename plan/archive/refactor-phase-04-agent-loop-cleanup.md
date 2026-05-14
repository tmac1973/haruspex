# Refactor Phase 4: Agent Loop Simplification

**Branch:** `refactor/agent-loop-cleanup`
**Priority:** P2
**Risk:** Medium — touches the core execution loop; recovery mechanisms may mask real issues
**Estimated scope:** 1 file significantly refactored (~576 → ~400 lines), 1 new helper file
**Depends on:** Phase 1 (prompt trimming may make some recovery paths unnecessary), Phase 2 (tool registry provides cleaner dispatch)

---

## Goal

Simplify the agent loop's control flow. Currently `runAgentLoop` in `loop.ts` has 6 recovery/nudge mechanisms implemented as `continue`/`break` branches inside a single `while` loop. This phase extracts the streaming helper, restructures the guard clauses, and evaluates which recovery mechanisms are still needed after prompt trimming.

---

## Step 1: Extract streaming finalization helper

The stream-consume-and-forward pattern appears 3 times in `runAgentLoop`:
- Lines 414-439: post-tool final answer (no tools in request)
- Lines 441-467: first-response streaming (tools in request)
- Lines 550-575: max-iterations fallback

All three do the same thing:
1. Create a `chatCompletionStream()` call
2. Iterate chunks, forwarding to `onStreamChunk` and `onUsageUpdate`
3. Check `finish_reason` for `'length'`
4. Call `onComplete()` or `onError()`

**Extract to:**
```typescript
// Can live at the top of loop.ts or in a separate src/lib/agent/stream.ts

interface StreamFinalAnswerOpts {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    signal?: AbortSignal;
    onStreamChunk: (chunk: StreamChunk) => void;
    onUsageUpdate?: (usage: Usage) => void;
    onComplete: () => void;
    onError: (error: Error) => void;
    truncationMessage: string;  // context-specific error text for finish_reason=length
}

async function streamFinalAnswer(opts: StreamFinalAnswerOpts): Promise<void> {
    const sampling = getSamplingParams();
    const stream = chatCompletionStream(
        {
            messages: opts.messages,
            tools: opts.tools,
            temperature: sampling.temperature,
            top_p: sampling.top_p,
            max_tokens: FINAL_SYNTHESIS_MAX_TOKENS,
            chat_template_kwargs: getChatTemplateKwargs()
        },
        opts.signal
    );
    let lastFinish: string | null = null;
    for await (const chunk of stream) {
        if (chunk.usage) opts.onUsageUpdate?.(chunk.usage);
        if (chunk.finish_reason) lastFinish = chunk.finish_reason;
        opts.onStreamChunk(chunk);
    }
    opts.onComplete();
    if (lastFinish === 'length') {
        opts.onError(new ApiError(opts.truncationMessage));
    }
}
```

**Impact:** Eliminates ~60 lines of duplication. Each call site becomes a single `await streamFinalAnswer({...})` with a context-specific `truncationMessage`.

---

## Step 2: Restructure the guard clause ordering

Currently the while-loop body has this structure (pseudocode):
```
resolve tool calls
if no tools + usedTools + finish_reason=length → continue (truncation)
if no tools + usedTools + malformed XML → continue (malformed recovery)
if no tools + usedTools + bare URL → break (degraded output)
if no tools + expectsFileOutput + !fileWritten → continue (hallucination recovery)
if no tools + diversity check → continue (diversity nudge)
if no tools → stream final answer, return
execute tools
```

The guards are ordered by when they were added, not by logical priority. Restructure to a clearer decision tree:

```
resolve tool calls

if tool calls present → execute tools, continue

// No tool calls from here — the model wants to stop.

if malformed XML detected → nudge retry, continue
if truncated (finish_reason=length) → nudge continue, continue
if bare URL / naked tool name → break to fallback
if file-write expected but not done → nudge write, continue
if diversity gate failed → nudge fetch more, continue

// All guards passed — stream the final answer
stream final answer, return
```

Key change: **check for tool calls first** and handle the "has tools" path early. This inverts the current structure where tool execution is at the bottom (line 471+). The happy path (tool calls present → execute → loop) is now the first branch, and all the recovery guards only fire in the "no tool calls" case.

---

## Step 3: Evaluate recovery mechanisms post-prompt-trimming

After Phase 1 lands and you've tested for a while, revisit each mechanism:

### Keep unconditionally:
- **Truncation continuation** — always needed; the model can hit max_tokens mid-generation.
- **Malformed tool-call recovery** — always needed; XML parsing can fail for many reasons.
- **In-loop context trimming** — always needed; deep research can blow context regardless of prompt size.

### Evaluate after Phase 1 testing:
- **File-write hallucination recovery** — if the trimmed prompt's "write the file in the same turn" instruction works reliably, this recovery may fire much less often. Keep it but add a counter/log so you can measure frequency. If it fires <5% of file-output turns after a few weeks of use, consider removing it.
- **Diversity nudge** — if the model naturally fetches more pages with a shorter prompt (more reasoning budget), this may become unnecessary. Same approach: keep, measure, potentially remove.
- **Bare URL / naked tool-name detection** — this catches a specific degradation mode. Keep it regardless — it's cheap (one regex check) and the fallback path is harmless.

### Action for this phase:
- Add a `console.debug` log to each recovery path noting which guard fired and on which iteration. This gives visibility into how often each mechanism triggers without affecting behavior.
- Do NOT remove any mechanism in this phase. The goal is structural clarity, not behavioral change. Removal decisions come from data after testing Phase 1.

---

## Step 4: Snapshot settings at loop entry

Currently, `getSamplingParams()` and `getChatTemplateKwargs()` are called multiple times during a loop run — once per iteration in the main loop, once per sub-agent call in `executeResearchUrl`/`executeEmailSummarizeMessage`. If the user changes settings mid-generation, later calls get different parameters.

Fix: capture settings once at the top of `runAgentLoop` and pass them through `ToolContext` (from Phase 2's registry):

```typescript
export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
    const sampling = getSamplingParams();
    const templateKwargs = getChatTemplateKwargs();
    // ... pass sampling + templateKwargs into ToolContext
    // ... use them for all chatCompletion calls in this loop run
}
```

This requires Phase 2's `ToolContext` to include sampling params. The tool modules (`web.ts`, `email.ts`) that call `chatCompletion` for sub-agents read from `ctx.sampling` instead of calling `getSamplingParams()` directly.

---

## Resulting Structure

After this phase, `loop.ts` should look like:

```
// Constants (4 lines)
// StreamFinalAnswerOpts interface + streamFinalAnswer helper (~30 lines)
// SearchStep interface (~15 lines)
// AgentLoopOptions interface (~30 lines)
// Helper functions: looksLikeClarifyingQuestion, trimOldToolMessages, injectPendingImages (~60 lines)
// runAgentLoop main function (~250 lines):
//   - settings snapshot
//   - while loop with clear guard ordering
//   - tool execution
//   - post-loop fallback
```

Target: ~400 lines, down from 576.

---

## Testing Plan

1. **Normal web search** — model searches, fetches pages, produces answer. No recovery mechanisms should fire.
2. **Deep research** — 4-6 sources fetched, context trimming may fire. Verify it works.
3. **File output** — "create a PDF about X". Verify the file is written. Check console for whether the hallucination recovery fired.
4. **Diversity** — ask a factual question, check console for whether the diversity nudge fired.
5. **Abort** — start a long search, cancel mid-stream. Verify clean abort without errors.
6. **Max iterations** — trigger with deep research on a broad topic. Verify the fallback nudge and final stream work.
7. **Settings stability** — start a long generation, change temperature in Settings mid-run. Verify the generation completes using the original temperature (not the new one). This is a new behavior change — note it for regression.
8. **All tests pass** — `npm run test`, `npm run check`.

---

## Acceptance Criteria

- [ ] `loop.ts` is under 420 lines
- [ ] The streaming pattern appears exactly once (in `streamFinalAnswer`)
- [ ] Guard clauses are ordered logically with the happy path (tool execution) first
- [ ] Each recovery mechanism has a `console.debug` log
- [ ] Settings are captured once at loop entry and reused throughout
- [ ] All existing tests pass
- [ ] `npm run check` passes
