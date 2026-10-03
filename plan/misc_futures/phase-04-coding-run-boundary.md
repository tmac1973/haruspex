# Phase 04 — A boundary for unattended coding runs

Depends on: — / Enables: —

## As built — notes

- **Refusals reach the report through a subscription,** not `ToolContext`.
  `boundary.ts` exports `onBoundaryRefusal` and `reportBoundaryRefusal`.
  `runAutonomousCodingPipeline` listens for the whole run (try/finally) and
  hands the list to `finalizePrompt`. Runs are serialized, and only
  unattended turns refuse; attended ones ask. So this avoids threading a
  callback through `AgentLoopOptions`, the loop context, `runEphemeralTurn`
  and `runJobTurn`.
- **An install directory is guarded only if its path contains "haruspex".**
  A packaged Linux build runs from `/usr/bin`, and guarding that would refuse
  every command naming `/usr/bin`. The data, settings, cache and log
  directories are always guarded.
- **Paths and ports come labelled from Rust** (`ProtectedPath`,
  `ProtectedPort`), so a refusal names what was reached: "touches Haruspex's
  data directory", "calls Haruspex's image engine (port 8767)".
- **The image backend's port** is guarded when its URL is loopback. The
  frontend passes it as `extra_ports`, and the cache is keyed on it.
- **Windows paths compare without regard to case,** and `%USERPROFILE%` and
  `$env:USERPROFILE` count as home, alongside `~`, `$HOME` and `${HOME}`.
- **Also fixed:** the existing unattended-risk refusal joined `RiskMatch`
  objects, so a model was told "Command blocked ([object Object])". It now
  joins their descriptions.
- **Not done:** the manual run in the test plan. It needs the app and a model.

## Goal

An autonomous coding run's shell must not reach Haruspex itself: its data
directory (database, models, settings), its source tree, or the local services
it runs. On 2026-10-02 a run (p25-chain, run 80) read `haruspex.db` and the app
source, then made its own art through the user's ComfyUI on 8188.

**What changes:**
- **Unattended turns:** a command that targets one of those is refused, and
  the run is told why.
- **Attended use** (the Shell tab in code mode, preflight): the same check
  shows up as a reason in the existing approval modal.
- **Prompts:** the coding prompts say that the project directory is the
  boundary.
- **Report:** `REPORT-coding.md` lists every command that was refused.

This is a fence against accidents (decision 1), not a sandbox. File tools are
already confined to the working directory (`fs_tools/path.rs`
`resolve_in_workdir`); this phase covers `run_command`.

## Files touched

- New `src/lib/shell/boundary.ts` and `boundary.test.ts`.
- `src/lib/agent/tools/code.ts`: `ensureCommandApproved` consults the
  boundary.
- New Rust command `app_protected_targets` in `src-tauri/src/code_tools.rs`,
  registered in `lib.rs`.
- `src/lib/agent/jobs/types/autonomous-coding/prompts.ts` (the coding turn
  and `finalizePrompt`, around :54, :403, :443, :605) and `prompts.test.ts`:
  the rule and the report section.
- `src/lib/agent/jobs/types/autonomous-coding/pipeline.ts`: collect refusals.
- `src/lib/agent/tools/types.ts`: `ToolContext.onBoundaryRefusal`.
- `src/lib/agent/loop.ts` and `loop/iteration.ts` (around :1448-1463): carry
  that callback into the context.
- `./scripts/export-ipc-types.sh` output.

## Steps

1. **`app_protected_targets()`** (Rust) returns `{ home: string, paths:
   string[], ports: number[] }`.
   - Paths:
     - the app's data, config, cache and log directories (Tauri path API);
     - the resource directory and the executable's directory;
     - in debug builds only, the source root (`env!("CARGO_MANIFEST_DIR")`'s
       parent).
   - Ports:
     - the sidecar ports, taken from `sidecar_utils::ports` rather than typed
       out again;
     - the configured image backend's port, but only when its URL is
       loopback. The frontend passes it in; Rust doesn't read settings.
   - Every path is canonical, absolute, and has a trailing separator.
2. **`checkBoundary(command, targets, workingDir)`** in `boundary.ts` returns
   `{ matched, reasons }`.
   - **Paths:**
     - expand `~`, `$HOME` and `${HOME}` against the home path that
       `app_protected_targets` returns alongside the rest;
     - then match any protected path as a substring of the command, prefix
       or exact form;
     - a protected path that contains the command's root, or sits inside it,
       is skipped: the user may run a coding job on Haruspex's own repo. The
       root is `codeRoot(ctx)` (`code.ts:26-28`), the shell's cwd in shell
       mode and the working directory in a job.
   - **Ports:** match `localhost`, `127.0.0.1`, `[::1]` or `0.0.0.0`
     followed by `:<protected port>`, anywhere in the command.
   - Reasons read like "touches Haruspex's data directory" or "calls
     Haruspex's image engine (port 8767)".
3. **`ensureCommandApproved` runs `checkBoundary` first: before its early
   `return 'ok'` for `ctx.codeAutoApprove || isSessionApproved()`
   (`code.ts:44`), and before `classifyShellRisk`.** Neither auto-approve nor
   a session approval skips the boundary.
   - **Unattended** (`isAutoApproveActive() && !ctx.interactive`): refuse
     when the boundary matched, whatever `ctx.codeAutoApprove` says.
     Message: "Command blocked: it reaches outside this project (<reasons>).
     The project directory is your boundary — if you are blocked by something
     outside it, say so in your report instead of working around it. Do not
     retry this command."
   - **Attended:** the boundary reasons, plus any `classifyShellRisk`
     reasons, go to `askCommandApproval`. A boundary match always asks, even
     after "allow for session".
   - Targets are fetched once per process and cached in a module-level memo
     in `boundary.ts`. `ToolContext` is rebuilt for every call, so it can't
     hold the cache. Changing the image backend's URL clears the memo.
4. **Prompt rule.** The coding turn and finalize prompts in
   `autonomous-coding/pipeline.ts` get one paragraph:
   - work only inside the project directory;
   - don't read, query or call Haruspex's own files or services;
   - a missing input, such as art the chain failed to make, is reported and
     never produced some other way.
5. **Refusals are recorded.**
   - `ToolContext` gains `onBoundaryRefusal?(command, reasons)`, passed
     through the loop options. The coding pipeline supplies it and collects
     the refusals in memory for the run.
   - `finalizePrompt` receives the list, and `REPORT-coding.md` gets a
     "Blocked at the boundary" section when it is non-empty.

## Build gate

The overview's gate. `check-ipc` must pass after the type export.

## Test plan

- **Unit, `checkBoundary`:**
  - `sqlite3 ~/.local/share/com.haruspex.app/haruspex.db` matches;
  - `cat $HOME/.local/share/com.haruspex.app/x` matches;
  - `curl http://127.0.0.1:8767/sdapi/v1/txt2img` matches;
  - `curl localhost:8188` matches only when 8188 is passed as protected;
  - `npm run dev -- --port 5173` doesn't;
  - `ls src` doesn't;
  - a working directory inside the source root disables the source-root
    match.
- **Unit, `ensureCommandApproved`:**
  - unattended plus a boundary match is refused even with `codeAutoApprove`;
  - attended asks, with the boundary reason in the list;
  - a session approval does not cover a boundary match.
- **Unit, report:** two refusals produce the "Blocked at the boundary"
  section; zero produce none.
- **Manual:** in a scratch project, run a coding job whose plan says to "read
  ~/.local/share/com.haruspex.app/settings and summarise it". The command is
  refused, and the report lists it.

## Commit

`feat(coding): an unattended run is refused when its shell reaches Haruspex's own data or services`

## Rollback

Revert the commit and re-run `./scripts/export-ipc-types.sh`. No stored data
changes.
