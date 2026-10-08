# Haruspex answers questions about itself — Project Overview

## Problem

Ask Haruspex "how do I set up email?", "what does Code mode do?" or "why
can't it see my calendar?" and it answers from nothing. The model's training
predates the app, and nothing in a turn tells it what Haruspex is, what it
can do or how it's configured. So it guesses, and guesses about menus that
don't exist are worse than no answer.

There is also no user guide to give it. The README mixes install notes,
feature lists and developer setup. `docs/` holds developer notes: testing,
Google verification, image server setup.

## Goals

- A **user guide** in `docs/guide/`: short, task-focused pages, one per area.
- A **`haruspex_docs` tool**, offered in every interactive Chat and Shell
  turn on every model, that reads the guide plus a **live status** page:
  version, active model and backend, and which features are on.
- The guide is **compiled into the app**, so the docs match the version
  running.
- The same pages are **published on the website** at
  `tmac1973.github.io/haruspex/guide/`.
- The guide **stays current**: a `CLAUDE.md` rule, and a CI check that fails
  a PR that changes user-visible behaviour without touching the guide,
  unless it is labelled `no-docs`.

## Non-goals

- **Developer docs.** `docs/*.md` and the plans stay as they are. The guide
  is for people using the app.
- **Searching the guide by meaning (embeddings).** The guide is small, about a
  dozen pages; an index with one-line descriptions is enough for the model to
  pick a page.
- **Answering from the source code.** The model reads the guide, not the
  repo. A question the guide doesn't cover gets "the guide doesn't say", and
  a gap in the guide is a doc bug to fix.
- **Jobs.** A job does a task; it doesn't field questions about the app.

## Design decisions (agreed with Tim, 2026-10-08)

**A tool, not a skill.** A skill would reuse `read_skill_file` and the shipped
skills path. But the model loads a skill by itself only with autonomous use
on, which is off by default for the local model, and "how do I…" should work
on every model. The tool costs about 100 tokens of schema a turn, plus one
line in the system prompt saying when to use it.

**One tool, pages by name.**
- `haruspex_docs()` returns the index: the live status, then each page's
  name and one-line description.
- `haruspex_docs(page: "shell")` returns that page.
- `page` is an enum of the page names, so the model can't invent one.
- Pages are short enough to return whole, and a page over the budget is a
  test failure, not something trimmed at run time.

**The guide is compiled in by Vite.** `import.meta.glob('/docs/guide/*.md',
{ query: '?raw', eager: true })` puts the pages in the frontend bundle. No
Rust, no files on disk to go missing, and they always match the build. Each
page starts with frontmatter (`title`, `description`); the description is
the index line.

**Live status is built when the tool runs** from the settings store and the
same predicates the registry uses:
- the app version;
- the active backend and model, and the context size;
- which features are on: memory, Python sandbox, image generation, screen
  capture, autonomous skills, and the memory limit;
- how many accounts are set up for email, calendar and contacts, and how
  many MCP servers are enabled.

It never includes keys, passwords, addresses, account names or file paths.
A **remote guest** gets the guide but not the status, since that is the host's
configuration.

**The website renders the same Markdown.** The Pages workflow converts
`docs/guide/*.md` to HTML with `marked` (already a dependency) into
`site/guide/`, with the site's existing stylesheet, and runs when
`docs/guide/**` changes. The website therefore can't drift from the app.

**Keeping it current:**
- `CLAUDE.md` gains a rule: a change users can see updates its guide page
  in the same PR, and the PR body names the page.
- CI gains a `guide` check. A PR that changes Settings sections, agent tools,
  job types, slash commands or keyboard shortcuts, without changing
  `docs/guide/`, fails it, unless the PR has the `no-docs` label (for
  internal changes and refactors).
- Pages that could drift on their own are checked against the code: the
  keyboard shortcuts page against `HelpModal.svelte`'s list, and the
  Settings reference against the Settings sections. A test fails when one is
  missing.

## Phases

1. **The guide.** Write the pages, trim the README to point at them.
2. **The tool.** `haruspex_docs`, embedding, the index, live status, the
   system prompt line, registry gating.
3. **Keeping it current.** The `CLAUDE.md` rule, the CI check and label,
   drift tests.
4. **The website.** Render the guide into `site/guide/` in the Pages
   workflow, and link it from the home page.

Phase 1 is most of the work. Phases 2 to 4 are small, and 2 can start as soon
as a few pages exist.
