# Phase 10 — "Add to notebook" from Chat, Shell and Code

**Depends on:** 01, 02, 03, 05 · **Enables:** nothing later depends on it

## Goal
One click saves content from other tabs into a notebook:
- a button on every rendered markdown table makes a table card
- a button on each assistant message makes a text card
- a context-menu item on selected text in assistant output makes a text card

In each case a small picker chooses the notebook or "New notebook…".

## Files touched
- `src/lib/markdown.ts`:
  - the marked table renderer wraps each table with a toolbar button
    `data-action="notebook-add-table"`
  - the table's index within the message goes in `data-table`
  - follows the existing copy and code-preview button HTML at :60-115
- `src/lib/markdownActions.ts`: a `notebook-add-table` case.
  1. Finds the `<table>` element.
  2. Converts it to CSV with `tableToCsv(el)`.
  3. Opens the picker.
  4. Converts the CSV with `rowsFromCsv` (phase 03), then calls
     `notebook_card_add` with `kind:'table'`, the inferred columns in
     `meta`, and the rows in `rows`.
- `src/lib/notebooks/capture.ts` (new):
  - `tableToCsv(tableEl)`: cell text, with links turned into their href when
    a cell is only a link, so URL columns are inferred
  - `captureSource()`: the source for the current surface (Chat conversation,
    Shell, Code session) through `source.ts`
  - `addMarkdownCard(markdown, title)`
- `src/lib/notebooks/capture.test.ts` (new).
- `src/lib/components/notebooks/NotebookPicker.svelte` (new):
  - a popover with a filter box, recent notebooks first, and "New notebook…"
    (asks for a title)
  - remembers the last choice per session
  - a `mode: 'add' | 'select'` prop; `select` hides "New notebook…" and
    returns the chosen ID without a toast (phase 14 uses it)
  - after adding, the toast "Added to <title>" with an Open link
- `src/lib/components/ChatMessage.svelte`: a "Save to notebook" icon button
  next to copy on assistant messages. It saves the message markdown as a text
  card titled with the first heading, or with the first 60 characters.
- `src/lib/components/SelectionMenu.svelte` (new):
  - a global context menu shown on right-click when the selection is inside
    assistant output (`.markdown-body` within a message, or Shell and Code
    assistant output)
  - one item: "Add selection to notebook…", plus "Copy"
  - the selection is converted to markdown by keeping the selected range's
    text
  - uses the absolutely positioned `.context-menu` pattern from
    `shell/ShellPane.svelte:191,353`
- `src/routes/+layout.svelte`:
  - mount `SelectionMenu`
  - the context-menu handler at :283 lets it run when there's a selection in
    assistant output, and otherwise behaves as now
- Shell's sidebar renders assistant replies with `ChatMessage.svelte`
  (`shell/ChatSidebar.svelte`), so it gets the button with Chat.
- `src/lib/components/code/CodeSteps.svelte`: the same "Save to notebook"
  button on assistant text steps. It already uses `renderMarkdown`, so the
  table button comes free.
- `docs/guide/notebooks.md`: "Save from a chat" section.

## Steps
1. Write `capture.ts` and its tests (link cells, header detection, an empty
   header becomes "Column 1…").
2. Add the table toolbar button and its action. The button is hidden when the
   Notebooks tab is off, by a `data-notebooks-off` attribute on `<body>` and a
   CSS rule in `src/lib/styles/`, so cached HTML needs no re-render.
   `src/routes/+layout.svelte` sets the attribute in an `$effect` from
   `getSettings().notebooksTab` and lean mode.
3. Add the picker, the message button and the selection menu.
4. Every capture gets the right source, so the phase 05 badge links back to
   the conversation.

## Build gate
- `npm run check && npm run lint && npm run test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- Unit: `tableToCsv` on sample HTML; the source for each surface; buttons are
  hidden when the tab is off.
- Manual:
  1. In Chat, get a markdown table with links, click "Add to notebook", and
     choose New notebook. The table card has a URL column, and its badge
     opens the conversation.
  2. Save a whole message.
  3. Select a paragraph in a Code reply, right-click, and add it.
  4. Turn the Notebooks tab off; the buttons disappear.

## Commit
`feat(notebooks): save tables, messages and selections to a notebook`

## Rollback
Revert the commit. The buttons disappear and saved cards stay.
