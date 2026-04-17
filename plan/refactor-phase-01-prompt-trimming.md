# Refactor Phase 1: System Prompt & Tool Description Trimming

**Branch:** `refactor/prompt-trimming`
**Priority:** P0
**Risk:** Medium — behavioral change to every model interaction
**Estimated scope:** 3 files, net deletion of ~300 lines
**Depends on:** Nothing (first phase, no structural prerequisites)

---

## Goal

Cut the system prompt and tool descriptions by 50%+ to reduce instruction overload on the 9B model. This is the highest-impact change: the model is spending tokens parsing rules it can't follow instead of reasoning about the user's question.

---

## Files to Modify

1. `src/lib/stores/chat.svelte.ts` — `buildSystemPrompt()` (lines 36-138)
2. `src/lib/agent/tools.ts` — tool description strings throughout
3. `src/lib/agent/loop.ts` — review whether diversity nudge / file-write recovery text can shrink

---

## Step 1: Trim the main system prompt (chat.svelte.ts)

### 1a. Rewrite the base identity + search rules block (lines 99-134)

**Current (~550 tokens).** Reduce to ~250 tokens. Specific cuts:

- Remove "Many new products, technologies, and events exist that you have ZERO knowledge of." — the model doesn't benefit from being told its training is outdated in this many words. Keep one sentence.
- Collapse MANDATORY SEARCH RULES from 5 bullets to 2: "Search before answering factual questions. Use the user's exact terms."
- Remove WHEN NOT TO SEARCH entirely. The model defaults to not searching for greetings/math — this section exists to override a problem that doesn't exist.
- Collapse SEARCH BEHAVIOR from 4 bullets to 2: "Use fetch_url on 2-4 results before answering. Only cite sources you fetched."
- Collapse INLINE CITATIONS from 8 bullets to 3 essentials: the `[source](URL)` format, use URLs from `[Source: <url>]` headers, don't append a references section.

**Target base prompt:**
```
You are Haruspex, a helpful, private AI assistant running on the user's computer.

Today's date is ${today}. Your training data may be outdated — search before answering questions about products, current events, pricing, or recommendations.

SEARCH RULES:
- Search before answering factual questions. Use the user's exact terms.
- Use fetch_url on 2-4 of the most relevant results before answering.
- Only cite sources you actually fetched. Do not cite URLs from search snippets alone.
- For reviews or "best of" questions, include Reddit alongside review sites.

CITATIONS:
- Cite facts from the web inline as [source](URL). Use the URL from the [Source: <url>] header on each fetched page.
- Each [source](URL) must point to the page where that specific claim appeared.
- Do NOT append a Sources or References section — the UI renders citations automatically.

Be concise, accurate, and helpful. When in doubt, search.
```

### 1b. Rewrite the filesystem section (lines 44-79)

**Current (~1,200 tokens).** Reduce to ~300 tokens. Specific cuts:

- Remove per-tool explanations that duplicate tool descriptions (fs_read_pdf_pages, fs_read_docx, fs_read_xlsx, fs_read_image — all explained in tools.ts already).
- Remove the entire 7-step presentation workflow (lines 72-79). The model doesn't follow it. The file-write recovery in loop.ts handles the failure case.
- Remove OpenDocument format differentiation ("only use ODS when the user specifically asks") — already in tool descriptions.
- Remove "you cannot delete or move files" and "remind the user they must chmod +x" — edge cases the model won't recall.
- Remove FILE OVERWRITE PROTECTION paragraph (line 71) — the Rust backend and conflict modal handle this. The model doesn't need to know.
- Keep: working directory path, "use fs_list_dir first", "only use filesystem tools when user asks", "file writes must happen in the same turn as research".

**Target filesystem section:**
```
FILESYSTEM ACCESS:
- Working directory: ${workingDir}
- Use fs_list_dir first to see what files exist before reading.
- Only use filesystem tools when the user explicitly asks to work with files.
- When the user asks you to create a file, do the research and write the file in the SAME turn — do not dump content as chat text.
```

### 1c. Rewrite the email section (lines 82-96)

**Current (~450 tokens).** Reduce to ~150 tokens. Specific cuts:

- Remove MULTI-ACCOUNT paragraph — UUID vs label matching is handled by the tool schema and backend.
- Remove the listing-size guidance ("default max_results of 25 is right for most single-day requests") — tool schema has this.
- Remove the 4-bullet triage instructions (lines 91-94) — move the key instruction ("pick 3-5 important messages") into the email_list_recent tool description.
- Remove CRITICAL CALL FORMAT paragraph — a 50-token "emit JSON correctly" instruction won't fix tool-call formatting failures.

**Target email section:**
```
EMAIL INTEGRATION:
- The user has connected email accounts. Only use email tools when explicitly asked about email.
- Use email_list_recent first, then email_summarize_message on the 3-5 most important messages. Skip newsletters and automated notifications unless asked.
- Use email_read_full only when the user needs verbatim text.
```

---

## Step 2: Trim tool descriptions (tools.ts)

### 2a. Web tools — minor trims

- `web_search`: Fine as-is (~30 tokens).
- `fetch_url`: Fine as-is (~50 tokens).
- `research_url`: Trim the example list ("pricing tiers and free plan limits", "criticisms or downsides"...) — ~20 token save.
- `image_search`: Trim the licensing explanation. Keep "Searches Wikimedia Commons for freely-licensed images." Remove the full field list and the "For a specific manufacturer product photo" workflow — that's in the system prompt guidance. ~60 token save.
- `fetch_url_images`: Trim the licensing note and the comparison with image_search. Keep functional description. ~60 token save.

### 2b. Filesystem read tools — minor trims

- `fs_read_pdf`: Fine.
- `fs_read_pdf_pages`: Remove the "IMPORTANT: only call this for ONE PDF at a time" constraint — this is enforced programmatically in search.ts (the pending images guard). ~40 token save.
- `fs_read_xlsx`: Fine.

### 2c. Filesystem write tools — significant trims

- **`fs_write_pdf` (currently ~300 tokens):** This is the biggest offender. The description contains full markdown formatting rules, table syntax, and page layout guidance. Reduce to ~60 tokens: "Create a PDF report from markdown content. Use # for headings. Supports bold, italic, code, bullet lists, and markdown tables."
- **`fs_write_pptx` (currently ~200 tokens):** Trim to ~60 tokens: "Create a PowerPoint presentation. Each slide has a title and optional bullets (plain strings or {text, level} objects for nesting). Optional per-slide image path."
- **`fs_write_odp`:** Same trim as pptx — it's a near-duplicate description.
- **`fs_write_docx`, `fs_write_odt`:** Minor trims, already reasonable.
- **`fs_write_xlsx`, `fs_write_ods`:** Fine.
- **`fs_download_url` (currently ~150 tokens):** Remove the "typical presentation flow" example and the full list of blocked extensions. Keep: "Download a file from a URL into the working directory. 50 MB limit. Executable formats are blocked." ~40 tokens.

### 2d. Email tools — moderate trims

- `email_list_recent`: The description is ~180 tokens. Trim the behavioral guidance ("Strongly prefer this as the first email tool call", "do NOT try to summarize every message") — that's system prompt territory. Trim the account_id description that explains UUID vs label matching in 80 tokens. Keep functional schema. Target ~80 tokens.
- `email_summarize_message`: Trim to ~40 tokens. "Summarize a single email message via a focused sub-agent. Returns a 2-4 sentence summary."
- `email_read_full`: Fine as-is (~40 tokens).

---

## Step 3: Review agent loop nudge text (loop.ts)

The recovery messages injected by the agent loop are also part of the model's context. Review:

- **File-write hallucination nudge (lines 353-368):** Currently ~100 tokens. This is fine — it fires at most 2x per turn.
- **Diversity nudge (lines 391-407):** Currently ~80 tokens. Fine.
- **Malformed tool-call nudge (lines 297-306):** Currently ~60 tokens. Fine.
- **Max-iterations final nudge (lines 543-547):** 1 sentence, fine.

No changes needed here — these are situational and small.

---

## Step 4: Remove deprecated export

Delete `tools.ts:743-744`:
```typescript
/** @deprecated Use getAgentTools(hasWorkingDir) instead. */
export const AGENT_TOOLS: ToolDefinition[] = WEB_TOOLS;
```

Verify no remaining imports of `AGENT_TOOLS` elsewhere.

---

## Testing Plan

After this phase, the app should behave identically in terms of features but the model should produce answers more reliably. Testing:

1. **Basic chat** — greetings, math, coding questions should work as before (no search triggered).
2. **Web search** — "What's the best budget mechanical keyboard in 2026?" should search, fetch 2-4 URLs, and produce an answer with inline citations. This is the key regression test — the model should no longer "give up" after searching.
3. **File operations** (with working directory set):
   - "List the files in this directory" — should call fs_list_dir.
   - "Create a PDF report on X" — should research and call fs_write_pdf in the same turn.
   - "Read that docx file" — should call fs_read_docx.
4. **Email** (with account configured):
   - "Summarize my recent email" — should list, pick 3-5, summarize.
5. **Deep research toggle** — enable, ask a broad question. Should fan out across 4+ sources.
6. **Citation quality** — check that [source](URL) links in answers point to the correct pages.

**Key metric:** Count how often the model searches but returns no answer. Before this change, it's reportedly frequent. After, it should be rare.

---

## Rollback

If trimming causes regressions (model stops searching when it should, citations break), individual sections can be restored independently. The branch structure makes this easy to bisect.
