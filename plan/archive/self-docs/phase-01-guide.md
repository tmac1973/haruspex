# Phase 1 — The guide

## Goal

A user guide in `docs/guide/` that answers the questions people ask about
Haruspex, written so a model can answer from one page.

## Work

Write each page in Markdown with frontmatter:

```markdown
---
title: Shell and Code mode
description: The Shell tab's terminal and assistant, Code mode, command approvals, AGENTS.md and repo trust.
---
```

**Pages** (a first cut; merge or split as writing shows):

| Page | Covers |
|---|---|
| `getting-started` | What Haruspex is, first run, downloading a model, the tabs |
| `models` | Local models and choosing one for your VRAM, remote servers, OpenRouter, context size, reasoning |
| `chat` | Chat, attachments, working folder and files, web research and deep research, citations, voice in and out |
| `shell` | The terminal, the assistant, Code mode, command approval and auto-approve, the memory limit, AGENTS.md, repo trust and the badge |
| `skills` | What skills are, `/name`, autonomous use, Settings → Skills, writing and changing skills (and the approval), shipped skills, `/init` |
| `jobs` | Job types (research, guided planning, autonomous coding, audit, asset generation), schedules, run modes, planning skills, the unattended chain |
| `memory` | Remembering across chats, `remember_this`, the approval, reviewing and deleting |
| `images` | Image generation: ComfyUI or the bundled engine, the models and their licences |
| `integrations` | Email, calendar and contacts (server accounts, calendar links, Sign in with Google), MCP servers, screen capture |
| `search-and-network` | Search providers, proxies, the sandbox's network access |
| `remote-access` | Letting other devices use this Haruspex |
| `settings` | Every Settings section, one paragraph each: what it holds, and the page that covers it in depth |
| `shortcuts` | Keyboard shortcuts |
| `troubleshooting` | Known issues, small-model limits, where the logs are, common errors and their fixes |

**Writing rules** (they also go into `CLAUDE.md` in phase 3):
- **Task-first:** headings are what the user wants to do ("Connect a Google
  calendar"), not what the code calls it.
- **Settings paths in full** ("Settings → Shell → Memory limit"), the same
  way the UI copy rule asks.
- **Plain words, short sentences**, no marketing. Say what the app does and
  what it doesn't.
- **Each page stands alone,** because the model reads one page at a time.
  Link to another page by name ("see the `skills` page") rather than relying
  on it.
- **Under 6 KB a page** (a test enforces it in phase 2), so a page fits in a
  turn on a small context.

**Sources:** the README, the Settings components (their labels, tooltips and
help text are the most current description of each feature), the plans in
`plan/`, and the PR history for anything recent (skills, planning skills,
the memory cap, Sign in with Google).

**README:** keep the overview, installing, hardware, the AI safety
disclaimer and development. Replace the long feature sections with a short
list linking to the guide pages.

## Tests

- Every page has a `title` and a `description`.
- No page is over the size budget.
- Every Settings section in `SettingsPanel` is named on the `settings` page.

## Done when

Tim has reviewed the pages, and each question in this list is answered by
one page:
- "How do I use a model on another computer?"
- "What does Code mode do differently?"
- "Why didn't it ask before running that command?"
- "How do I add a Google calendar?"
- "How do I make a skill?"
- "What is guided planning?"
- "Why is my answer cut off?"
