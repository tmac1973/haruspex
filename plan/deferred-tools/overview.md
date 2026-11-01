# Deferred Tools — Project Overview

## Problem

Every tool the model is offered sends its full schema in every request. On
2026-11-01 we measured the real registry (`getToolSchemas` and
`buildSystemPrompt`, all tools registered):

| Turn                             | Tools | Schemas | System prompt |
| -------------------------------- | ----- | ------- | ------------- |
| Chat, no working folder          | 16    | 14.1 KB | 4.6 KB        |
| Chat, working folder, sandbox on | 30    | 26.4 KB | 5.5 KB        |
| Chat, everything on              | 58    | 56.6 KB | 6.7 KB        |
| Code tab                         | 23    | 25.9 KB | 5.7 KB        |
| Code tab, everything on          | 40    | 44.9 KB | 5.7 KB        |

"Everything on" is email, calendar, contacts, screen capture, two image models,
music, video generation and video editing. That turn spends about 17k tokens
before the first message, which is half of the default 32k window. Most of
those tools are not used in most turns. The 13 video tools alone are 11.6 KB,
and `make_asset` is 7 KB in the Code tab.

The per-field wording is already tight, so trimming it saves little. The cost
comes from tool families that are always sent and rarely used.

## Goals

- A turn sends full schemas only for a **core** set of tools. Every other tool
  family is listed in the system prompt with one line, and the model loads a
  family with a `load_tools` call when the request needs it.
- After a family is loaded, it stays loaded for the rest of the conversation,
  compaction included.
- What a turn can do does not change. Deferred loading divides this turn's
  offered set into "sent now" and "sent on request", and never adds a tool
  that `getToolSchemas` would not offer.
- The KV cache stays useful. Loading a family must not make llama-server
  process the whole conversation again on every later turn.
- A call to a listed tool that is not loaded yet still works: the model gets
  the schema back and calls again. It does not get an error.
- A setting, **Settings → General → Load tools when needed**, switches it on
  and off. The default follows the model size, as `BUDGET_TIERS` does for MCP.
- Targets, held by a test:
  - Chat, everything on: schemas plus index under 20 KB (from 56.6 KB).
  - Code tab, everything on: under 16 KB (from 44.9 KB).

## Non-goals

- No search over tool descriptions. With ~60 tools the full index fits in the
  prompt, so the model already knows every name. Search can come later if MCP
  servers with many tools need it.
- No change to lean mode. Its fixed set is already small, and lean turns
  never defer.
- No change to the Shell assistant (10 tools, 7.6 KB), jobs and remote guests
  (`toolAllowlist`), or subtasks. They keep their current sets.
- No rewording of the core tools' descriptions. That is a separate trim (see
  "Related").
- No change to the hard gates in `runTool`. They stay as the last check.

## Users & primary flow

Users who have turned on several integrations, and users of the Code tab. The
second group always pays for `make_asset`.

1. The user asks Chat to cut last week's episode.
2. The prompt has the line `video — edit the episodes in the working folder
with Kdenlive: probe, cut, captions, render`. The model calls
   `load_tools({ family: "video" })`.
3. The result says the video tools are loaded. In the next request the model
   has the 13 video schemas and calls `video_probe`.
4. Later turns in this conversation have the video tools without another load.

When the model skips step 2 and calls `video_probe` directly, step 3 happens
anyway: the result gives the schema and asks it to call again.

## Constraints

- The tool list is built once per turn in `buildLoopContext`
  (`src/lib/agent/loop/context.ts:244`). `modelCall` and `forcedFinal` read
  `ctx.tools` on each iteration, so the list can change inside a turn.
- `runTool` resolves a name against the **full** registry. Some tools are
  gated only by the schema filter (for example `email_compose` for a
  non-interactive turn), so `load_tools` must compute what it may load from
  this turn's filter. It must not use the registry.
- In the Qwen 3.5 chat template the tool block comes first, before the system
  text (measured in phase 01). Qwen 3.5 and 3.8 are hybrid models: their
  recurrent layers rewind only to a checkpoint near the end of the prompt. So
  on llama-server, a change anywhere but the tail makes it process the
  **whole** prompt again: a change to `tools`, to the system text, or to an
  early message. Only text added at the end is cheap.
- llama-server with `--jinja` builds a grammar from `tools` that limits
  tool-call names to the listed tools (measured in phase 01). The model cannot
  call a tool that is not in `tools`: the grammar turns the call into a call
  to a listed tool. vLLM has no such limit.
- Chat sends the model only the messages from the latest summary on
  (`chatModelView`). A record of what is loaded must survive compaction.
- `load_skill` already does something similar: a catalog in the prompt, and
  `loadedSkillNames` reads `<skill_content name="…">` markers back out of the
  history. Reuse that pattern.
- Model size comes from the id only (`parseParamsB` in
  `src/lib/agent/mcpBudget.ts`).
- Changing a Tauri command or a `#[ts(export)]` struct needs
  `./scripts/export-ipc-types.sh`. This plan should need neither.
- A visible change updates `docs/guide/` in the same PR.

## Success criteria

- With the setting on and everything enabled, a first Chat turn sends the core
  schemas and the index, and nothing else. Their total is under 20 KB. The Code
  tab total is under 16 KB. Tests assert both.
- For every turn profile, the union of core and deferred tools equals what
  `getToolSchemas` returns with the setting off. A test asserts this, so
  deferring can never widen or narrow a turn.
- `load_tools` with a family not offered this turn returns an error that names
  the setting or integration to turn on. It loads nothing.
- A load changes neither `tools` nor the system text. A test asserts that both
  are byte-for-byte the same on every turn of a conversation, across a load.
- After compaction, the loaded families are still loaded.
- A live run against the default model and a larger one (phase 05) shows that
  the model loads the right family for each test prompt. The rate is recorded
  and is no worse than an agreed threshold.
- With the setting off, every request is byte-for-byte what it is today.

## Decisions

- **Unit of loading** → a family (video, music, email, …), not one tool. The
  tools in a family are used together, so one round trip gets all of them.
  Each MCP server is one family.
- **Core set (Chat)** → web and fetch tools, file reads, `fs_write_text`,
  `fs_edit_text`, the sandbox tools, `ask_user_question`, `haruspex_docs`,
  `remember_this`, the skill-loading tools and the task tools. 17.3 KB with
  everything on.
- **Core set (Code tab)** → `CODE_TOOLS`, `delegate`, the background-command
  tools, `open_in_shell`, `open_in_editor`, `ask_user_question`,
  `haruspex_docs` and the skill-loading tools. 13.8 KB.
- **Deferred families** → documents (`fs_write_document`,
  `fs_write_spreadsheet`, `fs_write_slides`), email, calendar, contacts,
  images, music, speech, video generation, video editing, screen, skill
  writing, assets (`make_asset`), and each MCP server.
- **How a loaded schema reaches the model** → **C, a `use_tool` proxy**
  (phase 01, 2026-11-01). `tools` holds the core, `load_tools` and
  `use_tool({ name, arguments })`, and never changes. The `load_tools` result
  carries the family's schemas as text. When the backend lets the model call
  a loaded tool directly instead (vLLM does), Haruspex accepts that call as
  well. The options and what was measured:
  - _A. Add to `tools`._ Rejected. It works, but on llama-server every load
    makes the whole prompt process again (22,269 tokens, 5.7 s on this
    machine; much longer on the 680M, not measured).
  - _B. Schema in the result only._ Rejected. It is impossible on llama-server,
    because the tool grammar turns the call into a call to a listed tool
    (0 of 20 runs). The same prompt without the grammar calls `video_probe` in
    10 of 10. It works on vLLM (10 of 10, and a past unlisted call in the
    history is accepted).
  - _C. The proxy._ Chosen. The 9B on llama-server gave correct arguments in
    every run that used it: `video_probe` 10/10, and `video_cut` after a probe
    10/10. That is better than A and the control, which both passed an
    invalid `index` there. Qwen3.8-Flash on vLLM built the nested arguments
    correctly every time. In 5–7 of 10 runs it put the crossfade on the wrong
    clip, against 0 of 10 with A, so a schema given as text is followed less
    closely than one in `tools` by that model.
- **Phase 01 findings that change the rest of the plan:**
  - Anything that changes mid-conversation must go at the end of the prompt.
    That includes the index in phase 04: its lines never change after the
    conversation starts. A loaded family stays listed as it was; the
    `load_tools` result at the tail is what says it is loaded.
  - The 9B does not load a family on its own when the request does not name
    it. "What clips are in ep012?" loaded the family in 0 of 15 runs, with
    thinking on or off. It listed the folder instead. With every tool listed
    it called `video_probe` in 10 of 10. "Use the video tools to list the
    clips in ep012" loaded the family in 15 of 15. Qwen3.8-Flash loaded the
    family in 10 of 10 for the implicit request.
  - So Auto stays off for the 9B, as the default already says. Phase 05
    should test a stronger index line for the 9B before giving up on it.
  - Not tested: OpenRouter and other hosted APIs (C needs nothing from them
    but a listed tool), the 680M's prefill time, and ThinkingCap-3.8-27B
    (compute:3000 served Qwen3.8-Flash on the day).
- **Preload from hints** → when `looksLikeFileOutputRequest` matches, the
  documents family is loaded before the turn starts, as the file-output hint
  already says to use those tools.
- **Where it applies** → interactive Chat turns (local and Remote control) and
  the Code tab. Not Shell, jobs, guests, subtasks or lean turns.
- **Setting default** → on when `parseParamsB` gives more than 12B, or when the
  size is unknown. Off at 12B and below. The user can set it either way.

## Open questions

- Is 12B the right boundary for the default? Phase 01 found the 9B does not
  load a family for a request that does not name it. Phase 05 tests whether a
  stronger index line changes that.
- Should the documents family be core when a working folder is set? It is
  4.6 KB, and "make me a PDF" is common.

## Related

- **Per-turn memory and the KV cache.** Fixed in #852: recalled memories now
  go on the latest user message, so the system text no longer changes from
  turn to turn (turn 2 of a test chat: 83 prompt tokens instead of 20,957).
- **Description trims found by the same audit.** Repeated parameter text
  (~3.7 KB, mostly the video tools' `episode` and `project`), the `fs_write_*`
  rule repeated in four places, `run_python`'s list of fpdf2 and python-pptx
  next to the rule not to use them, and the Code prompt's TOOLS lines that
  repeat the schemas. These also apply when the setting is off.
