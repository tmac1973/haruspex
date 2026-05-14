# Refactor Phase 3: Chat Store Decomposition

**Branch:** `refactor/chat-store-extraction`
**Priority:** P1
**Risk:** Low — internal restructuring, no behavioral change
**Estimated scope:** 1 file reduced by ~400 lines, 3 new files created
**Depends on:** Phase 2 (tool registry) — the `onToolStart` switch is already gone, reducing chat.svelte.ts by ~50 lines

---

## Goal

Break `chat.svelte.ts` (960 lines) into focused modules. After this phase, the chat store manages conversation state and orchestration only — it delegates prompt construction, database persistence, and message hint injection to dedicated modules.

---

## Extractions

### 1. System prompt builder → `src/lib/agent/system-prompt.ts`

**What moves:**
- `buildSystemPrompt()` function (currently chat.svelte.ts:36-138 after Phase 1 trimming)
- `REVIEW_PATTERNS` regex + `looksLikeReviewQuery()` (lines 18-23)
- `FILE_OUTPUT_PATTERNS` regex + `looksLikeFileOutputRequest()` (lines 29-34)
- The hint-injection logic from `sendMessage` (lines 609-678) — the block that appends review query hints, file-output reminders, and deep-research instructions to the last user message.

**New module's public API:**
```typescript
// src/lib/agent/system-prompt.ts

export function buildSystemPrompt(workingDir: string | null): ChatMessage;
export function looksLikeFileOutputRequest(content: string): boolean;

/**
 * Augment the messages array with per-turn hints based on the user's
 * message content and current settings. Modifies the last user message
 * in-place (appends hint text). Returns the modified array.
 */
export function injectMessageHints(
    messages: ChatMessage[],
    opts: {
        workingDir: string | null;
        exhaustiveResearch: boolean;
    }
): ChatMessage[];
```

**Why this grouping:** The hint-injection logic is tightly coupled to the regex matchers and to the system prompt's expectations (e.g., the file-output hint references `fs_write_pdf` which only exists when the filesystem section is in the system prompt). Keeping them together means prompt-related changes happen in one file.

**Impact on chat.svelte.ts:** Removes ~150 lines (after Phase 1 trimming) and all prompt-related imports (`getResponseFormatPrompt`, `hasEnabledEmailAccount`).

### 2. Database persistence layer → `src/lib/stores/db.ts`

**What moves:**
- `MULTIMODAL_PREFIX` constant (line 211)
- `serializeContent()` / `deserializeContent()` (lines 213-227)
- `dbSaveMessage()` (lines 229-242)
- `dbCreateConversation()` (lines 244-251)
- `dbMessageToChatMessage()` (lines 253-269)
- `loadConversationMessages()` (lines 298-309)
- The DB calls inside `deleteConversation()`, `renameConversation()`, `clearAllConversations()`, `compactIfNeeded()` — these stay in chat.svelte.ts but call thin wrappers from db.ts
- `DbMessage`, `DbConversation`, `DbConversationSummary` interfaces (lines 162-182)

**New module's public API:**
```typescript
// src/lib/stores/db.ts

export function initDb(): Promise<{ available: boolean; summaries: DbConversationSummary[] }>;
export function dbSaveMessage(conversationId: string, msg: ChatMessage): Promise<void>;
export function dbCreateConversation(id: string, title: string): Promise<void>;
export function dbRenameConversation(id: string, title: string): Promise<void>;
export function dbDeleteConversation(id: string): Promise<void>;
export function dbClearAll(): Promise<void>;
export function dbLoadMessages(id: string): Promise<ChatMessage[]>;
export function dbReplaceMessages(conversationId: string, messages: ChatMessage[]): Promise<void>;
export function isDbAvailable(): boolean;
```

**Design decision — error handling:** The current pattern of swallowing all errors stays for now (P3 item). But centralizing the try/catch in db.ts means Phase 5 can add a warning mechanism in one place.

**Impact on chat.svelte.ts:** Removes ~100 lines, eliminates the `dbAvailable` file-scoped variable (replaced by `isDbAvailable()` from the module), and removes the `invoke` import (no longer needed directly).

### 3. Empty-response diagnostics → `src/lib/agent/diagnostics.ts`

**What moves:**
The 50-line empty-response handler from `sendMessage`'s `onComplete` callback (lines 840-918). This block inspects search steps to determine what went wrong and crafts a user-facing error message.

**New module's public API:**
```typescript
// src/lib/agent/diagnostics.ts

/**
 * Given an empty final response and the tool steps that ran,
 * return either a synthesized assistant message (e.g., "File written: report.pdf")
 * or an error message explaining what went wrong.
 */
export function diagnoseEmptyResponse(
    searchSteps: SearchStep[],
    streamingContent: string
): { type: 'commit'; content: string } | { type: 'error'; message: string };
```

**Impact on chat.svelte.ts:** The `onComplete` callback drops from ~80 lines to ~20 lines. The branching logic moves out, and the callback becomes:
```typescript
if (finalContent) {
    commit(finalContent);
} else {
    const diagnosis = diagnoseEmptyResponse(searchSteps, streamingContent);
    if (diagnosis.type === 'commit') commit(diagnosis.content);
    else errorMessage = diagnosis.message;
}
```

---

## What stays in chat.svelte.ts

After all extractions, the chat store contains:
- Conversation state (`conversations`, `activeConversationId`, `isGenerating`, etc.)
- Conversation CRUD (`createConversation`, `deleteConversation`, `setActiveConversation`, etc.)
- `sendMessage()` — still the orchestrator, but now ~200 lines instead of ~400, delegating to:
  - `buildSystemPrompt()` + `injectMessageHints()` for prompt assembly
  - `runAgentLoop()` for execution
  - `diagnoseEmptyResponse()` for empty-response handling
  - `dbSaveMessage()` etc. for persistence
- Citation/source URL management (`extractUrlsFromSteps`, `getSourceUrls`, `renderStreamingHtml`)
- Context usage save/restore

Target: ~500 lines, down from 960.

---

## Testing Plan

Purely structural — no behavioral changes.

1. **Conversation lifecycle** — create, rename, delete, switch between conversations. Messages persist across app restart.
2. **System prompt** — verify via browser devtools (network tab or console log) that the system prompt content is identical to Phase 1's trimmed version.
3. **Hint injection** — ask a review question ("best budget keyboard"), verify "(Include Reddit as a source.)" appears in the API request. Ask for a PDF with a working directory set, verify the file-output hint appears.
4. **Empty response handling** — if reproducible, trigger the "searches but gives up" case and verify the diagnostic error message still appears correctly.
5. **Deep research** — toggle on, verify maxIterations and deepResearch flag are passed correctly.
6. **All tests pass** — `npm run test`, `npm run check`.

---

## Acceptance Criteria

- [ ] `chat.svelte.ts` is under 550 lines
- [ ] `system-prompt.ts` owns all prompt construction and hint injection
- [ ] `db.ts` owns all Tauri invoke calls for database operations
- [ ] `diagnostics.ts` owns the empty-response analysis
- [ ] No circular dependencies introduced
- [ ] All existing tests pass
- [ ] `npm run check` passes
