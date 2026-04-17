# Refactor Phase 5: Error Handling & Minor Cleanup

**Branch:** `refactor/error-handling-cleanup`
**Priority:** P3
**Risk:** Low — incremental improvements, no architectural changes
**Estimated scope:** ~10 files touched with small changes each
**Depends on:** Phase 2 (tool registry provides centralized error handling point), Phase 3 (db.ts centralizes DB error handling)

---

## Goal

Address the remaining P3 items from the code review: structured error types, silent DB failure warnings, and minor code quality issues. These are small improvements that become easy to implement once the earlier phases have established cleaner module boundaries.

---

## Step 1: Structured tool error type

### Problem
Tool errors are serialized as `JSON.stringify({ error: "..." })` strings throughout the codebase. The agent loop, the chat store, and the model all parse these differently. There's no way to distinguish a recoverable error (network timeout) from a permanent one (file not found).

### Implementation

In `src/lib/agent/tools/types.ts` (created in Phase 2), add:

```typescript
export interface ToolSuccess {
    ok: true;
    result: string;
    thumbDataUrl?: string;
}

export interface ToolFailure {
    ok: false;
    error: string;
    /** Whether this error is likely transient and worth retrying */
    retryable: boolean;
}

export type ToolOutcome = ToolSuccess | ToolFailure;
```

Update the `toolError()` and `toolResult()` helpers from Phase 2:
```typescript
export function toolError(msg: string, retryable = false): ToolOutcome {
    return { ok: false, error: msg, retryable };
}

export function toolSuccess(result: string, thumbDataUrl?: string): ToolOutcome {
    return { ok: true, result, thumbDataUrl };
}
```

### Migration path

The current `ToolExecOutput` type (`{ result: string; thumbDataUrl?: string }`) is used by:
- Every tool execute function (return type)
- `executeTool` in the registry (return type)
- `loop.ts` (reads `.result` and `.thumbDataUrl`)

The registry's `executeTool` should return `ToolOutcome`. The agent loop then:
- On `ToolSuccess`: sends `outcome.result` to the model as the tool message
- On `ToolFailure`: sends `outcome.error` to the model, and can optionally log or count failures

For the model's perspective, nothing changes — it still sees a string. The structured type is for the TypeScript side to make decisions.

Internally, each tool module converts its current `JSON.stringify({ error })` returns to `toolError(msg)` calls. The `toolError` helper serializes to the same JSON string for the model but also carries the structured metadata.

### Scope limitation
Do NOT add retry logic in this phase. The structured error type enables future retry logic, but implementing it is a separate concern. This phase only replaces string errors with typed errors.

---

## Step 2: DB failure awareness

### Problem
Every DB operation in `db.ts` (extracted in Phase 3) swallows errors silently. The user has no indication when their conversations aren't being saved.

### Implementation

Add a failure counter and a one-time warning mechanism in `db.ts`:

```typescript
let dbFailureCount = 0;
let dbWarningShown = false;

async function dbOp<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (!available) return undefined;
    try {
        const result = await fn();
        dbFailureCount = 0;  // reset on success
        return result;
    } catch (e) {
        dbFailureCount++;
        if (dbFailureCount >= 3 && !dbWarningShown) {
            dbWarningShown = true;
            console.error('[db] Multiple consecutive failures — conversations may not be saving', e);
            // Expose via a reactive getter so the UI can show a warning banner
            dbDegraded = true;
        }
        return undefined;
    }
}

let dbDegraded = $state(false);
export function isDbDegraded(): boolean { return dbDegraded; }
```

In the UI (`+page.svelte` or `+layout.svelte`), check `isDbDegraded()` and show a non-intrusive warning banner: "Conversation history may not be saving. Check the app logs for details."

### Scope
- The warning is one-time per session (resets on app restart).
- Three consecutive failures trigger the warning — a single transient failure is ignored.
- No retry logic. No user action required. Just awareness.

---

## Step 3: Minor code quality fixes

### 3a. Remove deprecated export
`tools.ts` is deleted in Phase 2, so this is already done. Verify no references to `AGENT_TOOLS` remain anywhere.

### 3b. Conversation lookup optimization
In `chat.svelte.ts`, `getActiveConversation()` currently does:
```typescript
return conversations.find(c => c.id === activeConversationId);
```

This is called frequently (every getter, every `sendMessage`, etc.). Replace with an index:
```typescript
let conversationIndex = $state(new Map<string, Conversation>());

// Update the index whenever conversations changes
function rebuildIndex() {
    conversationIndex = new Map(conversations.map(c => [c.id, c]));
}

export function getActiveConversation(): Conversation | undefined {
    if (!activeConversationId) return undefined;
    return conversationIndex.get(activeConversationId);
}
```

Call `rebuildIndex()` in `createConversation`, `deleteConversation`, and `initChatStore`.

Note: with Svelte 5 runes, updating `conversationIndex` via `$state` ensures reactivity propagates. The `conversations` array remains the source of truth for ordering (sidebar list); the map is a lookup cache.

### 3c. Consistent `dbAvailable` pattern
After Phase 3 extracts `db.ts`, the `dbAvailable` flag lives in db.ts as module state. This is already addressed. Verify it's not duplicated.

### 3d. `findIndex` cleanup
In `system-prompt.ts` (after Phase 3 extraction), the hint-injection code uses `findIndex` to locate the last text part in a multimodal message. Review and simplify to `findLast` or a `for` loop if cleaner.

---

## Testing Plan

1. **Tool errors** — trigger known error paths:
   - Search with no internet → `ToolFailure` with error message displayed
   - Read a nonexistent file → error shown to model, model reports it
   - Write to a path where user cancels conflict → canceled error
2. **DB degradation warning** — temporarily break the DB (e.g., corrupt the file or block the invoke) and verify the warning banner appears after 3 failures. Verify normal operation shows no banner.
3. **Conversation lookup** — create 10+ conversations, rapidly switch between them. Verify no lag or incorrect conversation loading.
4. **All tests pass** — `npm run test`, `npm run check`.

---

## Acceptance Criteria

- [ ] All tool execute functions return `ToolOutcome` instead of `ToolExecOutput`
- [ ] No raw `JSON.stringify({ error })` calls remain in tool modules
- [ ] DB degradation warning appears in UI after 3+ consecutive failures
- [ ] `getActiveConversation()` uses Map lookup
- [ ] No deprecated exports remain
- [ ] All existing tests pass (with type updates)
- [ ] `npm run check` passes
