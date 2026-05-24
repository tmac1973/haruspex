# Haruspex Maintenance Guide

This guide is the post-refactor map of the codebase. It describes what lives
where, the patterns to follow when adding code, and the build gates to run
before committing. Pair this with `CLAUDE.md` (conventions) and `plan/` (the
12-phase refactor that produced the current layout).

---

## 1. Repository layout

```
haruspex/
├── src/                     # SvelteKit 5 frontend (SPA, static adapter)
│   ├── routes/              # Top-level pages: chat (+page), settings, setup
│   ├── lib/
│   │   ├── agent/           # LLM agent — loop, tools, parser, system prompt
│   │   ├── components/      # Reusable Svelte components
│   │   ├── sandbox/         # Pyodide WASM sandbox for run_python
│   │   ├── stores/          # Svelte 5 runes-based state (.svelte.ts)
│   │   ├── api.ts           # Chat-completion HTTP client (llama-server)
│   │   ├── markdown.ts      # Markdown → HTML rendering
│   │   └── debug-log.ts     # In-memory ring for the Log Viewer
├── src-tauri/               # Tauri 2.x backend (Rust)
│   └── src/
│       ├── fs_tools/        # File read/write tools (13 modules)
│       ├── proxy/           # Web fetch/search backends (6 modules)
│       ├── server/          # llama-server sidecar lifecycle
│       ├── integrations/    # External services (currently: email/SMTP)
│       ├── sidecar_utils.rs # Shared sidecar primitives
│       ├── whisper.rs       # whisper-server sidecar
│       ├── tts.rs           # koko sidecar
│       ├── inference.rs     # Hardware detection + model recommendations
│       ├── models.rs        # Model catalog + downloader
│       ├── audio.rs         # Mic capture for STT
│       ├── db.rs            # SQLite conversation persistence
│       ├── app_log.rs       # In-process tee sink (stderr + ring buffer)
│       ├── sandbox_*.rs     # Pyodide proxy helpers (fetch/save/sync)
│       ├── links.rs         # OS open-file/url dispatcher
│       ├── lint.rs          # Python AST lint (offered to run_python)
│       └── lib.rs           # Tauri entry + command registration
├── audits/                  # 2026-05-14 refactor audits (kept for history)
├── plan/                    # 12-phase refactor plan (kept for history)
├── scripts/                 # dev-setup, build-sidecars, install-hooks, etc.
└── CLAUDE.md                # Per-project Claude conventions
```

---

## 2. The sidecar pattern

Three long-running processes ship as Tauri sidecars and expose HTTP APIs on
localhost:

| Sidecar          | Port | Source       | Purpose                        |
| ---------------- | ---- | ------------ | ------------------------------ |
| `llama-server`   | 8765 | llama.cpp    | LLM inference (OpenAI-compat)  |
| `whisper-server` | 8766 | whisper.cpp  | Speech-to-text                 |
| `koko`           | 3001 | Kokoros      | Text-to-speech (OpenAI-compat) |

### `sidecar_utils.rs` — what's shared

Every sidecar file (`server/mod.rs`, `whisper.rs`, `tts.rs`) consumes the
same primitives from `sidecar_utils`:

- `kill_process_on_port(port)` — orphan reaper on startup
- `strip_ansi(line)` — strip color codes before log capture
- `push_log(buf, line)` — bounded ring buffer with ANSI strip
- `poll_health(client, url, timeout)` — wait until `/health` returns OK
- `http_client()` — shared `reqwest::Client` factory
- `SidecarStatus` — `{ Stopped | Starting | Ready | Error(String) }` enum,
  serialized as `{ type, message }` for the frontend
- `ports::{LLAMA, WHISPER, TTS}` and `timing::*` — magic-number-free
  configuration

### Adding a sidecar

1. Add a new `<name>.rs` (or `<name>/mod.rs` if it has helpers).
2. Reach for `sidecar_utils` first; don't reimplement port-kill, ANSI strip,
   health poll, or the status enum.
3. Add a port constant to `sidecar_utils::ports`.
4. Register Tauri commands in `lib.rs` (see Section 6).
5. Add a frontend store in `src/lib/stores/<name>.svelte.ts` that listens to
   the status event.

### Sidecar status state machine

`Stopped → Starting → (Ready | Error)`. The frontend reads `s.type === 'Ready'`
(matches the `#[serde(tag = "type", content = "message")]` shape). All three
sidecars use the same shape — don't introduce a fourth variant without
updating every consumer.

---

## 3. Agent loop

The LLM agent lives in `src/lib/agent/`. The dispatch flow is:

```
sendMessage (chat.svelte.ts)
  → runAgentLoop (loop.ts)                ← thin for-loop dispatcher (~25 LOC)
      → runIteration (loop/iteration.ts)  ← per-turn work, 6 nudge branches
          → NudgeState (loop/nudges.ts)   ← recovery counters
          → executeTool (tools/registry.ts) ← tool dispatch
      → runMaxIterationsFinalSynthesis    ← when MAX_ITERATIONS hit
```

### Where to add what

- **New nudge / recovery heuristic** → add a counter + predicate to
  `NudgeState`. Predicates follow `needsX()` / transitions follow `markX()` /
  consumers follow `consumeX()`. The runIteration body should read as a
  series of `if (nudges.needsX()) { … nudges.consumeX(); continue; }`.
- **Change the per-turn execution flow** → edit `runIteration`. Don't put
  per-turn state in `runAgentLoop` — it intentionally stays a dispatcher.
- **Add a system-prompt fragment** → `system-prompt.ts`. Don't inline
  prompts inside `runIteration`.
- **Add a streaming-response hook** → `iteration.ts:streamFinalSynthesis` is
  the canonical helper.

### LoopContext / LoopState

`LoopContext` is the read-mostly bag of dependencies (api client, abort
signal, system prompt, settings snapshot). `LoopState` is the per-turn
mutable scratchpad (messages, pending images, nudge counters). Pass
`ctx`/`state` through — don't reach back into the chat store from inside
the loop.

---

## 4. Tool system

Each LLM tool registers itself at module load. `tools/index.ts` triggers
the side-effect imports; from there `getToolSchemas()` filters and
`executeTool()` dispatches.

### Anatomy of a tool registration

```ts
import { labelArg, toolInvokeError } from './_helpers';
import { registerTool } from './registry';
import { toolResult } from './types';

registerTool({
  category: 'fs',                  // 'fs' | 'web' | 'email' | 'sandbox' | 'other'
  requiresVision: false,           // hide when backend lacks vision
  schema: {
    type: 'function',
    function: {
      name: 'my_tool',
      description: '...',
      parameters: { /* JSON schema */ }
    }
  },
  displayLabel: labelArg('path'),  // see _helpers.ts
  async execute(args, ctx) {
    try {
      const result = await invoke<string>('my_tool', { /* ... */ });
      return toolResult(result);
    } catch (e) {
      return toolResult(toolInvokeError('my_tool', e));
    }
  }
});
```

### `_helpers.ts` — what's already factored

- `labelArg(key)` — replaces the `displayLabel: (args) => (args.X as string) || ''`
  boilerplate. Always use this for single-arg labels.
- `toolInvokeError(name, e)` — uniform error string for failed Tauri invokes.
- `proxyFetch(url, caller)` — shared web-fetch wrapper used by `fetch_url`,
  `research_url`, etc.
- `runSubAgent(messages, maxTokens, signal)` — spawn a focused sub-agent
  (currently used by `research_url`).

### Filter rules (registry.ts)

Tools auto-filter based on context:

| Category   | Gating                                      |
| ---------- | ------------------------------------------- |
| `fs`       | working directory must be set               |
| `web`      | always available                            |
| `email`    | at least one enabled email account          |
| `sandbox`  | `settings.sandboxEnabled === true`          |
| any        | `requiresVision: true` hidden on text-only  |
| (special)  | `fetch_url` hidden in `deepResearch` mode   |

### Adding a tool

1. Choose the right file: `fs-read.ts`, `fs-write.ts`, `web.ts`, `email.ts`,
   `sandbox.ts`. Create a new file only if the tool genuinely doesn't fit.
2. Use `labelArg()` for the displayLabel where the label is a single arg.
3. Wrap failing Tauri invokes with `toolInvokeError()`.
4. If the tool returns an image, push to `ctx.pendingImages` (cap at
   `MAX_PENDING_IMAGES` for non-vision-dedicated tools).
5. If the tool writes a file, follow the `writeExecutor` pattern in
   `fs-write.ts` (handles conflict resolution + thumbnail attachment).
6. Test in `src/lib/agent/<file>.test.ts`. Tests are co-located.

---

## 5. File-format builders (`fs_tools/`)

The 5625-LOC `fs_tools.rs` monolith was split into 13 modules. Pick the
right one when adding code:

| Module             | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| `path.rs`          | Workdir resolution + path safety (`resolve_in_workdir`, `refuse_if_exists`, `workdir_path`) |
| `text.rs`          | Plain-text read / write / append                     |
| `images.rs`        | PNG/JPEG load, EMU/cm conversion, markdown image refs|
| `markdown_inline.rs` | Inline markdown → styled runs, table flattening, ASCII folding |
| `pdf_read.rs`      | PDFium + pdf-extract fallback for `fs_read_pdf`      |
| `pdf_write.rs`     | `build_pdf` (printpdf, Helvetica/Courier WinAnsi)    |
| `docx.rs`          | OOXML word document builder                          |
| `odt.rs`           | OpenDocument text builder                            |
| `pptx.rs`          | OOXML PowerPoint builder (`build_pptx` + 11 part writers + `ImageIndex`) |
| `odp.rs`           | OpenDocument presentation builder                    |
| `xlsx.rs`          | `XlsxSheet` reader + writer                          |
| `download.rs`      | URL-to-file download with proxy support              |
| `mod.rs`           | Module declarations + the test suite                 |

### Adding a new file format

1. Create `fs_tools/<format>.rs`. Use `pptx.rs` as a reference — it's the
   most complete example of an OPC/OOXML builder.
2. Reach for shared helpers first:
   - `path::resolve_in_workdir` for any user-supplied relative path
   - `images::{load_markdown_images, image_pixel_dimensions, MAX_DOC_IMAGE_WIDTH_EMU}`
     for image embedding
   - `markdown_inline::{parse_inline_markdown, ascii_fold_for_pdf,
     format_table_as_monoblock}` for prose rendering
3. Decompose large builders into per-OPC-part helpers (`write_<part>`),
   following the `build_pptx` shape. Aim for the top-level builder to be
   ≤ 80 LOC of "compose the parts" logic.
4. Add `pub mod <format>;` to `mod.rs` and tests inside `mod tests { }`.
5. Register the Tauri command in `lib.rs` using a full module path:
   `fs_tools::<format>::fs_write_<format>` (re-exports break
   `generate_handler!` — see Section 6).

### When to extract a helper

When you find yourself writing the third copy of "load image bytes, decide
DPI, compute EMU dimensions", lift it into `images.rs`. The audit that
drove this refactor flagged ~12 such duplications; the rule is **three
strikes**, then extract.

---

## 6. Tauri command registration

`lib.rs` registers every Tauri command via `tauri::generate_handler!`. The
macro expects `__cmd__<name>` shims at the **exact path** you list. This
caught us in phase 02:

- ✗ `pub use path::fs_list_dir; … generate_handler![fs_list_dir]` — fails
  because `pub use` doesn't re-export the macro-generated shim.
- ✓ `generate_handler![fs_tools::path::fs_list_dir]` — full path works.

**Rule**: always use the full module path inside `generate_handler!`. Don't
re-export commands.

---

## 7. Proxy / web backends

`proxy/` handles all outbound HTTP — search, fetch, image search. Six
modules:

| Module       | Purpose                                              |
| ------------ | ---------------------------------------------------- |
| `bypass.rs`  | NO_PROXY parsing + suffix/CIDR matching              |
| `extract.rs` | HTML → readable text (readability heuristic)         |
| `paywall.rs` | Heuristic paywall signal detection                   |
| `search.rs`  | Brave / DuckDuckGo / Mojeek / SearxNG HTML parsers + rotation |
| `images.rs`  | Wikimedia Commons image search + page image extraction|
| `mod.rs`     | Public commands (`proxy_fetch`, `proxy_search`, …) + tests |

### Adding a search backend

Currently a sum-type (`SearchProvider` enum + per-engine `parse_*_html`
functions). The SearchBackend trait extraction was deferred — when adding
a fifth engine, weigh extracting the trait vs. adding one more arm. If you
do extract:

1. Trait lives in `search.rs`. Each engine becomes a `pub struct` impl.
2. `proxy_search` switches on the settings provider, builds the right
   struct, calls `fetch_and_parse()`.
3. Keep the `parse_<engine>_html` functions as free helpers so tests don't
   need to instantiate the strategy.

### Paywall detection

`paywall.rs::detect_paywall_signal` — extend the patterns here. The tool
side (`web.ts`) uses `paywallErrorMessage()` to format the model-facing
message; don't duplicate that string.

---

## 8. Settings UI

`settings/+page.svelte` is the host. Section components live in
`src/lib/components/settings/`. Phase 09 extracted:

- `EmailSection.svelte` — account CRUD + provider preset loading
- `ModelsSection.svelte` — model catalog with live download progress

### Adding a settings section

1. Create `components/settings/<Name>Section.svelte`.
2. Read/write settings via `getSettings()` / `setSettings()` from
   `$lib/stores/settings` — no prop drilling.
3. Mount it from `settings/+page.svelte` inside the existing layout grid.
4. Don't add a new section directly to `settings/+page.svelte` — every
   new setting that owns more than ~30 LOC of UI becomes its own component.

`settings/+page.svelte` is still 1258 LOC; further splits (search,
inference backend, proxy, sandbox) are deferred follow-up work.

---

## 9. Modal components

`Modal.svelte` and `ModalButton.svelte` (under `components/`) are the shared
backdrop + dialog + variant-styled-button primitives. Consumed by
`FileConflictModal.svelte` and `SandboxApprovalModal.svelte`.

**Rule**: any new modal builds on `Modal` + `ModalButton`. Don't hand-roll
backdrops, focus traps, or button hover states.

---

## 10. Logging

Two distinct sinks — pick the right one:

| Sink                                | Use for                                    |
| ----------------------------------- | ------------------------------------------ |
| `log::{info,warn,error}!` (Rust)    | Backend events — tee'd to stderr + Log Viewer via `app_log.rs` |
| `logDebug('<scope>', '<msg>', {…})` (TS) | Frontend events — Log Viewer ring buffer |
| `console.*` (TS)                    | Don't — invisible to the user once shipped |

`db.ts` uses `logDebug('db', '<fn> failed', { error: String(e) })` for all
catch-and-continue sites. Follow that pattern: silent swallow is a code
smell.

---

## 11. Persistence

| Store                   | Holds                                            |
| ----------------------- | ------------------------------------------------ |
| `db.ts`                 | Conversations, messages (SQLite via Tauri command)|
| `stores/settings.ts`    | User settings (localStorage)                     |
| `stores/chat.svelte.ts` | In-memory message list + streaming state         |
| `stores/server.svelte.ts` / `whisper`/`tts` | Sidecar status + ports     |
| `stores/setup.svelte.ts`| First-run wizard state                           |
| `stores/fileConflict.svelte.ts` / `sandboxApproval` | Modal queues       |
| `stores/jobs.svelte.ts` / `jobRuns.svelte.ts` | Job definitions + run history (SQLite) |

A new persistent record goes through `db.ts`. A new piece of session-only
state goes into a runes store. Settings go into the settings store. Don't
mix.

---

## 11a. Jobs (Phase 14)

The Jobs tab lets users author, schedule, and run multi-step prompt
pipelines unattended. Each step runs as a fresh agent conversation; the
previous step's final assistant text is auto-prepended to the next
step's prompt. No conversation history carries between steps — plays to
the 9B model's strength at single-objective prompts.

### Schema

Four tables, all in the app SQLite DB, all created by `db.rs`'s single
migration block. Snapshots into `job_run_steps` rather than FK-ing
`job_steps` so editing a job later doesn't rewrite past run history.

| Table           | Purpose                                                       |
| --------------- | ------------------------------------------------------------- |
| `jobs`          | One row per saved job (name, working_dir, auto_approve, schedule, next_due_at) |
| `job_steps`     | Ordered prompts that make up a job (job_id, ordering, prompt, deep_research)   |
| `job_runs`      | One row per run attempt (status, trigger, queued/started/finished, error)      |
| `job_run_steps` | Per-step record within a run (prompt_authored, prompt_rendered, status, output)|

### Execution flow

```
JobsTab → JobList Run button → runner.enqueue(jobId)
   │           │
   │           ├─ getJob() — snapshots steps at enqueue time
   │           ├─ createJobRun() — inserts job_runs row (status='queued')
   │           └─ pending.push(snapshot)
   │
   └─ runPipeline (per run, in finally drains next from queue)
         ├─ markRunStarted
         ├─ for each step:
         │    ├─ markRunStepStarted (with rendered prompt)
         │    ├─ withInferenceSlot(() => runWithAutoApprove(() => runEphemeralTurn(...)))
         │    └─ markRunStepFinished
         └─ markRunFinished
```

`runEphemeralTurn` (`src/lib/agent/runEphemeralTurn.ts`) wraps
`runAgentLoop` for the headless case — no chat store, no persisted
conversation row, just system+user messages and a streaming callback.

### Inference queue (`inferenceQueue.svelte.ts`)

Both chat and jobs funnel `runAgentLoop` calls through this FIFO. The
default capacity is 1; the remote-backend setting
`allowParallelInference` makes capacity unbounded for servers that
support concurrent requests (vLLM, llama.cpp `-np N`, hosted APIs).
Each acquire is exposed as a `ticket` (with consumer identity) so the
UI can render "waiting behind X" without subscribing to the queue.

### Auto-approve plumbing (`approvalOverride.ts`)

A non-reentrant module-level flag flipped by `runWithAutoApprove(fn)`.
Two existing tool prompts consult it:

- `sandbox.ts run_python` — skip `askApproval`, auto-allow.
- `fs-write.ts overwrite conflict` — skip `askFileConflict`, auto-overwrite.

Adding a new interactive tool prompt? Read `isAutoApproveActive()` and
default to the unattended choice if true. Safe because the agent loop
serializes tool calls within a turn and the runner serializes runs.

### Scheduler (`scheduler.svelte.ts`)

A single `setInterval(30_000)` ticker started from `+layout.svelte`'s
onMount, after `recoverOrphanRuns`. Each tick:

1. `listDueJobs(now)` — `WHERE schedule_kind != 'manual' AND next_due_at <= ?`
2. For each due job: recompute `next_due_at` FIRST (via TS
   `computeNextDueAt`), then `enqueue(jobId, 'scheduled')`. Recompute-
   first avoids a double-fire if enqueue is slow.

Date math lives in TS so we don't take a chrono dep. The `interval`
branch skips ahead by missed periods when we've drifted behind (e.g.
app was closed for a while) so the catch-up isn't a burst.

The app must be open for the scheduler to fire — there is no headless
mode. The job editor surfaces this in the schedule field's tooltip + an
amber warning banner.

### Crash recovery

`recover_orphan_runs()` (Rust) sweeps any `job_runs` row at `queued` or
`running` to `interrupted`, and any `job_run_steps` at `running` to
`cancelled`. Called from `+layout.svelte` onMount before the scheduler
starts. Idempotent. `COALESCE`s preserve existing timestamps.

### What to read when modifying

- Adding a schedule kind → `Schedule` union + `scheduleToConfigJson` +
  `configJsonToSchedule` + `computeNextDueAt` (jobs.svelte.ts) +
  `JobScheduleField.svelte`. The Rust side stores `schedule_config` as
  opaque JSON, so no Rust change required.
- Changing what a step can do → snapshot fields land in
  `JobStepInput`/`JobStep` on both sides. `replace_job_steps` rewrites
  the whole step list — there's no per-step UPDATE.
- New per-job behavior flag (like `auto_approve_tools`) → schema column
  + JobInput + JobSummary + JobWithSteps + form control + thread into
  the runner. Lots of touch points; consider whether it can be a
  setting instead.

---

## 12. Conventions (the rules to internalize)

- **Conventional Commits required** — release-please parses every commit
  to compute versions and changelog. Prefix: `feat:` / `fix:` / `refactor:`
  / `docs:` / `chore:` / `ci:`. Add a scope when meaningful:
  `refactor(loop): …`.
- **Pre-commit hook** runs `npm run format:check`. Run `npm run format`
  before committing or the hook blocks you.
- **Tabs for indentation, single quotes, no trailing commas** (Prettier).
- **Rust: 4-space indent, 100-char line width** (`cargo fmt`).
- **Tests co-located**: `foo.ts` → `foo.test.ts`.
- **Svelte 5 runes mode everywhere** — `$state`, `$derived`, `$effect`,
  `$props`. Don't reach for legacy stores or `export let`.
- **SvelteKit SPA mode** — SSR disabled, `fallback: 'index.html'`. Don't
  add `+server.ts` or `+page.server.ts`.
- **No comments unless the WHY is non-obvious.** Identifier names already
  explain the WHAT.

---

## 13. Build gates

Run these before every commit; CI runs the same matrix.

```bash
npm run format        # Run first — pre-commit hook checks this
npm run check         # svelte-check + tsc
npm run lint          # ESLint (30 known warnings, 0 errors expected)
npm run test          # Vitest (currently 181 tests)
npm run build         # Production frontend build

# Rust (from repo root via manifest path, or cd src-tauri/)
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

**Always use `--all-targets`** for clippy — without it, test-only unused
imports slip through and fail CI.

For full smoke testing:

```bash
GDK_BACKEND=x11 npm run tauri dev
```

---

## 14. ESLint warnings — when to add vs. defer

Phase 12 added complexity guardrails as **warn-level** rules:

| Rule                      | Threshold                |
| ------------------------- | ------------------------ |
| `complexity`              | 15                       |
| `max-depth`               | 4                        |
| `max-lines-per-function`  | 80 (skips blanks + comments) |
| `max-lines`               | 400 (skips blanks + comments) |

Exemptions: `.svelte` files (markup + style inflate counts), `*.test.ts` /
`*.test.js` (describe/it callbacks are naturally long).

**The 30 warnings as of phase 12 are pre-existing sites whose splits were
deferred.** They include:

- `chat.svelte.ts` (810 LOC, sendMessage 118 LOC)
- `loop/iteration.ts` (656 LOC, runIteration 284 LOC + complexity 57)
- `settings.ts` (484 LOC)
- `setup.svelte.ts` (runTestQuery 130 LOC + complexity 33)
- `python.worker.ts` (846 LOC — Pyodide bridge)
- `worker-manager.ts` (490 LOC — sandbox protocol dispatch)
- `+page.svelte` (662 LOC), `settings/+page.svelte` (1258 LOC), `setup/+page.svelte` (677 LOC)

**Rule**: don't make these worse. A new function over 80 LOC or a new file
over 400 should justify itself in the PR description. A new warning in a
previously-clean file is a regression — either fix it or add an inline
`// eslint-disable-next-line max-lines-per-function -- <reason>` with a
real reason.

---

## 15. Deferred refactor work

These are documented in `plan/phase-12-polish.md` (sub-phases 12f–12h) and
in earlier-phase commit messages. None is blocking; tackle when you're
already in the area.

- **`setup/+page.svelte` split** (12f) — five-step wizard
  (welcome/hardware/download/test/chat). Each `if (currentStep === 'foo')`
  block becomes a `<XStep>` component under `components/setup/`.
- **`chat.svelte.ts` split** (12g) — only if fan-in justifies it
  (`grep -rnE "from '\\$lib/stores/chat'" src | wc -l ≥ 5`). Target:
  `state.svelte.ts` + `actions.ts` + `persistence.ts` + `index.ts`.
- **`attachThumbnailIfImage` helper** (12h) — extract the `IMAGE_EXT_RE`
  check + `invoke('fs_read_image')` that appears in both `fs-read.ts` and
  `fs-write.ts`.
- **`SearchBackend` trait** — only if a fifth search engine lands.
- **`output_reader` extraction in `server/mod.rs`** — phase 11 deferred
  the rest of the supervisor loop.

---

## 16. Where to find historical context

- `audits/code-duplication-2026-05-14.md`, `code-complexity-…`,
  `design-patterns-…` — the 3 audits that drove the refactor. R-N / C-N /
  P-N citations in commit messages refer to these.
- `plan/refactor-plan.md` and `plan/phase-NN-*.md` — the 12-phase plan
  with per-phase test prompts. Future audits should follow the same shape.
- Branch `refactor/phase-01-sidecar-utils` (PR #39) — 15 commits, each
  scoped to a single phase. Use `git log --oneline main..HEAD` from that
  branch (or read the merge commit on `main` afterward) to see the
  full sequence.

---

## 17. When the codebase grows again

The next refactor cycle should:

1. Generate fresh audits (duplication / complexity / design-patterns).
2. Compare against the phase-12 baselines (warnings list above).
3. Promote any sub-phase from Section 15 if it's no longer optional.
4. Update this file with the new layout.

Aim to never let a single file exceed 1000 LOC outside the documented
exceptions (`chat.svelte.ts`, `+page.svelte` files, `python.worker.ts`).
The audit / plan / phase workflow scales.
