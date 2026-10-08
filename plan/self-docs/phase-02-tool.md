# Phase 2 — The `haruspex_docs` tool

## Goal

On every model, in Chat and Shell, "how do I…" and "why does Haruspex…"
questions are answered from the guide and the app's live state.

## Work

- **Embedding** (`src/lib/guide/guide.ts`):
  - `import.meta.glob('/docs/guide/*.md', { query: '?raw', eager: true })`.
  - Parse each page's frontmatter into `{ name, title, description, body }`,
    with the name taken from the file name.
  - Pages are sorted by the order in `getting-started`'s list, or
    alphabetically after it.
- **Live status** (`src/lib/guide/status.ts`), built when the tool runs, as a
  short Markdown block:
  - the app version (`getVersion()`);
  - the backend kind, the model name and the context size, from
    `resolveBackendDescriptor()`;
  - which features are on: memory (`memoryActive()`), the Python sandbox,
    image generation (the backend kind), screen capture, autonomous skills
    (`skillsAutonomous()`), and the memory limit;
  - how many accounts are set up for email, calendar and contacts, and how
    many MCP servers are enabled.

  Counts and on/off only: never keys, addresses, account names, server URLs
  or file paths.
- **The tool** (`src/lib/agent/tools/guide.ts`, category `guide`):
  - `haruspex_docs(page?)`, with `page` an enum of the page names.
  - Without a page, it returns the status, then the index: "name — title:
    description" per page.
  - With a page, it returns the page's title and body.
  - In a remote guest's turn, the status is left out and replaced by one line
    saying it isn't available remotely.
- **Registry:** offered in every interactive Chat and Shell turn (both modes)
  and to remote guests, but never in jobs, and not tied to any setting.
- **System prompts:** one line in Chat's, Shell's and Code mode's system
  prompts: "For questions about Haruspex itself (its features, settings or
  how it is set up here), call haruspex_docs before answering, and say when
  the guide doesn't cover something."

## Tests

- Every page parses, has a title and description, and is under the size
  budget (6 KB).
- The index lists every page, and the enum matches the pages.
- The status says what each feature switch is, and contains no secret.
  Settings in the test are seeded with a key, a URL and an address that must
  not appear.
- A remote guest's call has no status.
- The tool is offered in Chat, Shell and Code mode, and not in jobs.

## Done when

On the local 9B and a larger model, "how do I connect a Google calendar?"
and "is memory on?" are answered correctly from the tool, and a question the
guide doesn't cover is answered with "the guide doesn't say".
