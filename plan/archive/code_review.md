# Haruspex Code Review

Full codebase review covering architecture, design patterns, coupling, duplication, and system prompt bloat.

---

## 1. System Prompt Bloat (Critical)

This is the most impactful issue. The main system prompt in `chat.svelte.ts:36-138` is enormous and almost certainly overloading the 9B model. The prompt has three independently large sections that are always included when their feature is active:

### Main prompt (~550 tokens)
The base identity + search rules + citation rules section is reasonable on its own but contains significant redundancy.

### Filesystem section (~1,200 tokens, lines 44-79)
This is the worst offender. It contains:
- **Step-by-step presentation workflows** (steps 1-7, lines 72-79) — a 9B model cannot reliably follow a 7-step workflow specification embedded in a system prompt. These instructions are routinely ignored or partially followed, which is why the file-write hallucination recovery exists in `loop.ts:329-370`.
- **Format-specific guidance duplicating tool descriptions** — e.g. the system prompt explains what `fs_read_pdf_pages` does, then `tools.ts:240-255` explains it again in the tool description. The model sees both.
- **Edge case instructions** the model can't act on — "you cannot delete or move files", "remind the user they must chmod +x", etc. These consume tokens but a 9B model won't recall them when relevant.
- **OpenDocument format differentiation** — lines 60, 63, 66 each explain "only use this when the user specifically asks for ODT/ODS/ODP; otherwise use the Microsoft format". This is ~100 tokens spent on something the tool descriptions already handle.

### Email section (~450 tokens, lines 82-96)
Similar issues:
- **MULTI-ACCOUNT** paragraph (line 89) is ~80 tokens explaining UUID vs label matching that the tool schema already covers.
- **Digest workflow instructions** (lines 91-94) try to teach the model how to triage email importance — a judgment call that should be in the tool description or sub-agent prompt, not the system prompt.
- **CRITICAL CALL FORMAT** (line 96) is a workaround for the model failing to emit valid tool calls. This is ~50 tokens of "please emit JSON correctly" that won't help a struggling model.

### Citation rules (~250 tokens, lines 123-131)
The citation block is thorough but over-specified for a 9B model. Rules like "Reusing the same URL for multiple unrelated facts is a bug, not a citation" are nuanced instructions that a small model will not reliably follow.

### What this costs you
At 32k context with a ~2,500 token system prompt (filesystem + email active), you're burning ~8% of your context budget on instructions before the first user message. More critically, the sheer density of conditional rules causes the model to "thrash" — it searches for information, finds it, but then gets confused about citation formatting or file-write workflows and gives up. The "searching but returning no answer" behavior you're seeing is classic instruction overload on a small model.

### Recommendations
- **Cut the filesystem section by ~60%.** Remove the presentation workflow steps entirely — they don't work. Remove format explanations that duplicate tool descriptions. Keep only: "You have filesystem tools. Use fs_list_dir first. Only use them when the user asks."
- **Cut the email section by ~50%.** Remove the multi-account internals and the call-format workaround. The tool descriptions are sufficient.
- **Simplify citation rules.** Reduce to: "Cite inline as [source](URL) using the URL from the [Source: <url>] header. Don't append a references section." (~30 tokens vs ~250)
- **Move behavioral guardrails to the agent loop.** The file-write nudges and diversity nudges in `loop.ts` are already doing the heavy lifting. Let them handle behavior correction rather than trying to pre-program it into the system prompt.

---

## 2. God Objects / Excessive Responsibility

### `search.ts` (1,091 lines)
This file is a grab-bag of every tool execution handler in the app. It contains:
- Web search execution
- URL fetching with paywall detection
- Research sub-agent orchestration
- Email listing, reading, and summarization (with its own sub-agent)
- 7 filesystem read functions
- 7 filesystem write functions
- Image search, URL image scraping, image downloading
- The 30-case `executeTool` switch statement (lines 936-1090)

**Why it matters:** Adding any new tool requires editing this single file. The file-conflict modal import on line 95 is lazy-loaded specifically to avoid a circular dependency — a sign that the module boundaries are wrong.

**Recommendation:** Split into a tool registry pattern:
- `tools/web.ts` — web_search, fetch_url, research_url, image_search, fetch_url_images
- `tools/fs-read.ts` — fs_list_dir, fs_read_text, fs_read_pdf, etc.
- `tools/fs-write.ts` — fs_write_text, fs_write_docx, fs_write_pdf, etc.
- `tools/email.ts` — email_list_recent, email_summarize_message, email_read_full
- `tools/registry.ts` — a `Map<string, ToolHandler>` that replaces the switch statement

### `chat.svelte.ts` (960 lines)
This store manages:
- Conversation CRUD + state
- System prompt construction
- Database serialization/deserialization
- Agent loop orchestration and callback wiring
- Citation processing
- Search step tracking
- Error message synthesis (the 50-line empty-response handler at lines 840-918)
- Context usage tracking

**Recommendation:** Extract at minimum:
- System prompt builder → `lib/agent/system-prompt.ts`
- DB persistence layer → `lib/stores/db.ts`
- The `onToolStart` label-extraction switch (lines 716-768) → into the tool registry metadata

---

## 3. Code Duplication

### Filesystem read wrappers (search.ts:532-575)
Four nearly identical functions:
```typescript
async function executeFsReadX(workdir: string, relPath: string): Promise<string> {
    try {
        return await invoke<string>('fs_X', { workdir, relPath });
    } catch (e) {
        return JSON.stringify({ error: `fs_X failed: ${e}` });
    }
}
```
`executeFsReadText`, `executeFsReadPdf`, `executeFsReadDocx` are copy-paste identical except the command name. Should be a single generic:
```typescript
async function executeFsRead(command: string, workdir: string, relPath: string): Promise<string>
```

### Filesystem write wrappers (search.ts:577-846)
Seven write functions (`executeFsWriteDocx`, `executeFsWritePdf`, `executeFsWriteOdt`, `executeFsWriteText`, `executeFsWritePptx`, `executeFsWriteOdp`, `executeFsWriteOds`) follow the exact same pattern:
1. `resolveWritePathInteractive()`
2. If null, return `userCanceledWriteError()`
3. `invoke('fs_write_X', { workdir, relPath, content/slides/sheets, overwrite })`
4. `filesWrittenThisTurn.add()`
5. Return success string or JSON error

This is ~270 lines of boilerplate that could be a single parameterized function taking the command name and the payload shape.

### Error serialization
The pattern `JSON.stringify({ error: \`...\` })` appears 15+ times across search.ts. Should be a helper: `toolError(msg: string): string`.

### Streaming finalization (loop.ts:411-468)
The stream-consume pattern appears three times in `runAgentLoop`:
1. Lines 414-439 (post-tool streaming with no tools)
2. Lines 441-467 (first-response streaming with tools)
3. Lines 550-575 (max-iterations streaming)

Each repeats: create stream → iterate chunks → forward usage → check finish_reason → call onComplete/onError. A single `streamFinalAnswer(options, messages, tools?)` helper would eliminate all three.

### `executeTool` switch vs `onToolStart` switch
The `executeTool` function in `search.ts:936-1090` has a 30-arm switch on tool name. The `onToolStart` callback in `chat.svelte.ts:716-768` has a parallel 25-arm switch on the same tool names to extract display labels. These two switches must be kept in sync manually — adding a tool requires updating both. A tool registry with metadata would eliminate this.

---

## 4. Tight Coupling

### Chat store ↔ Agent internals
`chat.svelte.ts` imports from `$lib/agent/loop`, `$lib/agent/compaction`, `$lib/agent/parser`, `$lib/stores/settings`, `$lib/stores/context.svelte`, and `$lib/markdown`. It directly constructs the system prompt, decides maxIterations based on exhaustiveResearch, builds the messages array, and interprets tool step results. Any change to the agent's behavior requires editing the chat store.

**The `sendMessage` function (lines 559-960)** is 400 lines — it's the main orchestration point for the entire app, handling:
- Compaction checks
- System prompt assembly
- User message hint injection (review query, file output, deep research)
- Agent loop configuration
- All six agent loop callbacks
- Error recovery
- Citation baking

This should be an orchestrator/controller that delegates to focused modules rather than doing everything inline.

### Settings store as global mutable state
`getSettings()` is called from `chat.svelte.ts`, `api.ts`, `search.ts`, `loop.ts`, and multiple components. There's no request-scoped settings — the agent loop captures settings at the start of a call, but sub-agents in `search.ts` call `getSamplingParams()` independently. If settings change mid-generation (the user opens Settings while a query is running), sub-agent calls could use different parameters than the parent loop.

### Agent loop ↔ Tool execution coupling
`runAgentLoop` in `loop.ts` directly imports `executeTool` and `getAgentTools` and knows about:
- Pending images and how they're injected
- File write tracking
- Tool-call XML artifacts
- Specific tool name strings for hallucination recovery (`fs_write_*`, `<tool_call>`)
- Web search diversity tracking (lines 209-211)

The loop should dispatch to tools through an interface, not know their implementation details.

---

## 5. Missing Design Patterns

### No tool registry / plugin pattern
Tools are defined in three separate places that must stay synchronized:
1. **Schema** — `tools.ts` (tool definitions sent to the model)
2. **Execution** — `search.ts` (the `executeTool` switch)
3. **Display** — `chat.svelte.ts` (the `onToolStart` label switch)

A registry pattern where each tool is a single object `{ schema, execute, displayLabel }` would ensure these can't drift apart.

### No structured error types
All errors across the TypeScript side are serialized as `JSON.stringify({ error: "..." })` strings. The model, the agent loop, and the UI all parse these differently. A `ToolError` class or discriminated union would make error handling more predictable and would also allow the agent loop to distinguish recoverable errors (network timeout → retry) from permanent ones (file not found → report to user).

### No dependency injection for API calls
`search.ts` calls `chatCompletion()` and `invoke()` directly. This makes unit testing require mocking globals. The sub-agent functions (`executeResearchUrl`, `executeEmailSummarizeMessage`) could accept an injected completion function, making them testable without a running Tauri backend.

### Silent database failures
Every DB operation in `chat.svelte.ts` catches and swallows errors:
```typescript
try { await invoke('db_save_message', {...}); } catch { /* non-fatal */ }
```
While "don't crash the UI on a DB write failure" is reasonable, the user has no way to know their conversations aren't being saved. A periodic health check or a one-time warning when the first DB write fails would prevent silent data loss.

---

## 6. Agent Loop Recovery Mechanisms (Complexity Concern)

The agent loop in `loop.ts` has accumulated several recovery/nudge mechanisms:
1. **Truncation continuation** (lines 263-275) — "Continue." on `finish_reason: 'length'`
2. **Malformed tool-call recovery** (lines 287-307) — strips broken XML, nudges retry
3. **Bare URL / naked tool-name detection** (lines 316-325) — breaks out of loop
4. **File-write hallucination recovery** (lines 329-370) — re-prompts up to 2x
5. **Diversity nudge** (lines 372-409) — forces fetching more pages
6. **In-loop context trimming** (lines 247-253) — drops old tool results

Each of these adds a `continue` or `break` branch inside the main `while` loop. The resulting control flow is hard to reason about — a single iteration can hit multiple guards before deciding what to do. Several of these (file-write recovery, diversity nudge) inject synthetic user messages that further confuse the model's sense of conversation flow.

**Recommendation:** Consider whether some of these nudges are compensating for system prompt bloat. If the prompt is simplified and the model makes better first-attempt decisions, several recovery paths may become unnecessary.

---

## 7. Tool Description Bloat

The tool definitions in `tools.ts` also contribute to context pressure. Examples:

- **`fs_write_pdf`** (lines 283-301): The tool description is ~300 tokens and includes full markdown formatting rules, table syntax, page layout details. This is documentation, not a tool description.
- **`fs_write_pptx`** (lines 405-472): ~200 token description with nested `oneOf` JSON schema for bullets.
- **`fs_download_url`** (lines 547-567): ~150 tokens including a "typical presentation flow" example.

Each tool's schema is sent to the model on every agent loop iteration. With filesystem + email tools active, the tool definitions alone are ~2,000+ tokens.

**Recommendation:** Trim descriptions to their functional minimum. The model needs to know what a tool does and what arguments it takes — not how to format markdown tables or a step-by-step workflow for making presentations. Move extended guidance to the system prompt (sparingly) or rely on the agent loop's recovery mechanisms.

---

## 8. Minor Issues

### Deprecated export still present
`tools.ts:743-744` exports `AGENT_TOOLS` marked `@deprecated`. Remove it.

### `findIndex` where `find` would suffice
`chat.svelte.ts:666` — uses `findIndex` then indexes back in. Not a bug but inconsistent with the style elsewhere.

### Conversation search is O(n)
`getActiveConversation()` does `conversations.find(c => c.id === activeConversationId)` on every access. With many conversations this scans the full array repeatedly. A `Map<string, Conversation>` would be O(1).

### `dbAvailable` is a file-scoped `let`, not reactive
`chat.svelte.ts:193` — `dbAvailable` is a plain boolean, not a `$state()`. It works because it's only set once during `initChatStore`, but it's inconsistent with the rest of the store's pattern.

---

## Summary: Priority Ordering

| Priority | Issue | Impact |
|----------|-------|--------|
| **P0** | System prompt bloat | Directly causing the "searches but gives up" behavior. Cut by 50%+ |
| **P0** | Tool description bloat | Compounds prompt bloat. Trim to functional minimums |
| **P1** | `search.ts` god object | 1,091 lines, blocks maintainability. Split into tool modules |
| **P1** | `chat.svelte.ts` god object | 960 lines, too many responsibilities. Extract prompt builder + DB layer |
| **P2** | Filesystem wrapper duplication | ~270 lines of copy-paste. Generic wrappers |
| **P2** | No tool registry pattern | Three parallel switch/definition sites that must stay in sync |
| **P2** | Agent loop complexity | 6 recovery mechanisms piled in one while loop |
| **P3** | Settings as global mutable state | Race condition risk during generation |
| **P3** | Silent DB failures | User has no idea if conversations aren't saving |
| **P3** | No structured error types | Everything is `JSON.stringify({ error })` strings |
