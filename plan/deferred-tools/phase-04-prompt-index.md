# Phase 04 — The tool index in the prompt

**Depends on:** phase 03 · **Enables:** phase 05

## Goal

Tell the model which families it can load, and remove the prompt text that
describes deferred tools in detail. Without this, the model has `load_tools`
but no reason to call it.

## Files touched

- `src/lib/agent/tools/deferred.ts`: `toolIndexSection(deferred)`.
- `src/lib/agent/systemPrompt.ts`: a `toolIndex?: string` option, placed
  before the custom instructions.
- `src/lib/code/systemPrompt.ts`: the same option for the Code prompt.
- `src/lib/stores/chat.svelte.ts` and the Code turn's caller: pass the index
  when `deferOn` is true.
- `src/lib/agent/systemPrompt.ts` `injectMessageHints`: preload documents.
- Tests next to each.

## Steps

1. **Index section.**

   ```
   MORE TOOLS (call load_tools with the family first):
   - video — edit the episodes in the working folder with Kdenlive: probe, cut, captions, render
   - email — read, summarise and draft the user's email
   ```

   One line per family in this turn's `deferred`. The section must not change
   during a conversation. Phase 01 showed that on llama-server, with the
   hybrid Qwen models, any change before the tail makes it process the whole
   prompt again. So a loaded family stays in the list as it was. The
   `load_tools` result, at the tail, is what tells the model it is loaded.

   The list does change when the user turns an integration on or off. That
   costs one full prompt process, as it does today.

2. **Sections that describe deferred tools.** When a family is deferred,
   `buildSystemPrompt` leaves out the text that only serves it, loaded or not
   (the prompt must not change when a family loads). The text goes in the
   family's `load_tools` result (`familyNotes`, carried as
   `DeferredFamily.notes`):
   - EMAIL INTEGRATION's tool-by-tool steps move into the `load_tools` result
     for `email`. The CONNECTED INTEGRATIONS line stays, so the model knows
     email exists.
   - The FILESYSTEM ACCESS sentence about `fs_write_document` / `_spreadsheet`
     / `_slides`, and the PYTHON SANDBOX bullet about them, move into the
     `documents` result.
   - IMAGE MODELS moves into the `images` result.
   - In the Code prompt, the TOOLS lines for `make_asset`, the music tools
     and `generate_speech` move into their results.

   The prompt needs the turn's families before the loop starts, so Chat and
   the Code tab decide the turn's tools first (`resolveTurnTools` in
   `agent/loop/turnTools.ts`) and hand the same result to the prompt builder
   and to the loop (`AgentLoopOptions.turnTools`). The index and the
   `load_tools` enum cannot disagree.

   A test asserts that no deferred tool name appears in the system text
   except in the index.

3. **Preload.** When `looksLikeFileOutputRequest` matches and the documents
   family is offered, load it before the turn starts: add the marker as if
   the model had called `load_tools`. The existing file-output hint then names
   tools the model has.
4. **Tests.**
   - With everything on, the schemas sent plus the index are under 20 KB in
     Chat and 16 KB in the Code tab (the overview's measure). Measured
     2026-11-01: 19,526 and 15,303 characters; the Chat system prompt itself
     is 6,218.
   - The index lists exactly the deferred families of the turn.
   - The guard test from step 2.
   - A file-output request starts with the documents family loaded.

## Build gate

```bash
npm run check && npm run lint && npm run format:check && npm run test
```

## Commit

`feat(prompt): list deferred tool families in the system prompt`

PR label `no-docs`: still behind a setting with no UI.

## Rollback

Revert the commit. Phase 03 still works, but the model is not told about the
families.
