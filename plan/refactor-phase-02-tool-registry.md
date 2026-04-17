# Refactor Phase 2: Tool Registry & search.ts Decomposition

**Branch:** `refactor/tool-registry`
**Priority:** P1/P2
**Risk:** Low — internal restructuring, no behavioral change
**Estimated scope:** 1 file deleted, 7 files created, 3 files modified
**Depends on:** Phase 1 (prompt trimming) — not a hard dependency but avoids conflicts since both touch tools.ts

---

## Goal

Replace the three parallel tool-definition sites (schema in `tools.ts`, execution in `search.ts`, display labels in `chat.svelte.ts`) with a unified tool registry. Then split the 1,091-line `search.ts` into focused modules. After this phase, adding a new tool means adding one file in one place.

---

## Architecture

### Tool registration interface

```typescript
// src/lib/agent/tools/types.ts

export interface ToolRegistration {
    /** OpenAI-compatible tool schema sent to the model */
    schema: ToolDefinition;
    /** Execute the tool, return result string + optional attachment */
    execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecOutput>;
    /** Extract a human-readable label from tool arguments for the search step UI */
    displayLabel: (args: Record<string, unknown>) => string;
    /** Tool categories for filtering (e.g., 'web', 'fs', 'email') */
    category: 'web' | 'fs' | 'email';
    /** Whether this tool requires vision capability */
    requiresVision?: boolean;
}

export interface ToolContext {
    workingDir: string | null;
    signal?: AbortSignal;
    pendingImages: PendingImage[];
    deepResearch: boolean;
    filesWrittenThisTurn: Set<string>;
}
```

### Registry

```typescript
// src/lib/agent/tools/registry.ts

const tools = new Map<string, ToolRegistration>();

export function registerTool(reg: ToolRegistration): void { ... }
export function getTool(name: string): ToolRegistration | undefined { ... }
export function getToolSchemas(opts: { hasWorkingDir, deepResearch, visionSupported, hasEmail }): ToolDefinition[] { ... }
export function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecOutput> { ... }
export function getDisplayLabel(name: string, args: Record<string, unknown>): string { ... }
```

---

## Files to Create

### 1. `src/lib/agent/tools/types.ts`
- `ToolRegistration` interface
- `ToolContext` interface
- `ToolExecOutput` interface (moved from search.ts)
- `PendingImage` interface (moved from search.ts)
- `toolError(msg: string): string` helper — replaces all `JSON.stringify({ error: ... })` calls
- `toolResult(s: string): ToolExecOutput` helper — replaces the `r()` function from search.ts

### 2. `src/lib/agent/tools/registry.ts`
- Tool map + registration function
- `getToolSchemas()` — replaces `getAgentTools()` from tools.ts. Handles the filtering logic (deepResearch removes fetch_url, no workingDir removes fs tools, no email removes email tools, no vision removes vision tools).
- `executeTool()` — replaces the 30-arm switch. Looks up by name, calls `execute()`.
- `getDisplayLabel()` — replaces the onToolStart switch in chat.svelte.ts.

### 3. `src/lib/agent/tools/web.ts`
Move from search.ts:
- `executeWebSearch()` (lines 138-156)
- `executeFetchUrl()` (lines 172-183)
- `executeResearchUrl()` (lines 199-269)
- `executeFetchUrlImages()` (lines 720-733)
- `executeImageSearch()` (lines 735-751)
- `paywallErrorMessage()` helper (lines 164-169)

Each function gets a corresponding `ToolRegistration` object that bundles its schema (from current tools.ts), execution, and display label extraction.

Register 5 tools: `web_search`, `fetch_url`, `research_url`, `image_search`, `fetch_url_images`.

### 4. `src/lib/agent/tools/fs-read.ts`
Move from search.ts:
- `executeFsListDir()` + `formatDirListing()` (lines 510-539)
- `executeFsReadText()` (lines 541-547)
- `executeFsReadPdf()` (lines 549-555)
- `executeFsReadDocx()` (lines 557-563)
- `executeFsReadXlsx()` (lines 565-575)
- `executeFsReadImage()` (lines 848-868)
- `executeFsReadPdfPages()` (lines 870-886)

**Deduplicate** the read wrappers here. Replace the 4 identical try/catch/invoke functions with:
```typescript
async function fsRead(command: string, workdir: string, relPath: string, extra?: Record<string, unknown>): Promise<string> {
    try {
        return await invoke<string>(command, { workdir, relPath, ...extra });
    } catch (e) {
        return toolError(`${command} failed: ${e}`);
    }
}
```

Then each registration's `execute` calls `fsRead('fs_read_text', ctx.workingDir, args.path)`.

Register 7 tools: `fs_list_dir`, `fs_read_text`, `fs_read_pdf`, `fs_read_pdf_pages`, `fs_read_docx`, `fs_read_xlsx`, `fs_read_image`.

### 5. `src/lib/agent/tools/fs-write.ts`
Move from search.ts:
- `resolveWritePathInteractive()` (lines 67-118)
- `userCanceledWriteError()` (lines 124-130)
- All 7 write functions + `executeFsDownloadUrl()` + `executeFsEditText()`

**Deduplicate** the write wrappers. Replace the 7 identical resolve/invoke/track patterns with:
```typescript
async function fsWriteWithConflictCheck(
    command: string,
    workdir: string,
    relPath: string,
    payload: Record<string, unknown>,
    filesWrittenThisTurn: Set<string>
): Promise<ToolExecOutput> {
    const resolved = await resolveWritePathInteractive(workdir, relPath, filesWrittenThisTurn);
    if (!resolved) return userCanceledWriteError(relPath, command);
    try {
        await invoke(command, { workdir, relPath: resolved.finalPath, ...payload, overwrite: resolved.overwrite });
        filesWrittenThisTurn.add(resolved.finalPath);
        return toolResult(`Wrote: ${resolved.finalPath}`);
    } catch (e) {
        return toolResult(toolError(`${command} failed: ${e}`));
    }
}
```

Then each registration calls `fsWriteWithConflictCheck('fs_write_pdf', ...)` with its specific payload shape.

This collapses ~270 lines of boilerplate into ~30 lines of generic wrapper + per-tool one-liners.

Register 10 tools: `fs_write_text`, `fs_write_docx`, `fs_write_pdf`, `fs_write_xlsx`, `fs_write_odt`, `fs_write_ods`, `fs_write_pptx`, `fs_write_odp`, `fs_download_url`, `fs_edit_text`.

### 6. `src/lib/agent/tools/email.ts`
Move from search.ts:
- `resolveEmailAccounts()` (lines 326-335)
- `executeEmailListRecent()` (lines 337-385)
- `executeEmailReadFull()` (lines 387-403)
- `executeEmailSummarizeMessage()` (lines 416-506)
- Related interfaces: `EmailListing`, `NormalizedEmailMessage`, `EmailSummarizerInput`
- `EMAIL_SUMMARY_MAX_TOKENS` constant

Register 3 tools: `email_list_recent`, `email_summarize_message`, `email_read_full`.

### 7. `src/lib/agent/tools/index.ts`
Barrel file that:
- Imports all tool modules (web, fs-read, fs-write, email) to trigger registration
- Re-exports the registry's public API: `getToolSchemas`, `executeTool`, `getDisplayLabel`
- Re-exports types: `ToolExecOutput`, `PendingImage`, `ToolContext`

---

## Files to Modify

### 1. `src/lib/agent/loop.ts`
- Replace `import { executeTool } from '$lib/agent/search'` with `import { executeTool } from '$lib/agent/tools'`
- Replace `import { getAgentTools } from '$lib/agent/tools'` with `import { getToolSchemas } from '$lib/agent/tools'`
- Replace `getAgentTools(...)` call with `getToolSchemas(...)`
- The `PendingImage` import moves to `'$lib/agent/tools'`

### 2. `src/lib/stores/chat.svelte.ts`
- Replace the `onToolStart` 25-arm switch (lines 716-768) with a call to `getDisplayLabel(call.name, call.arguments)`.
- Remove the import of `getAgentTools` (no longer used here — it was only referenced indirectly).

### 3. `src/lib/agent/search.ts` → DELETE
After all functions have been moved to tool modules, this file is empty. Delete it.

---

## Files to Delete

1. `src/lib/agent/tools.ts` — replaced by `tools/` directory
2. `src/lib/agent/search.ts` — split into `tools/web.ts`, `tools/fs-read.ts`, `tools/fs-write.ts`, `tools/email.ts`

---

## Migration Strategy

To avoid a single massive commit, work in sub-steps:

1. **Create types.ts + registry.ts** with the interfaces and empty registry.
2. **Move web tools** — create `tools/web.ts`, register the 5 web tools, update loop.ts imports. Test: web search still works.
3. **Move fs-read tools** — create `tools/fs-read.ts` with the generic `fsRead` wrapper. Register 7 tools. Test: file reads work.
4. **Move fs-write tools** — create `tools/fs-write.ts` with the generic `fsWriteWithConflictCheck` wrapper. Register 10 tools. Test: file writes work, conflict modal still fires.
5. **Move email tools** — create `tools/email.ts`. Register 3 tools. Test: email listing + summarization work.
6. **Create index.ts barrel**, update remaining imports in `chat.svelte.ts`, delete `search.ts` and old `tools.ts`.

Each sub-step is a separate commit on the branch so regressions are easy to bisect.

---

## Testing Plan

This phase is purely structural — no behavioral changes. Every feature should work identically.

1. **Web search + citations** — same as Phase 1 test.
2. **File reads** — open working directory, list files, read a text file, read a PDF, read an image (vision).
3. **File writes** — create a PDF, create a docx, create a pptx. Verify file-conflict modal appears when overwriting.
4. **Email** — list recent, summarize, read full.
5. **Deep research** — verify fetch_url is still filtered out, research_url still works.
6. **Existing tests pass** — `npm run test` should still pass. Key test files: `search.test.ts`, `parser.test.ts`, `paywall.test.ts`.

Note: `search.test.ts` will need import path updates to point to the new tool module locations.

---

## Acceptance Criteria

- [ ] No file in `src/lib/agent/tools/` exceeds 300 lines
- [ ] `search.ts` is deleted
- [ ] Old `tools.ts` is deleted
- [ ] Adding a hypothetical new tool requires touching exactly 1 file (new tool module + register call)
- [ ] The `onToolStart` switch in chat.svelte.ts is replaced with a single function call
- [ ] The `executeTool` switch in search.ts is replaced with a registry lookup
- [ ] All existing tests pass
- [ ] `npm run check` passes (no TypeScript errors)
