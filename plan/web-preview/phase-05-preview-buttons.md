# Phase 05 — Preview buttons in the transcript

**Depends on:** 03, 04 · **Enables:** the guide pages (06) describing them

## Goal
Let the user open a preview themselves: a small Preview button beside `.html`
file links in the Code transcript and on `.html` diff cards, shown only when
the session offers the Web preview helper and can open desktop windows.

## Files touched
- `src/lib/components/code/DiffCard.svelte` — optional `onPreview` prop; a
  `Preview` button after the path when set.
- `src/lib/components/code/CodeTranscript.svelte` — pass `onPreview` for
  `.html`/`.htm` diffs; handle `data-action="code-preview"` clicks.
- `src/lib/code/paths.ts` — the path linker (`makeCodePathLinker`) emits a
  second button `data-action="code-preview"` after `.html`/`.htm` path links
  when asked to (`{ preview: true }`).
- `src/lib/code/paths.test.ts`, `src/lib/components/code/CodeTranscript.test.ts`
  — new cases.
- `src/lib/components/code/CodeSteps.svelte` — same button on step cards whose
  `displayLabel` is an `.html` path.

## Steps
1. `canPreview = session.capabilities.previewWindow && !session.wslDistro && sessionHelpers(session.helpers).some((h) => h.id === 'preview')`,
   derived in `CodeTranscript.svelte` and passed to `CodeSteps`.
2. The linker: with `preview: true`, after each linked path ending `.html` or
   `.htm`, append `<button class="code-preview" data-action="code-preview" data-path="…" title="Open in the preview window">Preview</button>`.
3. `onThreadClick`: a `code-preview` target calls
   `openPreview(session.id, session.root, relativeToRoot(session.root, path) ?? path)`
   and shows a toast with the error message if it rejects.
4. `DiffCard`: `onPreview` renders the button with the same label and
   tooltip; `CodeTranscript` sets it for `.html`/`.htm` diffs when
   `canPreview`.
5. The remote web client (`src/web`) has its own components and doesn't
   render `CodeTranscript`, so nothing changes there; a session on another
   computer shown here has `previewWindow: false` (phase 04), so no buttons.

## Build gate
- `npm run check && npm run lint && npm run test`
- `npm run build:web` (the web client shares `src/lib`)

## Test plan
- `paths.test.ts`: `.html` links get a Preview button only with
  `preview: true`; `.md` links never do.
- `CodeTranscript.test.ts`: with the helper on, a click on Preview calls
  `openPreview` with the session id, root and relative path; with the helper
  off, `previewWindow: false` or a `wslDistro`, no button renders.
- Hand test: click Preview on an `.html` diff card and on a link in the
  agent's reply; both open or refocus the same window.

## Commit
`feat(code): preview buttons beside html files in the transcript`

## Rollback
Revert the commit; the tool from 04 keeps working. No stored data involved.
