# Phase 04 — Web preview helper and `show_preview`

**Depends on:** 03 · **Enables:** the Preview buttons (05), which follow the
same helper switch

## Goal
A `preview` helper (Settings → Code → Helpers → Web preview), on by default,
that offers the agent `show_preview`: open an `.html` file from the session
folder in the session's preview window and return its URL.

## Files touched
- `src/lib/helpers/registry.ts` — `HelperDef.defaultOn?: boolean`;
  `helperOn(id)` returns `codeHelpers[id] ?? def.defaultOn === true`.
- `src/lib/helpers/registry.test.ts` — cases for `defaultOn`.
- `src/lib/components/settings/HelpersSection.svelte` — checked state from
  `helperOn(h.id)` instead of `on[h.id] === true`; doc comment no longer says
  "each off by default".
- `src/lib/components/settings/HelpersSection.test.ts` — a default-on helper
  renders checked with nothing stored.
- `src/lib/helpers/preview/helper.ts` — new: `registerHelper` for `preview`.
- `src/lib/helpers/index.ts` — import it.
- `src/lib/agent/tools/show-preview.ts` — new: the tool.
- `src/lib/agent/tools/show-preview.test.ts` — new.
- `src/lib/agent/tools/index.ts` — import the tool module (where the others
  are imported).
- `src/lib/code/sessionView.ts` — `CodeSessionCapabilities.previewWindow`;
  `true` in `ALL_CAPABILITIES`.
- `src/lib/peers/remoteCodeSession.svelte.ts` — `previewWindow: false` in
  `REMOTE` (a session on another computer).

## Steps
1. Registry: add `defaultOn`; `helperOn` uses the stored value when it is a
   boolean, else `defaultOn`. `sessionHelpers` is unchanged (it calls
   `helperOn`). A user who turned it off stays off (stored `false`).
2. Helper def: `id: 'preview'`, `label: 'Web preview'`,
   `summary: 'Opens web pages the agent writes in a preview window.'`,
   `tooltip: 'Serves the session folder on this computer only and reloads when the page's files change. With the Playwright server installed, the agent can open the same address to take screenshots.'`,
   `tools: ['show_preview']`, `writes: false`, `defaultOn: true`,
   `prompt: '- show_preview — open an .html file from the project in a preview window the user sees; it reloads on change. Returns the page's address, which browser_navigate can open.'`
3. `show_preview` schema: `{ path: string }` (relative to the session folder,
   or absolute inside it), required.
4. `execute`:
   - refuse without `ctx.codeSessionId`;
   - refuse when the session's capabilities have `previewWindow: false`
     ("This session's folder is on another computer.") or the session has a
     `wslDistro` ("Previews don't work for WSL folders yet.");
   - make the path relative to `ctxCwd(ctx)` (an absolute path inside it is
     stripped to relative; anything else is passed through as given);
   - `const url = await openPreview(ctx.codeSessionId, ctxCwd(ctx), rel)`;
     Rust's `preview_serve` checks it is inside the folder, exists and is
     HTML, and a rejection becomes `toolError(message)`;
   - result: `Opened <rel> in the preview window on this computer. Address: <url>`,
     the same wording whether the turn came from the desktop or the remote web
     client.
5. `displayLabel: (args) => String(args.path ?? '')`, so the step card links
   the file like other file tools.

## Build gate
- `npm run check && npm run lint && npm run test`

## Test plan
- `registry.test.ts`: default-on helper is on with nothing stored, off with
  `false` stored; default-off helpers unchanged.
- `show-preview.test.ts` with `openPreview` mocked: a relative path and an
  absolute path inside the root reach it as the same relative path; a
  rejection from it becomes a tool error with its message; a WSL session and a
  session on another computer are refused before it is called; the result
  carries the URL. (The path checks themselves are phase 01's Rust tests.)
- Hand test with the fake LLM or a real model via `npm run drive`: ask for a
  one-page mockup, see the window open and reload on the next edit; with
  Playwright installed, `browser_navigate` to the returned address runs
  without a prompt.

## Commit
`feat(code): show_preview helper opens a session's web page in a window`

## Rollback
Revert the commit. `defaultOn` is additive; reverting it returns every helper
to off-by-default with no stored data to clean.
