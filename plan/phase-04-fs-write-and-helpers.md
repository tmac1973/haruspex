# Phase 04 — `fs-write` cleanup + tool helpers

**Severity addressed:** 7–8 · **Effort:** ~4 hours · **Risk:** Low

Resolves duplication-audit T-2 (sub-agent helper), T-3 (spreadsheet schema), T-4 (write-executor factory), T-6 (toolInvokeError), and design-pattern M-3 / M-4.

## Goal

Three independent extractions in one PR. Each is mechanical:

1. **Constants** — `SHEETS_SCHEMA` (and optionally `MARKDOWN_CONTENT_DESCRIPTION`) extracted in `fs-write.ts`.
2. **`writeExecutor`** — factory to deduplicate the 8 identical `execute(...)` blocks in `fs-write.ts`.
3. **`_helpers.ts`** — shared `runSubAgent`, `proxyFetch`, `toolInvokeError`, `labelArg` for use across tool modules.

## Files touched

- **EDIT** `src/lib/agent/tools/fs-write.ts`
- **EDIT** `src/lib/agent/tools/web.ts`
- **EDIT** `src/lib/agent/tools/email.ts`
- **NEW** `src/lib/agent/tools/_helpers.ts`
- **EDIT** `src/lib/agent/tools/types.ts` (or `registry.ts`) — add `toolInvokeError`, `labelArg` here if you prefer not to create `_helpers.ts`. Decide based on what reads naturally.

## Implementation

### Step 1 — `_helpers.ts`

```ts
// src/lib/agent/tools/_helpers.ts
import { invoke } from '@tauri-apps/api/core';
import { chatCompletion, type ChatMessage } from '$lib/api';
import { getSamplingParams, getChatTemplateKwargs, getSettings } from '$lib/stores/settings';
import { toolError } from './types';

export const labelArg = (key: string) =>
	(args: Record<string, unknown>) => (args[key] as string) ?? '';

export function toolInvokeError(command: string, e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	return toolError(`${command} failed: ${msg}`);
}

export async function runSubAgent(
	messages: ChatMessage[],
	maxTokens: number,
	signal?: AbortSignal
): Promise<string> {
	const s = getSamplingParams();
	const resp = await chatCompletion(
		{
			messages,
			temperature: s.temperature,
			top_p: s.top_p,
			top_k: s.top_k,
			presence_penalty: s.presence_penalty,
			max_tokens: maxTokens,
			chat_template_kwargs: getChatTemplateKwargs()
		},
		signal
	);
	return resp.content?.trim() ?? '';
}

export async function proxyFetch(url: string, caller: string): Promise<string> {
	return invoke<string>('proxy_fetch', {
		url,
		caller,
		proxy: getSettings().proxy
	});
}
```

### Step 2 — apply in `web.ts`

- Replace the inline `proxy_fetch` invocations at lines 103–115 and 152–162 with `proxyFetch(url, 'fetch_url')` / `proxyFetch(url, 'research_url')`.
- Replace the sub-agent block at lines 191–213 with:
  ```ts
  try {
      const findings = await runSubAgent(messages, RESEARCH_AGENT_MAX_TOKENS, ctx.signal);
      if (!findings) return toolResult(`Sub-agent returned no findings for ${url}.`);
      return toolResult(`Source: ${url}\nFocus: ${focus}\n\n${findings}`);
  } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      return toolResult(toolInvokeError('research_url sub-agent', e));
  }
  ```

### Step 3 — apply in `email.ts`

- Replace the sub-agent block at lines 231–271 with the same pattern as Step 2, calling `runSubAgent(messages, EMAIL_SUMMARY_MAX_TOKENS, ctx.signal)`.

### Step 4 — `fs-write.ts` constants + executor factory

At the top of `fs-write.ts`:

```ts
const SHEETS_SCHEMA = {
	type: 'array' as const,
	description: 'Array of sheet objects. Each sheet needs a name and rows.',
	items: {
		type: 'object',
		properties: {
			name: { type: 'string', description: 'Sheet name (tab label)' },
			rows: {
				type: 'array',
				description: '2D array: array of rows, each row is an array of cell values.',
				items: { type: 'array', items: { type: 'string' } }
			}
		},
		required: ['name', 'rows']
	}
};

function writeExecutor(
	command: string,
	payload: (args: Record<string, unknown>) => Record<string, unknown>
) {
	return async (args: Record<string, unknown>, ctx: ToolContext) =>
		fsWriteWithConflictCheck(
			command,
			ctx.workingDir!,
			args.path as string,
			payload(args),
			ctx.filesWrittenThisTurn
		);
}
```

Then in each `registerTool` call:

- `fs_write_xlsx` (line 272-287): replace `sheets: { type: 'array', … }` with `sheets: SHEETS_SCHEMA`. Replace `execute` body with `execute: writeExecutor('fs_write_xlsx', (a) => ({ sheets: a.sheets }))`.
- `fs_write_ods` (line 352-366): same — `sheets: SHEETS_SCHEMA`, `execute: writeExecutor('fs_write_ods', (a) => ({ sheets: a.sheets }))`.
- `fs_write_text`, `fs_write_pdf`, `fs_write_docx`, `fs_write_odt`, `fs_write_pptx`, `fs_write_odp` — each becomes a one-line `execute: writeExecutor('fs_write_xxx', payloadFn)`.

Use `labelArg('path')` for every `displayLabel` while you're in here.

### Step 5 — apply `toolInvokeError` elsewhere

Quick grep:

```bash
grep -nE "toolError\(\`.+failed: \$\{e\}\`\)" src/lib/agent/tools
```

Replace each match with `toolInvokeError('command_name', e)`. Keep the command name accurate so error messages still identify the failing tool.

## Build gate

```bash
npm run check
npm run lint
npm run test
```

## Test plan

### Smoke

1. App launches.

### Targeted — fs-write

2. Set a working directory.
3. Run the **Phase 02 steps 5–8** test prompts again (PDF, DOCX, ODT, XLSX, ODS, PPTX, ODP). All formats must work identically.
4. **Conflict path** — write the same path twice; conflict modal still appears.

### Targeted — sub-agent

5. Run a research-mode query: enable **Exhaustive research** in the chat composer (if exposed), then ask:
   > Find current information about the 2026 FIFA World Cup hosts.
   The agent should fire `research_url` against multiple URLs and incorporate the summaries into a final answer. Verify each `research_url` step shows up in the search-step UI with a status and a non-empty summary.

6. **Email summarize** (if you have an enabled email account):
   > Show me my most recent email and summarize it.
   The agent should call `email_list_recent` then `email_summarize_message`. Both should succeed and the summary should be coherent.

### Targeted — error messages

7. Disable network or break the working directory permissions to force a failure on one tool. The error message should now read `<command> failed: <reason>` consistently across tools.

If all pass, commit:

```
refactor: extract tool helpers and fs-write executor factory (#TBD)

Adds src/lib/agent/tools/_helpers.ts with runSubAgent,
proxyFetch, toolInvokeError, and labelArg. Extracts
SHEETS_SCHEMA and writeExecutor() in fs-write.ts so each
fs_write_* tool registers with a one-line execute handler.
Migrates web.ts and email.ts sub-agent calls. No behavioural
change.

Resolves audits/code-duplication-2026-05-14.md T-2, T-3, T-4,
T-6 and design-patterns-2026-05-14.md M-3, M-4.
```
