# Phase 4 — Slash commands

## Goal

`/name what I want` runs a skill on any model, in the Chat and Shell input
boxes, with autocomplete.

## Work

- **Shared helper** `src/lib/slash/`: parse `/name rest` (only at the start of
  the message), resolve the name against built-in commands and then skills,
  and build the turn.
- **Autocomplete**: typing `/` as the first character opens a list under the
  input — built-ins first, then skills, filtered as the user types, with
  arrow keys, Enter and Tab to pick, Escape to close. One component, used by
  `ChatView.svelte` and `shell/ChatSidebar.svelte`.
- **Running a skill**: the user message shows exactly what was typed. What the
  model receives is that message with the skill's body and file list attached
  ahead of it, in the same `<skill_content>` wrapper `load_skill` uses. Stored
  on the message, so a follow-up turn still has them, and protected from
  trimming the same way.
- **Built-in commands** (kept small):
  - `/new`: start a new conversation (Chat) or clear the thread (Shell).
  - `/skills`: list the available skills in the conversation, without a model
    call.
  - `/init`: arrives in phase 6; Code mode only.
- An unknown `/name` is sent as an ordinary message, so a path or a sentence
  that starts with `/` still works. The autocomplete simply shows nothing.
- Works whatever the autonomous-use setting is.

## Decisions made while building it

- **Files of a slash-run skill:** the turn offers `read_skill_file`, though
  not `load_skill`, for any skill in the conversation that came with files.
  This holds even with autonomous use off, since its instructions may point
  at those files.
- **`/skills`:** answers with an assistant message added locally, with no
  model call. The first message the user then sends still titles the chat.
- **Leading space:** allowed before the slash.
- **Project skills:** in Shell Code mode, they come only from a repo already
  trusted. Typing in the box never pops up the trust prompt; a new repo's
  first turn asks.
- **Request text:** recall, the file-output check and memory extraction see
  what the user typed (`typedText`), not the skill's instructions.

## Tests

- Parsing: `/name`, `/name args`, a leading space, `/` mid-message, an
  unknown name, and a path like `/etc/hosts is broken`.
- The model receives the body and the user's text; the stored message shows
  only what was typed.
- Autocomplete keyboard handling, in both input boxes.

## Done when

On the local 9B with autonomous use off, `/some-skill do X` follows the skill.
