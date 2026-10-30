# Lean Mode — Project Overview

## Problem

Haruspex now ships a large tool set. A Chat turn with no working folder sends
14 tool schemas (~12.6k chars, ~3.6k tokens). With a working folder it sends
32 (~29.7k chars, ~8.5k tokens), and email, calendar, MCP and image generation
add more on top. On a small model with slow hardware this hurts three ways:
the first turn takes minutes to process on CPU, a small context window loses
half its room before the user types, and a 9B model picks tools badly when it
has thirty to choose from.

The Code tab and the Shell assistant need a model that plans and follows
multi-step instructions. The 9B default does not, so for those users the two
tabs are noise: they invite work the model cannot do. Nothing in the app today
says "this machine and model are best at chat and research", and nothing
narrows the app to match.

## Goals

- A single setting, **Settings → General → Lean mode**, that narrows Haruspex
  to chat and research.
- In lean mode, Chat sends a small, fixed tool set: web search and fetch,
  `research_url`, `image_search`, `haruspex_docs`, memory, `load_skill` /
  `read_skill_file` for installed skills, and read-only file tools
  (`fs_read_*`, `fs_list_dir`) when a working folder is set.
- Lean Chat's tool schemas stay under 9.5k chars (~2.7k tokens) even with a
  working folder, enforced by a test.
- Lean Chat's system prompt drops the sections for features lean mode turns
  off, so the model is never told about a tool it does not have.
- The Code and Shell tabs, their shortcuts and every path into them (Chat's
  "open in shell", Tasks chip, code windows) are hidden in lean mode.
- The Jobs tab stays, offering only the research job type. Existing jobs of
  other types are paused and shown as paused.
- Integrations the user configured (MCP servers, email, calendar, contacts,
  screen capture, image / music / video generation) are paused in lean mode,
  and Settings → General → Lean mode lists which ones are paused.
- An always-visible **Lean mode** badge in the window header. Clicking it opens
  Settings → General at the lean mode toggle.
- The setup wizard recommends lean or full mode on a new step after the test
  query, with the recommendation pre-selected and one line saying why. The
  user can pick either.
- Existing users whose model or hardware fits the rule get a one-time,
  dismissible notice offering lean mode.
- When the user switches to a model that can run the full app, the badge shows
  a one-time hint suggesting they turn lean mode off.
- The Remote control web client follows the same rules: lean tool set for
  remote Chat turns, no Code tab, and the same badge (without the settings
  link).

## Non-goals

- No automatic switching. Lean mode changes only when the user changes it;
  the app only recommends and hints.
- No per-integration opt-in inside lean mode. Lean mode is one switch; a user
  who wants an integration back turns lean mode off.
- No change to full mode's tool set. Merging the `fs_write_*` tools into one
  is a separate piece of work.
- No reading of GGUF metadata for parameter count. Model size comes from the
  model id via the existing `parseParamsB`.
- No trimming of the descriptions of the tools lean mode keeps, unless the
  size test fails without it.
- No change to what a job's own stages allow (`toolAllowlist`); lean mode only
  limits which job types can be started.
- No stopping of MCP server processes or other integration background work,
  and no hiding of integration UI outside the tool list. "Paused" means the
  model is not offered the integration's tools.
- No deletion of Code or Shell sessions, settings or history. Hidden is not
  removed; turning lean mode off brings everything back as it was.

## Users & primary flow

Users with a small local model (≤9B) or a machine with no GPU or a slow
integrated GPU.

New user:

1. Runs the setup wizard, picks or connects a model, passes the test query.
2. Sees a new step, "How much should Haruspex do?", with **Lean** and **Full**.
   The recommended one is pre-selected with a one-line reason, e.g. "Recommended
   for a 9B model."
3. Picks one and finishes. In lean mode the main window shows Chat and Jobs
   tabs only, and a **Lean mode** badge in the header.
4. Later clicks the badge, lands on Settings → General → Lean mode, sees what is
   off (tabs, tool groups, paused integrations) and can turn it off.

Existing user (after updating):

1. If the active model is ≤9B or the hardware is weak, a one-time notice offers
   lean mode with "Turn on" and "Not now". Otherwise nothing changes.

User who outgrows lean mode:

1. Switches to a model that parses to >9B, or to a remote model of unknown size.
2. The badge shows a one-time hint that this model can run the full app, with a
   link to the setting.

## Constraints

- Tauri 2 + SvelteKit 5 (runes), settings as plain JSON in
  `src/lib/stores/settings.ts`; a new boolean needs an `AppSettings` field and a
  default, and no migration.
- The tool list is filtered in `getToolSchemas`
  (`src/lib/agent/tools/registry.ts`); lean mode must fit the existing filter,
  not replace it, so the current safety gates (no `email_compose` for jobs,
  interactive-only tools) still apply.
- Model size is known only from the id string (`parseParamsB` in
  `src/lib/agent/mcpBudget.ts`). Remote and imported models may have no size.
- Hardware signals come from `hardware_detect` (`src-tauri/src/hardware.rs`):
  `gpu_available` and `gpu_integrated_slow` decide "weak hardware".
- llama-server caches the prompt prefix, so the lean tool list must stay stable
  across turns within a conversation. It is a fixed set, so it changes only
  when the user toggles lean mode or the working folder; one cache miss then is
  accepted.
- UI copy follows the project rule: one short sentence per section, extra detail
  in a `title` tooltip, Settings paths named in full.
- Any visible change updates `docs/guide/` in the same PR (the `Guide` check
  enforces it); `docs/guide/shortcuts.md` is test-locked to
  `src/lib/shortcuts.ts`.
- Changing a Tauri command or a `#[ts(export)]` struct needs
  `./scripts/export-ipc-types.sh`.

## Success criteria

- With lean mode on, a Chat turn with a working folder and every integration
  configured sends only the lean tool set, and its schemas total under 9.5k
  chars. A test asserts this.
- With lean mode on, the Chat system prompt contains no EMAIL, CONNECTED
  INTEGRATIONS or PYTHON SANDBOX section. A test asserts this.
- With lean mode on, the tab bar shows Chat and Jobs only; Ctrl/⌘ shortcuts,
  the Tasks chip and code windows cannot reach Code or Shell; the Jobs "new job"
  picker lists only Research.
- The header shows a **Lean mode** badge whenever the setting is on; clicking it
  opens Settings → General with the lean mode toggle in view.
- The setup wizard pre-selects Lean for a ≤9B model or weak hardware, and Full
  otherwise (including remote models of unknown size); either choice is saved.
- An existing user on a ≤9B model sees the lean mode notice once; dismissing it
  never shows it again.
- Switching from a 9B to a model id that parses to >9B, or to a remote model of
  unknown size, shows the badge hint once for that model.
- Turning lean mode off restores every tab, tool and integration exactly as
  before, with no lost sessions or settings.
- The Remote control web client in lean mode shows Chat only, a lean badge, and
  its Chat turns send the lean tool set.
- `docs/guide/` describes lean mode (settings, getting started, shortcuts,
  remote control), and all build gates pass.

## Decisions

- **When the wizard recommends lean mode** → when the model is ≤9B OR the
  hardware is weak; either alone is enough.
- **What counts as weak hardware** → no GPU (`gpu_available` false) or a slow
  integrated GPU (`gpu_integrated_slow` true).
- **Remote model of unknown size in the wizard** → recommend Full; Lean only
  when the id parses to ≤9B.
- **Where the wizard asks** → a new step after the test query, for both the local
  and the remote path, with the recommendation pre-selected.
- **Switching to a bigger model while lean mode is on** → lean mode stays on; the
  badge shows a one-time hint suggesting turning it off.
- **When the hint shows** → the user switches, while lean mode is on, to a model
  that parses to >9B or is a remote model of unknown size; once per model. The
  model active when lean mode is turned on never gets the hint.
- **Tabs in lean mode** → Chat and Jobs; Jobs offers the research job type only;
  Code and Shell hidden with their shortcuts.
- **Configured integrations** → paused in lean mode; Settings → General → Lean
  mode lists which are paused.
- **Working-folder file tools** → read-only (`fs_read_*`, `fs_list_dir`); no
  `fs_write_*`, no `run_python`.
- **Skills and memory** → memory kept; skills load-only (`load_skill`,
  `read_skill_file`), no `create_skill` / `update_skill`.
- **Tool-list size target** → under 9.5k chars (~2.7k tokens) with a working
  folder, held by a test. Raised from 7k after measuring: the kept set with all
  seven read tools is ~9k chars.
- **Remote control web client** → same rules: lean tool set, no Code tab, badge
  without a settings link.
- **Existing users** → one-time dismissible notice only when the model is ≤9B or
  the hardware is weak.
- **Ask-the-user tool** → `ask_user_question` is not in the lean set; the model
  asks in plain text.
- **Existing non-research jobs** → paused while lean mode is on, shown greyed as
  "Paused by lean mode"; scheduled runs skipped; a running one finishes.
- **Turning lean mode on while a Code or Shell turn runs** → the switch is
  disabled until they are idle, with a tooltip saying to finish or stop them.
- **What "paused" means for an integration** → its tools are not offered and the
  prompt does not name it. Its settings, background processes (MCP servers)
  and UI entry points such as the camera button are left as they are.
- **Shell tab** → hidden entirely; open terminals keep running in the
  background.
- **Badge click** → opens Settings → General scrolled to the lean mode toggle,
  which lists what is off.
