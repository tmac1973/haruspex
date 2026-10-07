---
name: init
description: Draft or improve this repo's AGENTS.md, the instructions every coding turn here reads. Use when the user runs /init or asks for an AGENTS.md.
---

# Write the repo's AGENTS.md

AGENTS.md is read at the start of every coding turn in this repo, by Haruspex and by other agents. Every line costs tokens on every turn, so it holds only what an agent can't work out by itself.

## 1. Read before you write

Look at what the repo already says about itself. Read the ones that exist; skip the rest:

- `AGENTS.md`: if it is already in this conversation, use that copy.
- Package manifests and their scripts: `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `Makefile`, `justfile`, `CMakeLists.txt`.
- CI workflows: `.github/workflows/*.yml`. They show the commands that really run.
- `README.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`.
- Lint and format config, to learn which rules the tools already enforce.

## 2. Keep only what an agent needs and can't infer

- **Commands**: build, test (including one test or one file), lint, format, each exactly as run.
- **Conventions the linters don't enforce**: naming, error handling, where tests go, commit style.
- **Layout** that isn't obvious from folder names.
- **Gotchas**: required environment or setup, generated files not to edit, steps that must run in order.

Leave out anything the README already explains, anything a linter enforces, general advice, and descriptions of what the project is for. If `CLAUDE.md` or another agent file holds the same kind of guidance, fold its useful parts in.

## 3. Write it

- Under 60 lines of Markdown, short headings and bullets.
- Commands in code spans, copied from the manifests or CI, never guessed.
- When `AGENTS.md` exists, keep what is still right and change only what is wrong or missing. Don't rewrite it in your own style.

## 4. Save it for review

Save it with `write_agents_md`, never `fs_write_text` or a command: the user reviews and can edit it before anything is written. Afterwards, say in one or two sentences what it covers, or what you changed.
