# 3D delegate — Project Overview

## Problem

The Code tab's specialists tie 3D work to one small model. A specialist is a
one-shot recipe: a fixed prompt, one request, one HTML page back, no tools. The
two 3D kinds were built for the ccore 4B coders, and the results never held up.
The GLB-Coder made a valid GLB on the first try 8 times in 15 and a usable one
about 9 times in 15, and the main model did every repair. The 3D helper's
`check_3d` loop, run by a capable model, is where good assets come from.

The models that do 3D best are frontier models on OpenRouter, and they cost
money for every token. Today a Code session can only use them by making the
frontier model the session's model, so it pays for every turn: reading code,
running tests, chatting. Tim wants the local model (Qwen 27B/35B class or
better) to do the general work and hand only the 3D modelling and animation to
a stronger model, which then sees only the 3D brief and its own checks.

## Goals

- A **3D delegate**: a subtask that runs on a model chosen in Settings → Code →
  Helpers → 3D (any OpenAI-compatible server; OpenRouter is the main case) with
  `check_3d`, project reads, and writes limited to the asset it was asked for.
- A new tool for the Code tab's agent that hands a 3D asset to the delegate:
  a required output path, a free-text task, and optional reference images.
- The delegate works until its files check clean. When it ends, the tool
  runs the same check as `check_3d` on the files on disk. If that check fails,
  or the module was never written, the delegate is told once to fix and
  recheck. The report says plainly when errors remain.
- The agent gets a text report back. The card shows the delegate's steps and
  its render sheet for the user, and its cost.
- Per-call limits: a round cap (default 80) and a dollar cap (default
  unlimited), both set in Settings → Code → Helpers → 3D. Reaching either stops
  the delegate, and it reports what it has.
- Foreground and background calls, like `delegate`'s subtasks.
- The specialists feature is removed: `ask_specialist`, the Text, GLB and
  Three.js scene kinds, Settings → Code → Specialists, the session toggles and
  the `/dev/glb-runner` route.
- The guide (`specialists`, `helpers`, `3d-helper`, `code`) and showcase cards
  describe the app as it is after the change.

## Non-goals

- No 3D delegate in Chat, the Shell, jobs or the 3D models job. The 3D models
  job keeps its own per-stage model rows.
- No list of named delegates and no per-session model override: one model
  setting.
- No generic "run a subtask on model X" tool. The 3D delegate is the only
  model-specific subtask for now.
- No resuming a past delegate call's context. A change is a new call on the
  same path.
- No textures: the delegate can use PNGs already in the project through
  `kit.texture`, but writes none.
- No support for the ccore 4B models. They don't call tools, so they can't run
  the `check_3d` loop.
- No migration of saved specialist entries: they are dropped.

## Users & primary flow

The user is a developer in the Code tab with a local model as the session
model, building a game or a Three.js app.

1. The user sets a delegate model once in Settings → Code → Helpers → 3D
   (source, server, key, model id), and turns the 3D helper on.
2. In a session, the user asks for an asset as usual: "make a goblin with a walk
   cycle for `assets/goblin.glb`".
3. The agent calls the 3D delegate tool with the path, a task written from what
   it knows of the project (scale, style, engine, clips) and any reference
   images. It may run it in the background and carry on.
4. The delegate starts on the delegate model with an empty context. It reads
   the project as it needs, writes the build module (and anim module), and runs
   `check_3d` until it is clean.
5. The card shows its steps, render sheets and running cost. The user can stop
   it.
6. The agent gets the report: files written, size, parts, clips, problems left,
   cost. It wires the asset into the project.
7. For a change, the agent calls again on the same path. The delegate reads the
   existing module and edits it.

With no delegate model set, nothing changes from today: the session's model
uses `check_3d` itself.

## Constraints

- Tauri 2 + SvelteKit 5 runes; TypeScript in `src/lib`, `#lib/...` imports
  with extensions.
- Reuse the subtask machinery (`runSubtask.ts`, `subtaskRun.ts`, cards,
  background subtasks, usage totals) and the model form from
  `agent/jobs/jobModelForm.ts`. No second subtask runner.
- The delegate's model is not the session's. A remote delegate must not hold or
  borrow the session's local inference slot while it works.
- Settings are plain JSON (no `$state` proxies handed to setters).
- A Tauri command or `#[ts(export)]` change needs `./scripts/export-ipc-types.sh`.
- Design for a capable main model (Qwen 27B/35B or better). The 9B is lean
  mode's concern.
- UI copy: one short sentence per section, detail in tooltips, Settings paths
  in full.
- The guide pages stay under 6 KB each; the `Guide` check must pass.

## Success criteria

- With a delegate model set, the Code tab's agent hands a 3D asset to it, and
  the delegate's model calls go to the delegate server, not the session's.
- The delegate writes only the requested build module, its anim module and the
  `.glb`. A write anywhere else is refused.
- A delegate whose files fail the final check in code, or whose module is
  missing, is nudged once, unless it already stopped at a cap. A capped run
  gets the final report call instead. Either way, the result says whether
  errors remain.
- The round cap and dollar cap stop the delegate and it still reports.
  "Unlimited" sets no dollar cap.
- The delegate's tokens and cost count toward the session total and show on its
  card.
- A background delegate call returns at once and reports in a later turn.
- No setting, tool, UI or guide page mentions specialists. In code, only the
  kept migration step for the dead column, its comment and its test do. `npm run check`,
  `npm run lint`, `npm run test`, `cargo test` and the Guide check pass.
- A live run: a local main model in a Code session hands one prop and one
  animated character to an OpenRouter frontier model, and both end with clean
  checks.

## Decisions

- **Where the delegate is available** → Code tab only.
- **How many delegate models** → one 3D model setting; empty means the session
  model does 3D itself.
- **Does the main agent keep `check_3d`** → yes; it gets both `check_3d` and
  the delegate tool.
- **What happens to specialists** → removed entirely, Text kind included.
- **How the delegate writes** → straight into the session's folder, limited to
  the requested build module, anim module and `.glb`; reads anywhere in the
  project; no git needed.
- **Spend limits** → a round cap and a dollar cap per call; the dollar cap can
  be unlimited; both user-settable.
- **Default round cap** → 80 rounds.
- **Default dollar cap** → unlimited.
- **Background calls** → yes, like background subtasks.
- **Revisions** → a new call on the same path; the delegate reads and edits the
  existing module.
- **When a call is done** → the files are clean, enforced with one nudge;
  the report says if errors remain. During planning this became a check run
  in code on the files on disk, the same as `check_3d`, rather than reading
  the delegate's last `check_3d` step. It is the same rule, and the
  delegate's own steps cannot get round it.
- **How the agent calls it** → a new tool, `delegate_3d`, owned by the 3D
  helper; not a kind on `delegate`, and not tied to Settings → Code →
  Subtasks.
- **Inference slot** → the delegate queues on its own model's lane; it
  borrows the parent's slot only when both are on the same lane.
- **Delegate's tools** → read, list, `code_grep`, `code_glob`,
  `fs_write_text` and `fs_edit_text` limited to its three files, and
  `check_3d`. No shell, web or subtasks.
- **Ending at a cap** → stop at the round boundary, then one last call with
  no tools for the report.
- **`code_sessions.specialists` column** → left in place, never read or
  written, as with the dead legacy job columns.
- **Sheet back to the agent** → the final sheet is attached to a foreground
  result when the main model can see images.
