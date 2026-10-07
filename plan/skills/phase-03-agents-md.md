# Phase 3 — AGENTS.md in Shell Code mode

## Goal

Every Code mode turn carries the repo's own instructions.

## Work

- Rust command `agents_md_for(cwd) -> Option<AgentsMd>`:
  - Find the git root of `cwd` (or use `cwd` when there is none).
  - Read `AGENTS.md` at the root. If there is none, fall back to `CLAUDE.md`.
  - When `cwd` is below the root, also read the nearest nested `AGENTS.md`
    between them; the spec says the nearest file wins for its subtree, so it
    goes last.
  - Cap the total at 8 KB. Report `truncated: true` and the original size when
    it was cut.
- Only for a trusted repo (the phase 2 prompt asks once per repo; an
  `AGENTS.md` is a stranger's instructions until the user says otherwise).
- `buildShellCodeSystemPrompt` gets a PROJECT INSTRUCTIONS section with the
  file's path and contents, placed after the fixed rules so the repo can
  refine them.
- Re-read when the shell's cwd moves to a different repo, not on every turn.
- The Shell sidebar shows "Using AGENTS.md" (with the path, and a note when it
  was cut short) so the user knows it is in play.

## Tests

- Untrusted repo: nothing read.
- Root only; nested file appended; CLAUDE.md fallback; no file; truncation and
  its note; a cwd outside any repo.

## Done when

A Code mode turn in this repo answers "how do I run the tests?" from
`CLAUDE.md` without reading any files.
