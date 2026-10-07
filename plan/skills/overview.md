# Skills, slash commands and AGENTS.md — Project Overview

## Problem

Every turn starts from nothing. A user who has worked out how they want a
release cut, a report laid out or a server debugged has to explain it again
each time, or paste it from somewhere. The model can't keep a procedure it was
taught, and a repo can't tell the coding assistant how it is built, tested or
laid out.

Two open conventions cover this, and other agents already read both:

- **Agent Skills** (`SKILL.md`, agentskills.io): a folder holding a `SKILL.md`
  whose YAML frontmatter has a `name` and a `description`, a Markdown body of
  instructions, and optional `scripts/`, `references/` and `assets/`. Only the
  name and description cost tokens up front; the body loads when the skill is
  used, and the extra files only when the body points at them.
- **AGENTS.md**: a Markdown file at the root of a repo (optionally nested in
  subfolders) holding the instructions that apply to every turn in it.

Haruspex reads neither, and has no slash commands to call anything by name.

## Goals

- Skills in the standard format work in **Shell (Code mode)**, **Shell** and
  **Chat**. A skill folder copied from another tool works unchanged.
- The user can run a skill by name: `/name what I want` in the Chat and Shell
  input boxes, with autocomplete.
- On a model that can handle it, the model finds and loads a relevant skill on
  its own.
- The model can write and revise skills, and nothing it writes is saved
  without the user seeing it first.
- Shell Code mode reads the repo's `AGENTS.md` into every turn.
- `/init` drafts a short `AGENTS.md` for a repo that lacks one.

## Non-goals

- **Remote guests and jobs.** Both build prompts through the shared builders
  and could take skills later; neither gets them in this scope. (A job loading
  the project's `AGENTS.md` during autonomous coding's preflight is the obvious
  follow-up.)
- **`allowed-tools` enforcement.** The field is experimental in the spec.
  Haruspex reads and shows it but does not narrow the toolset by it; the
  existing approvals (`run_command`, writes) already apply to anything a
  skill's instructions cause.
- **A skill marketplace or download-from-URL.** Import is a folder on disk.
- **Running skill scripts in Chat outside the sandbox.** Chat has no shell; a
  skill's scripts run there only if the model passes them to `run_python`.

## Design decisions

**Slash commands are the dependable path; letting the model pick a skill by
itself is gated.** The local default is a 9B model, which reliably does only
the first part of a multi-part instruction (see the memory note on Qwen 9B).
"Notice a skill applies, load it, then follow it" is exactly that shape. So:

- `/name` works on every model, always.
- **Settings → Skills → "Let the model use skills on its own"** puts the skill
  list in the system prompt and offers the `load_skill` tool. Default: on for a
  remote or OpenRouter backend, off for the local llama-server. When off, the
  list costs no tokens.

**Skills are read in Rust; the frontend never globs the disk.** One module
finds, parses and validates skills and serves them to every window, the same
way `code_tools.rs` owns path rules.

**Where skills come from.** Following the client guide at
agentskills.io (`client-implementation/adding-skills-support`), from lowest to
highest precedence:

1. Built-in: shipped in the app (`/init`).
2. User: `<app data>/skills/` (Haruspex's own; agent-written skills land here)
   and `~/.agents/skills/` (the cross-client convention, so skills installed by
   other tools just appear).
3. Extra folders the user adds in Settings — offered as a one-click add for
   `~/.claude/skills/`, which many existing skills live in. Off until added,
   since those skills may assume Claude Code's tools.
4. Project, in Shell Code mode only: `.agents/skills/` and `.claude/skills/`
   under the repo root. **Project overrides user**, the convention every
   existing client follows. A collision is shown in Settings as shadowed.

**A repo is untrusted until the user says otherwise.** A freshly cloned repo's
skills and `AGENTS.md` are instructions written by a stranger, injected into
every turn. The first time Code mode finds either in a repo, it asks once:
"Use this repo's AGENTS.md and skills?" The answer is remembered per repo
root and can be changed in Settings → Skills.

**Lenient parsing, visible problems.** Per the client guide: a name that
doesn't match its folder or runs long gets a warning and loads anyway (many
skills were written for clients that don't check); a value with an unquoted
colon (`description: Use when: …`), invalid YAML that other parsers accept, is
retried quoted. Only a missing description or unparseable YAML skips a skill,
and then it is listed in Settings with its error rather than vanishing —
otherwise the user is left wondering why `/name` doesn't autocomplete.

**Loaded skills stay loaded.** A loaded skill's body is wrapped in
`<skill_content name="…">` with its folder and file list. The in-loop trimmer
and pre-send fit leave those messages alone, since losing them mid-task
degrades the turn with no visible error, and a skill already in the
conversation is not injected a second time.

**Anything the model writes needs approval, every time.** A skill is
instructions that persist and steer later turns. A web page the model read
could talk it into saving one. So `create_skill` and `update_skill` always
open an approval modal showing the full text (or the change), editable in the
CodeMirror editor; there is no "approve for this session"; non-interactive
turns don't get the tools at all; and the result is labelled as written by
the model in the list.

**AGENTS.md has a size cap.** Every token of it is paid on every turn, and a
local model's context is small. Above the cap (8 KB to start) the file is cut
with a note saying so, and Settings shows that it was.

## Phases

| #   | Phase                                                                    | Size        |
| --- | ------------------------------------------------------------------------ | ----------- |
| 1   | [Finding and parsing skills](phase-01-discovery.md)                      | ~1 day      |
| 2   | [Skills in turns, and Settings → Skills](phase-02-turns-and-settings.md) | ~1 day      |
| 3   | [AGENTS.md in Shell Code mode](phase-03-agents-md.md)                    | ~half a day |
| 4   | [Slash commands](phase-04-slash-commands.md)                             | ~1–1.5 days |
| 5   | [The model writing skills](phase-05-authoring.md)                        | ~1 day      |
| 6   | [`/init`](phase-06-init.md)                                              | ~half a day |

Each phase is one PR and leaves the app shippable. 1 → 2 is the critical path;
3 is independent; 4 needs 2; 5 needs 2; 6 needs 3 and 4.
