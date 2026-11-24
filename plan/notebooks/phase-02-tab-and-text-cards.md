# Phase 02 — Notebooks tab, list and text cards

**Depends on:** 01 · **Enables:** 03, 04, 05, 07, 08, 09, 10, 11 (every card
UI and the panel the agent chat lives in)

## Goal
A Notebooks tab sits after Chat. It is on by default, can be turned off in
Settings → General, and is hidden in lean mode. It has a notebook list with
pins, tags and a trash view, and a notebook view where text cards are
created, edited as markdown, rendered with clickable links, reordered and
deleted. Notebook links (`notebook:<id>` and `notebook:<id>#<card>`) work
anywhere markdown is rendered.

## Files touched
- `src/lib/stores/activeTab.svelte.ts`:
  - add `'notebooks'` to `ActiveTab`
  - `mainTabs()` order becomes `home, chat, notebooks, jobs, shell, code`
  - `visibleTabs()` drops it when `!s.notebooksTab` or in lean mode
- `src/lib/stores/activeTab.test.ts`: order, lean and setting cases.
- `src/lib/stores/settings.ts`:
  - `notebooksTab: boolean` (default `true`) with a doc comment
  - `notebooks: { semanticSearch: boolean }` (default `false`; used in
    phase 09, declared here so settings change once)
- `src/lib/components/settings/GeneralSection.svelte`: a "Notebooks tab"
  toggle next to "Home tab", with a tooltip.
- `src/lib/components/TabBar.svelte`: add `{id:'notebooks', label:'Notebooks'}`.
- `src/routes/+page.svelte`:
  - render `NotebooksTab` when active
  - keep it mounted after first open, using the Shell/Code `everOpened` +
    `class:hidden` pattern, so the agent chat in phase 07 keeps running when
    you switch tabs
- `src/routes/+layout.svelte:697-707`: the tab-switch regex becomes `/^[1-6]$/`.
- `src/lib/shortcuts.ts`: "Ctrl / ⌘ + 1–6 … Home, Chat, Notebooks, Jobs, Shell
  or Code".
- `src/lib/engine/dispatch.ts:143`: `app.mode` reports `notebooks` alongside
  `home`.
- `src/lib/stores/notebooks.svelte.ts` (new):
  - the list store (load, create, update, delete, restore)
  - the open notebook (`openNotebook(id, cardId?)`)
  - a `notebook-changed` event bus that later phases and agent tools fire
- `src/lib/components/notebooks/NotebooksTab.svelte` (new): a three-column
  layout. The list sidebar is on the left, the notebook in the middle, and the
  right slot is empty until phase 07.
- `src/lib/components/notebooks/NotebookList.svelte` (new):
  - pinned notebooks first, then the rest by `updated_at`
  - a tag filter chip row and a New button
  - a search box that stays a placeholder until phase 09
  - a Trash entry
- `src/lib/components/notebooks/NotebookView.svelte` (new):
  - an editable title and tags
  - the card list with an "Add card" menu between cards (text only in this
    phase; later phases add their kinds to `cardKinds.ts`)
- `src/lib/components/notebooks/CardFrame.svelte` (new):
  - title, drag handle and menu (move up/down, delete)
  - a source badge slot, filled in phase 05
- `src/lib/components/notebooks/cards/TextCard.svelte` (new):
  - view mode renders markdown with `renderMarkdown`
  - edit mode is CodeMirror markdown (`src/lib/editor/codemirror.ts`)
  - edits save on blur and after 1 s idle, with `expected_version`
- `src/lib/notebooks/cardKinds.ts` (new): a registry of
  `{kind, label, component, create()}` that later phases extend.
- `src/lib/components/notebooks/cards/UnavailableCard.svelte` (new): shown
  for any card whose kind has no registry entry: "This card type isn't
  available in this version." The card can still be moved, deleted and
  restored. Later phases' rollbacks rely on this.
- `src/lib/components/notebooks/TrashView.svelte` (new): restore and "Delete
  forever" (with a confirm).
- `src/lib/markdown.ts`, `src/lib/sanitize.ts`: allow `notebook:` hrefs, and
  render them as links with `data-action="notebook-open"`.
- `src/lib/markdownActions.ts`: a `notebook-open` case that calls
  `setActiveTab('notebooks')` and `openNotebook(id, cardId)`.
- `docs/guide/notebooks.md` (new): a short first version with the tab, text
  cards and trash, so the Guide check passes. Phase 16 finishes it.

## Steps
1. Add the setting, its tab-visibility logic and the toggle. With the tab off,
   `getActiveTab()` already falls back to Chat.
2. Build the store over `src/lib/notebooks/api.ts`.
   - Every mutation re-reads the affected notebook.
   - On a `conflict` error, reload the card and show the toast "This card
     changed elsewhere — reloaded." Keep the unsaved text in the editor's undo
     stack so the user can paste it back.
3. Build the list, view, frame, text card and trash components. The UI copy is
   one short sentence per section, with details in `title` tooltips.
4. Card order: drag to reorder, or Move up/down from the menu. Both call
   `notebook_card_move`.
5. Notebook links: `notebook:<id>` opens the notebook, and `#<card>` scrolls to
   that card and flashes it. An unknown ID shows "That notebook was deleted."
6. Write the first `docs/guide/notebooks.md`. Do not run Prettier on it.

## Build gate
- `npm run check && npm run lint && npm run test`
- `node scripts/guide-check.mjs < /dev/null`
- `cargo test` (unchanged Rust, run as a guard)

## Test plan
- Unit:
  - `activeTab.test.ts`: the order with the tab on and off, and lean mode.
  - The store's conflict handling, with a mocked `invoke`.
  - The `notebook:` link renders and survives sanitizing, and other unknown
    schemes are still stripped.
  - The shortcuts test still matches the guide.
- Manual, in `npm run tauri dev`:
  1. Create a notebook.
  2. Add three text cards with links and reorder them.
  3. Restart the app; everything persists.
  4. Turn the tab off and on in Settings → General.
  5. Ctrl+3 opens Notebooks.
  6. Delete a card, then restore it from Trash.

## Commit
`feat(notebooks): add the notebooks tab with text cards, pins, tags and trash`

## Rollback
Revert the commit. The setting key stays in saved settings JSON and is ignored.
Phase 01 data is untouched.
