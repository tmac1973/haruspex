# Phase 01 — Lean setting, tool set and system prompt

**Depends on:** nothing · **Enables:** every later phase (they all read
`leanMode`); phase 05 relies on the tool filter covering remote Chat turns

## Goal

Add the `leanMode` setting and make a Chat turn honour it: a fixed, small tool
list and a system prompt that names only what that list can do. No UI yet. The
setting is off by default, so nothing a user sees changes. This phase carries
the whole prompt-size win. It can be tested on its own by flipping the setting
in `webview-store.json`.

## Files touched

- `src/lib/stores/settings.ts`: add `leanMode: boolean` to `AppSettings`,
  `leanMode: false` to `defaults`, and `getLeanMode()` / `setLeanMode(on)`
  helpers next to the other single-field getters.
- `src/lib/agent/tools/leanProfile.ts` (new): `LEAN_CHAT_TOOLS` and
  `isLeanTurn(filter)`.
- `src/lib/agent/tools/registry.ts`: apply the lean profile in `schemaFor`.
- `src/lib/agent/tools/types.ts`: add `lean: boolean` to `ToolFilterOpts`.
- `src/lib/agent/tools/leanProfile.test.ts` (new): tool set and size tests.
- `src/lib/agent/systemPrompt.ts`: a `lean` option that drops sections.
- `src/lib/agent/systemPrompt.test.ts`: lean prompt tests.
- `src/lib/stores/chat.svelte.ts`: pass `lean: getSettings().leanMode` to
  `buildSystemPrompt` (~:1150).

## Steps

1. **Setting.** Add the field, default and helpers in `settings.ts`. `load()`
   spreads `defaults` first, so a missing key needs no migration. Add a
   one-line doc comment on the field: "Chat and research only: a small tool
   set, no Code or Shell tab. Settings → General → Lean mode."
2. **Profile module.** Create `leanProfile.ts`:
   ```ts
   /** What a lean Chat turn may offer, by name. A tool not listed is out. */
   export const LEAN_CHAT_TOOLS = new Set([
   	'web_search',
   	'fetch_url',
   	'research_url',
   	'image_search',
   	'haruspex_docs',
   	'remember_this',
   	'load_skill',
   	'read_skill_file',
   	'fs_list_dir',
   	'fs_read_text',
   	'fs_read_pdf',
   	'fs_read_pdf_pages',
   	'fs_read_docx',
   	'fs_read_xlsx',
   	'fs_read_image'
   ]);
   /** A Chat turn while lean mode is on. Code, Shell and allowlisted turns are not. */
   export function isLeanTurn(f: ToolFilterOpts): boolean {
   	return f.lean && !f.codeMode && !f.shellMode;
   }
   ```
   `fetch_url_images`, `ask_user_question`, `tasks`, `haruspex_feedback` and
   every write, sandbox, media, email, calendar, contacts, screen and MCP tool
   are deliberately absent.
3. **Filter.** In `getToolSchemas`, set `lean: getSettings().leanMode` in the
   `filter` object. The `toolAllowlist` branch returns before the filter is
   built, so jobs and guest chats keep their exact allowlists. In
   `schemaFor`, add as its first line:
   `if (isLeanTurn(filter) && !LEAN_CHAT_TOOLS.has(reg.schema.function.name)) return null;`
   The rest of `schemaFor` then runs as before. That keeps the existing gates
   for kept tools: `fs_*` needs a working folder, `fs_read_image` needs vision,
   `remember_this` needs writable memory, skills tools need skill names, and
   `fetch_url` is dropped in deep research.
4. **Tests** in `leanProfile.test.ts`, with settings mocked to `leanMode: true`
   and every integration on: email and sendable email, calendar, contacts,
   screen capture, image, music and video backends, sandbox, memory writable,
   and an enabled MCP tool registered.
   - With `hasWorkingDir: true, interactive: true, visionSupported: true,
deepResearch: false`, plus skill names and file names: the returned names
     equal `LEAN_CHAT_TOOLS` (all of them present).
   - The same call: the sum of `JSON.stringify(schema).length` is `<= 9500`.
   - `codeMode: true` and `shellMode: true` return their normal sets, which are
     unchanged by lean mode.
   - A `toolAllowlist` call returns the allowlist, unchanged by lean mode.
   - With `leanMode: false`, the Chat set is unchanged (snapshot of the names).
5. **System prompt.** Add `lean?: boolean` to `SystemPromptOptions`. When it is
   set, `buildSystemPrompt`:
   - leaves out `emailSection`, the CONNECTED INTEGRATIONS section, the PYTHON
     SANDBOX section, `sandboxFsSection` and `imagesSection`, and the feedback
     section (lean has no `haruspex_feedback`);
   - replaces the FILESYSTEM ACCESS body with a read-only version: the working
     directory line, the `fs_list_dir` line, the "only when asked" line, and
     "You can read files here but not create or change them. Put what the user
     asked for in your reply."
   - keeps SEARCH RULES, citations, the guide line, memory and skills. Any of
     these that names a tool outside `LEAN_CHAT_TOOLS` (for example
     `create_skill` in the skills section) gets that sentence left out when
     `lean` is set; the guard test in step 7 finds every such sentence.
     Toggling lean mode mid-conversation changes the tool list and prompt once,
     which costs one prompt-cache miss; that is accepted.
6. **Chat caller.** In `chat.svelte.ts`, pass `lean: getSettings().leanMode`.
   `runEphemeralTurn.ts` is not changed: its callers are jobs and guest chats
   (`guest-chat.md`), which run on allowlists. Remote control Chat turns are
   not guests: `chat.send` in `src/lib/engine/chat.svelte.ts:206` calls
   `sendMessageTo`, the desktop Chat path, so they get the lean set here.
7. **Prompt tests** in `systemPrompt.test.ts`: with `lean: true` and email,
   sandbox and MCP mocked on, the prompt contains none of `EMAIL INTEGRATION`,
   `CONNECTED INTEGRATIONS`, `PYTHON SANDBOX` or `fs_write_`. It still contains
   `SEARCH RULES`, and it contains the read-only FILESYSTEM text when it has a
   working directory.
   Guard test: build the lean prompt with a working directory, memory and a
   skills section, collect every registered tool name (from the registry, with
   all tools registered through `tools/index.ts`), and assert that each name
   that appears in the prompt text is in `LEAN_CHAT_TOOLS`.

## Build gate

```bash
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- Automated: the tests in steps 4 and 7.
- Live: set `"leanMode": true` in the dev build's `webview-store.json`, start a
  Chat with a working folder, and check the debug log's request. It should list
  only lean tools, and the prompt should have no EMAIL or SANDBOX section. Then
  ask a research question and confirm that `web_search` and `research_url`
  work.

## Commit

`feat(chat): add a lean mode tool set and prompt for small models`

PR label `no-docs`: the setting has no UI yet.

## Rollback

Revert the commit. A leftover `leanMode` key in stored JSON is harmless:
`load()` spreads it and nothing reads it. Safe to leave applied on its own.
