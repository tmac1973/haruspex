# Notebooks — Project Overview

## Problem
Research done in Haruspex disappears into conversation history. A product
comparison from Chat, a list of bugs Code found, or an outline of a project or a
filesystem from Shell exists only as a message in one conversation. It can't be
edited, organized or searched as a whole, and the next conversation can't build
on it. Users who want to keep notes have to copy text into another app, and that
app's notes are out of reach of Haruspex's agents.

This affects anyone who uses Haruspex to research, plan or work through a list:
the non-technical user collecting shopping or company research, and the
developer tracking issues across Code sessions.

## Goals
- A **Notebooks** main tab, on by default, that can be turned off in
  Settings → General like the Home tab, and is hidden in lean mode.
- Notebooks made of an ordered list of **cards**. There are six card types, all
  in the first release:
  - **Text**: markdown with clickable links.
  - **Table**: typed columns (text, number, currency, URL, date, checkbox, status).
  - **Checklist**: items with done/not-done state.
  - **Python**: code run in the Pyodide sandbox, with its saved output. The
    notebook's tables are available to it as dataframes.
  - **Attachment**: a file kept with the notebook.
  - **Image**: a picture shown inline.
- Users create, edit, reorder and delete notebooks and cards by hand.
- Agents in Chat, Shell, Code and the Notebooks tab create, read, search and
  change notebooks through a **notebook tool family**: deferred in Chat and
  Code, always sent in Shell and in a notebook's own chat. Tables are edited
  row by row, never by rewriting the whole table.
- Agent changes apply immediately. Each card shows who last changed it (you, or
  an agent with a link back to its conversation or session), and keeps a
  history you can roll back.
- Each notebook has its own saved **agent chat** in a side panel. It has Chat's
  tools, always has the notebook in context, and accepts dropped PDF, DOCX and
  XLSX files.
- The notebook list is sorted by last edit, with **pins** and **tags** to filter by.
- **Search** across all notebooks (titles, text, table cells, checklist items,
  Python code, attachment names) uses FTS5 keyword search. When Settings →
  Notebooks → Semantic search is on (off by default; it downloads the 65 MB
  embedding model), semantic results are merged in. Results open the matching
  card.
- **Add to notebook** buttons on rendered tables and assistant messages, and a
  context-menu item for selected text, in Chat, Shell and Code.
- **Export**: a notebook to Markdown, HTML, PDF, DOCX or ODT; a table to CSV or
  XLSX; Python cards to `.ipynb`. **Import**: Markdown, CSV and XLSX, as a new
  notebook or as cards in an existing one.
- Notebooks on **paired computers** show in the Notebooks tab under each
  computer's name. You read and edit them live over that computer's owner API,
  as with remote chats; nothing is copied. Files up to 25 MB can be opened from
  another computer.
- Notebooks can be read and edited from the **Remote control web client**.
- A **scheduled refresh** job type in Jobs re-runs research on a notebook on a
  schedule (for example "refresh prices weekly").
- A **dead-link check** flags URL cells and text links that no longer load.
- A `notebooks` guide page and a showcase subject, per the user guide rules.

## Non-goals
- No free-form document editor. A notebook is cards, not one continuous page,
  and text cards are markdown, not WYSIWYG rich text.
- No folders. Organization is pins, tags and search.
- No storage as files on disk and no folder mirror. Files exist only when
  exported.
- Memory never extracts facts from notebooks, and notebooks aren't a Memory source.
- Agents don't see notebooks unless the user's message brings in the notebook
  tools. No notebook titles go into every system prompt.
- No copying or merging of notebooks between computers. Another computer's
  notebooks are reachable only while it is on.
- No real-time multi-user collaboration. Edit conflicts are caught per card
  with a version check, not merged live.
- No review-before-apply step for agent edits. Card history is the safety net.
- Python cards can't reach anything the existing sandbox can't reach, and
  aren't a general Jupyter replacement: there are no kernels, and the only
  language is Python.
- No sharing of notebooks with other people or publishing them to the web.

## Users & primary flow
**Users:** Haruspex users, mostly non-technical, who research in Chat; and
developers using Code and Shell.

**Flow A — research in Chat, keep it:**
1. In Chat, the user asks for good Bluetooth speakers, then "make a notebook
   called speakers with a table of speakers, features, price and a retailer link".
2. The message brings in the notebook tools. The agent calls `notebook_create`,
   then adds a table card with typed columns and rows given as CSV.
3. The reply links to the notebook. Clicking it opens the Notebooks tab on it.
   The table shows clickable retailer links, and its cards are marked "From
   Chat: *<conversation title>*", linking back to that conversation.

**Flow B — notes by hand, agent organizes:**
1. In Notebooks, the user creates a notebook, types notes into text cards and
   adds a checklist.
2. In the notebook's agent panel they ask "organize these thoughts and research
   the companies I mentioned".
3. The agent rewrites and splits text cards and adds a table of companies from
   web search. Each changed card has history, so the user can roll back any one.

**Flow C — documents in:** the user drops a PDF on the notebook's agent panel
and asks to "extract X as a table". The agent reads the extracted text, adds a
table card, and adds the PDF as an attachment card.

**Flow D — Code and Shell:** "create a notebook with the bugs you found as a
table", "read notebook X and let's work through the issues", "outline this
filesystem in a notebook". The agent uses `notebook_read`,
`notebook_table_rows` and `notebook_edit_card` as it works, and updates
status or checkbox columns as items are done.

**Flow E — capture:** the user clicks *Add to notebook* on a table in a chat
reply, picks a notebook (or a new one), and the table becomes a table card.

**Flow F — find and take away:** the user searches "battery life", opens the
hit, and exports the notebook to PDF or the table to XLSX.

## Constraints
- Stack: Tauri 2 (Rust) + SvelteKit 5 runes SPA. Data lives in the app's SQLite
  database, with new migrations. Search uses SQLite FTS5, and semantic search
  uses the existing fastembed embedder from Memory, independent of whether
  Memory is on.
- Reuse what exists: the Home card UI patterns, the Pyodide sandbox, the
  document writers (DOCX, ODT, PDF), the XLSX writer, document extraction,
  `markdownActions`, deferred tool families, the paired-computer (peers) layer, the Remote control
  relay, and the Jobs job registry.
- The tools have to work with small local models (Qwen 3.5 9B as best effort,
  per the project's rule that 9B isn't a design constraint): flat arguments,
  rows as CSV, stable short card IDs, and bounded reads (one card at a time,
  with paging for long tables).
- Linux, macOS and Windows. Attachment storage paths and file dialogs go through
  Tauri.
- Project rules: UI copy is one short sentence per section, with detail in
  tooltips. Settings paths are named in full. New IPC commands are named
  domain-first (`notebook_create`, …) and need `./scripts/export-ipc-types.sh`.
  Visible changes update `docs/guide/` and `docs/showcase/` in the same PR.
  Commits follow Conventional Commits.
- Settings are plain JSON snapshots. Notebook content never goes in the
  settings blob.

## Success criteria
- With Settings → General → Notebooks tab off, the tab is gone; turning it on
  restores it, and it is on for new installs.
- A user can create a notebook with all six card types by hand, reorder and
  delete cards, and everything persists across restarts.
- Flows A–F above work end to end against a real model in the running app.
- Changing one cell of a 200-row table through the agent sends a row update,
  not the whole table.
- Every agent-made change shows its source with a working link back, and
  rolling a card back to an earlier version restores its content.
- Keyword search finds a word in a table cell, and semantic search finds a card
  by meaning without sharing its words. Both open the right card.
- Every export format opens correctly in its usual app (a word processor, a
  spreadsheet app, Jupyter). Markdown, CSV and XLSX imports round-trip their
  tables.
- A notebook on one computer can be read and edited live from a paired
  computer, and from the Remote control web client.
- A scheduled refresh job updates a notebook's table on its schedule, and the
  dead-link check flags a broken URL.
- `npm run check`, `npm run lint`, `npm run test`, `cargo test`,
  `cargo clippy -D warnings` and the Guide check pass. The `notebooks` guide
  page is under 6 KB.

## Decisions
- **Storage** → SQLite as the source of truth, with export to files. No files on
  disk and no folder mirror.
- **Card types in the first release** → all six: text, table, checklist,
  Python, attachment, image.
- **How agent edits land** → applied immediately, with the source shown per card
  and per-card history with rollback.
- **Agent inside the Notebooks tab** → one saved chat per notebook in a side
  panel, with Chat's tools and the notebook always in context.
- **Organizing notebooks** → a flat list sorted by last edit, with pins and tags.
- **Search** → FTS5 keyword search plus semantic search with the Memory
  embedder, merged into one result list.
- **Getting the embedding model** → Settings → Notebooks → Semantic search,
  off by default, downloads it. Turning off Memory doesn't unload it while
  Notebooks uses it.
- **One-click capture** → *Add to notebook* on rendered tables, on assistant
  messages, and on selected text, in Chat, Shell and Code.
- **Formats** → export Markdown, HTML, PDF, DOCX, ODT (notebook), CSV and XLSX
  (table), `.ipynb` (Python); import Markdown, CSV and XLSX.
- **Extras in scope** → cross-computer access, the Remote control web client,
  a scheduled refresh job type, and a dead-link check.
- **Cross-computer** → live view over paired computers' owner API, like remote
  chats. Instance sync copies nothing, so real replication was rejected as a
  large new subsystem.
- **Files across computers** → files up to 25 MB can be opened from another
  computer. Larger ones show their name and size only.
- **Shell** → Shell has no deferred loading, so it always gets the notebook
  tools. Chat and Code keep them deferred.
- **Delivery** → one branch, one commit per phase, and one PR once you've
  evaluated the whole feature.
- **Row storage** → a `notebook_rows` table, one row per table row.
- **History** → the last 50 snapshots per card, with edits by the same source
  within 2 minutes grouped.
- **Deletion** → Trash for 30 days, for notebooks and cards.
- **Python runs** → you press Run. An agent's new or edited card runs once.
  Output is marked stale when a table it read changes.
- **Python and tables** → code reads tables as dataframes, never writes them. A
  dataframe result can be saved as a new table card.
- **Refresh job** → the notebook and instruction are set on the job.
- **Link check** → on demand, plus automatically when a notebook is opened more
  than a week after its last check.
- **Web client** → browse, search, edit text, table and checklist cards, and
  use the notebook chat. Python runs, uploads and exports stay on the desktop.
- **Tab position** → after Chat: Home, Chat, Notebooks, Jobs, Shell, Code.
- **Memory** → separate. Memory never reads notebooks.
- **Agent awareness** → only when asked, through a deferred notebook tool
  family. No notebook titles in every prompt.
