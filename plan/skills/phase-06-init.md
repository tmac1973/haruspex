# Phase 6 — `/init`

## Goal

`/init` in Code mode drafts a short `AGENTS.md` for the repo and writes it
only after the user approves.

## Work

- A built-in skill, shipped in the app (`include_str!`), so it goes through
  the same path as every other skill and can be overridden by a user skill
  named `init`.
- The instructions ask for what an agent can't work out on its own, and
  nothing else:
  - build, test, lint and format commands
  - conventions the linters don't enforce
  - layout that isn't obvious from the folder names
  - gotchas: required environment, generated files not to edit, ordering
    rules
  - A target of under 60 lines, with no restating of the README.
- Sources it reads: package manifests and their scripts, CI workflows,
  existing `README`, `CLAUDE.md`, `.cursorrules` and
  `.github/copilot-instructions.md`.
- When `AGENTS.md` already exists, the skill proposes changes to it rather
  than a rewrite.
- The write goes through the phase 5 approval modal (editable, with the
  change shown), whatever the Code mode auto-approve setting says.
- Code mode only; in Chat or Shell, `/init` says it needs Code mode.

## Tests

- Built-in skill present and valid; a user `init` skill overrides it.
- The write always asks, even with auto-approve on.

## Done when

`/init` in a fresh clone of a small repo produces a reviewable `AGENTS.md`
under 60 lines, and phase 3 picks it up on the next turn.

## Decisions made while building it

- **The write is a tool of its own, `write_agents_md`**, in the phase 5
  approval modal, offered only in Code mode. The skill tells the model to
  use it rather than `fs_write_text`. Code mode can still write any file,
  AGENTS.md included, with its ordinary tools: the tool is what makes the
  `/init` draft reviewable, not a lock on the file.
- **It writes the root `AGENTS.md`** of the repo the shell is in, worked out
  in Rust from the cwd. Text over the 8 KB cap is refused, since turns would
  read only part of it.
- **`init` is hidden outside Code mode**: not in Chat's or plain Shell's `/`
  list or skill catalog. Typing `/init` there adds a note saying it needs
  Code mode. A user's own skill called `init` overrides the built-in and is
  not held back.
- **Trust after approval.** A repo never asked about had nothing to trust,
  so approving its first AGENTS.md records it as trusted rather than asking
  on the next turn. An earlier answer stands, a "no" included, and the model
  is told the file won't be read. A repo with project skills the user hasn't
  seen still gets the prompt.
- **The modal shows the line count**, since the skill aims for under 60.
