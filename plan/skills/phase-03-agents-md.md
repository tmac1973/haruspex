# Phase 3 — AGENTS.md in the Shell assistant

## Goal

Every Shell turn, in either mode, carries the repo's own instructions.
Code mode only at first; troubleshooting questions ("how do I run the
tests?") need them just as much, so both modes read it. Project skills
stay Code mode only.

## Work

- Rust command `agents_md_for(cwd) -> Option<AgentsMd>`:
  - Find the repo root of `cwd` (`skills::find_project_root`); outside a repo
    there is nothing to read.
  - Read `AGENTS.md` at the root. If there is none, fall back to `CLAUDE.md`.
  - When `cwd` is below the root, also read the nearest nested `AGENTS.md`
    between them; the spec says the nearest file wins for its subtree, so it
    goes last.
  - Cap the total at 8 KB. Report `truncated: true` and the original size when
    it was cut.
- Only for a trusted repo. Phase 2's prompt asks only when a repo has project
  skills; extend `trustedProjectRoot` to ask when it has an `AGENTS.md` too
  (`skills_project_info` already reports it), and to ask whatever the
  autonomous-use setting is, since `AGENTS.md` applies to every turn.
- `buildShellCodeSystemPrompt` gets a PROJECT INSTRUCTIONS section with the
  file's path and contents, placed after the fixed rules so the repo can
  refine them.
- Read on every Shell turn: it is one small file, and an edit to
  `AGENTS.md` takes effect on the next message without a restart.
- The Shell sidebar header shows an `AGENTS.md` badge, with the files in its
  tooltip and a note when the text was cut short, so the user knows it is in
  play.

## Tests

- Untrusted repo: nothing read.
- Root only; nested file appended; CLAUDE.md fallback; no file; truncation and
  its note; a cwd outside any repo.

## Done when

A Code mode turn in this repo answers "how do I run the tests?" from
`CLAUDE.md` without reading any files.
