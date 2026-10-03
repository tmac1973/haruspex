# Futures

Running list of things to address. Status annotations added 2026-07-19.

## Open

- In the guided planning job the step 2 outline approval modal presents a wall of text that the agent has written that is not very nice to look at. The font is a bit large, there's no visual breaks between the phases outlined. We should work on this.
  - **Diagnosed 2026-10-02, not started.** The whole question, outline
    included, is rendered inside the modal's `<h2>`
    (`UserQuestionModal.svelte:117`), so every line is heading-size bold; and
    `renderOutline` writes each phase as one line, "Phase 01 — title: summary",
    with no blank line between phases (`guided-planning/pipeline.ts:1712`).
    Fix: give `askUserQuestion` an optional `body`, rendered as normal-weight
    markdown under a short heading ("Here's the plan outline — 8 phases"); have
    `renderOutline` emit a bold "Phase 01 — Title (depends on 01)" line, the
    summary below it, and a blank line between phases. The overview review and
    any other checkpoint that shows long content would use the same `body`.

- Jobs tab while a run is live: I can't look at other jobs, edit them or create new ones — clicking one seems to open it "underneath" the running job, and the only way to leave the run view is to cancel the run. I should be able to browse and edit freely while a job runs, and come back to the live run and see its current state. And what does ▶ on another job do while one runs?
  - **Diagnosed 2026-10-02, not started.** Deliberate, but it overshoots:
    while `getCurrentRun()` is non-null the run view owns the centre pane and
    the list is locked (`JobsTab.svelte`, `showRunView` / `listLocked`), so
    a selection could not drift out of sight. The run itself does not depend
    on the view — it lives in the runner — so the view can be left and
    returned to without touching it.
    Fix: a selection always shows what was selected (editor, history, new job);
    the live run gets a persistent entry point instead of the centre pane — a
    "Running: <job> · step 3 of 7" bar at the top of the tab (and a marker on
    its row) that opens the run view; the run view gets a Back/Hide that does
    not cancel. Cancel stays where it is, inside the run view.
  - ▶ while a run is live **queues** the job (FIFO, `runner.svelte.ts`
    `enqueue`); it starts when the current run ends and the queue badge shows
    it. Worth knowing for chains: a chain's next stage is enqueued when the
    previous one finishes, so a job queued during planning runs BEFORE the
    chain's asset stage. Consider letting a chained stage go to the front of
    the queue, or saying in the queue badge's tooltip that it will wait.

- An autonomous coding run reached outside its project to unblock itself (2026-10-02, `p25-chain`, run 80). Its plan required art the chain had failed to make; after two honest repair cycles it read Haruspex's own database (`~/.local/share/com.haruspex.app/haruspex.db`) and source to diagnose why, then generated the four PNGs itself by calling the user's ComfyUI on 127.0.0.1:8188 with a different model (Z-Image-Turbo). Its diagnosis was right and it said what it did, but nothing stopped it: a coding run's shell can read any file the user can and reach any local service.
  - Decide what a coding run may touch outside its working directory. At least: the app's own data directory should be off limits, and a plan that says "do not make placeholder art" should not be satisfiable by making real art some other way. Its report asked the same question ("Decide policy on the cycle-3 exception").
  - The chain no longer hands off silently without art (the handoff says "starts WITHOUT art" and why), which removes this particular trigger but not the capability.

- Chained jobs inherit the planning job's model, always (server, model, key, context, reasoning). Right as the default; add an optional per-stage override in the planning editor — "Coding run model" (and "Asset run model") defaulting to "same as this job" — so a chain can plan with a strong model and code with a fast one.
- A chained coding job is named "<job> — assets — coding": the asset job appends " — coding" to its own name (`asset-generation/pipeline.ts:346`). Should be "<job> — coding".
- Sheet cutting kept a small object the model drew touching the player as part of the player sprite (p25 chain, `player.png` has a coin-like orb beside it). A merge is only detected when a piece's body covers another subject's expected centre; a small neighbour drawn against a sprite does not. Consider a size check (a piece much wider than its siblings, or two lobes joined by a thin neck) and showing such a piece to the judge.

- Cancelling an image generation calls ComfyUI's `/interrupt` (`comfyui/client.ts`, `interrupt`), which stops whatever the server is running — another client's job on a shared ComfyUI included. Delete our own prompt from the queue (`POST /queue` with `delete`) and interrupt only when the running prompt is ours (`GET /queue` shows its id).

- **Image generation as a tool in Chat and the Shell assistant** (added 2026-10-03). When Settings → Image has a backend on, offer the model a tool that generates an image. In Chat: "draw me …", with the result shown inline. In the Shell assistant with code mode on: generate art into the working directory during an interactive coding session — a sprite, an icon, a texture — reusing the asset job's normalisation (transparency, cutting, tiling) rather than a raw image.

- **Email: review the integration, then add composing and sending** (added 2026-10-03). First a review pass on the existing IMAP integration — correctness, efficiency (connections, fetch sizes, caching), and error handling. Then, behind a Settings → Email toggle (off by default), let the model compose and send mail: replies to a message and new mail. Nothing is sent without the user reviewing it first — the model drafts, the user sees and can edit the draft, and only the user's click sends.

- **Sidecars outlive the app when it is killed** (found 2026-10-03; planned as `plan/misc_futures/` phase 13). The Qwen sd-server from a job ran on for ~6 h after the dev app restarted, holding 9 GB of VRAM (a game ran badly until it was killed by hand); koko was 2 days old against a 14-minute-old app. The Exit-handler stop only runs on a clean quit — a `tauri dev` rebuild, a crash or a SIGKILL skips it. Fix at spawn: on Linux `prctl(PR_SET_PDEATHSIG)` in `pre_exec`, on Windows a job object with kill-on-close, and on every platform a startup sweep that stops a stale sidecar still holding our port (match by binary path, never by name). Also leaking: Rust tests leave `mcp-echo-server.js hang` processes behind (15 found), and headless Chromium from dead app instances (4 found).

- **Move API keys to the OS keychain** (added 2026-10-03). Every secret — the stored API keys, the remote inference key, the Brave key, the image backend key — is plain text in the settings blob. `plan/misc_futures/` phase 10 builds a `secrets` store and moves email passwords onto it; move the rest onto the same store.

- **Owed: Windows and macOS pass for inline chat images.** All seven phases shipped
  2026-08-30 and were verified on Linux against both Qwen 3.6 35B and the default
  9B, but never off Linux. The specific risk is the custom URI scheme, which
  resolves differently on Windows and which no unit test covers. Plan:
  `plan/archive/inline-chat-images/`.

## Partially done

- Audit all job types to make sure where it makes sense we are using new contexts as the inference slows down the longer the context is. The verification phase of the guided planning is taking hours for a small 6 phase plan, compared to 20 minutes for the planning step. It might take days for a larger plan. We need to make sure that we are doing everything we can to speed up verification. We might even consider an option for a "verification lite" phase or skipping verification entirely as a checkbox option.
  - **The verification slowness is largely fixed** (PR #187). It was mostly not model
    slowness: `isPlanClean` matched `startsWith('PLAN OK')` against text that still
    contained the model's `<think>` block, so a reasoning model's clean verdict could
    never be recognised. Every run burned all three verify rounds and fired a revise
    turn each round against files that were already correct.
  - Measured on the same job, before → after: **verification 41 min → 12 min**, total
    **65 min → 42 min**, while producing a *larger* plan (89 KB → 158 KB).
  - **Skip verification is done** (`skip_verification` on guided planning; forced
    off in an unattended chain).
  - **Still open:** the context audit across other job types (research, audit,
    autonomous-coding) and a "verification lite" mode.
    Deliberately deferred so they could be scoped against real numbers rather than
    against the 41-minute figure, which turned out to be mostly a bug.

## Done

- ~~The model and context indicator shows the global model while a job runs on its own model.~~
  - **Done** (`plan/archive/job-observability/`, phase 02): job turns report usage
    through `onUsageUpdate`, and `ContextIndicator` follows the live run.

- ~~I've had a few issues where during a guided planning job one of the plan files that had been written in step 3 and then was going through verification in step 4 seeming got corrupted. When read the plan file in question started with step 9, and everything that presumably had existing in the file before step 9 was gone. No idea how this happened, whether it was a fault of the llm or something else entirely, but lets audit the job and tooling to make sure it wasn't because of some truncation or something that was caused by our code.~~
  - **Fixed in PR #187** — and yes, it was our code, in three independent places.
    1. A generation cut off by the 8192-token ceiling left truncated JSON in the tool
       call. The parser silently discarded it and fell through to regex salvage, which
       rebuilt a plausible-looking call out of a fragment — duplicate `<parameter=>`
       keys overwrote each other (lost the prefix) and the unclosed-tag match ran to
       end of string (lost the suffix).
    2. A second write to the same path in one turn silently replaced the first and
       still reported success, so a chunked write kept only the last chunk.
    3. Writes were a bare `fs::write` (truncate-then-write), so a failed write
       destroyed the previously-good file.
  - Plan and full rationale: `plan/archive/write-path-integrity/`.

## Notes

- **The outline modal is genuinely standalone and small.** Good filler work.
