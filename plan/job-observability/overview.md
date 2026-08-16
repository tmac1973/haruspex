# Job Observability and Per-Job Model Controls

## Problem

An overnight autonomous-coding run (Qwen 3.8 27B, reached through a per-job
llama-toolchest override) was slow, and there was no way to find out why from
inside the app. The run was doing a lot of reasoning; nothing in the UI showed
that reasoning, nothing showed how full the context was getting, and nothing
offered to turn reasoning down.

That is not a single missing feature. Reading the code turns up three
independent gaps that happen to compound, plus one latent correctness bug:

**1. The reasoning toggle never reached the model.** `resolveOverrideDescriptor`
(`src/lib/inference/descriptor.ts:266`) resolves a per-job override's quirks from
the model id alone, and `modelFamilyFromId` (`descriptor.ts:96`) matches only
substrings `qwen3.5`, `qwen-3.5`, `qwen3.6`, `qwen-3.6`, `qwen3.6-27b`. A
`qwen3.8-27b` id matches none of them, so `qwenTuning` is false and
`reasoningMode` is `{kind:'none'}` — meaning **no `enable_thinking` chat-template
kwarg was sent at all**, and the server's default (reasoning on) applied. Even
with a matching id it would not have helped: `EphemeralTurnOptions`
(`src/lib/agent/runEphemeralTurn.ts:24`) — the entry point every job type uses —
exposes no `thinkingEnabled`, so job turns silently inherit the global Settings
checkbox. `AgentLoopOptions` has supported the option since the shell tab needed
it (`loop.ts:207`, passed at `runShellTurn.ts:99`); jobs were simply never wired
to it.

**2. Reasoning is invisible while a step runs.** The raw stream already carries
it: `appendStreamDelta` wraps reasoning deltas in `<think>…</think>`
(`think-stream.ts:25`), the runner accumulates that into `step.streaming`, and
`markdown.ts:336` already renders closed think blocks as a `.thinking-block`
disclosure. But `JobRunView.svelte:143` only hands the buffer to `ChatMessage`
once `hasStreamingAnswer()` is true, and during pure reasoning the buffer is an
*unclosed* `<think>` that `stripThinkBlocks` (`markdown.ts:278`) erases. So the
one moment you most want to see the reasoning — while it is the only thing
happening — you get bouncing dots. After the step, `step.output` holds the
reasoning-stripped `finalText` and the thinking is gone entirely, even though
`runEphemeralTurn` already returns `rawText` for exactly this purpose
(`runEphemeralTurn.ts:82`).

**3. Context usage is never reported for jobs.** `onUsageUpdate` exists on the
loop (`loop.ts:123`, fired at `iteration.ts:547` and `:598`) and both chat and
shell feed it into the global context store. `runEphemeralTurn` does not expose
it, so no job turn ever reports token usage — and the top-right
`ContextIndicator` (mounted once in `+layout.svelte:416`) keeps showing the
*Settings* model's numbers while a job runs against a different model with a
different window. This is open item #1 in `plan/futures.md`.

**4. Latent: the client can silently override server-side sampling.** Sampling
survived this run by accident. An unrecognized family yields an empty profile,
so nothing was sent and the llama-toolchest server-side values won. Point a job
at a model id containing `qwen3.6` and the built-in profile *is* sent —
temperature, top_p, top_k, min_p, presence_penalty — overriding the server. The
fix is already half-built: `JobEditor.probeModel()`
(`JobEditor.svelte:262`) calls the same probe as Settings and receives
`reasoning: RemoteReasoningCaps` and `sampling: RemoteSamplingCaps` per model
(`inferenceProbe.ts:30-31`), then **discards both**, persisting only context size
and vision. `resolveOverrideDescriptor` therefore hard-codes
`discoveredSampling: null` (`descriptor.ts:289`), and the comment at
`descriptor.ts:71` records this as known ("null everywhere else — including
per-job overrides, which have no probe data").

Three smaller UX problems surfaced in the same session:

**5. The job editors are cluttered.** Every field carries both a `title`
tooltip *and* a two-to-three line `.hint` paragraph saying much the same thing —
nine hints in the autonomous-coding editor, seven in audit, four in JobEditor.

**6. Plan directory is free text.** A required path field typed by hand, with a
`<datalist>` of other jobs' output dirs as the only assistance — while
`JobEditor` already has a working system directory picker
(`JobEditor.svelte:193`, `@tauri-apps/plugin-dialog`).

**7. The phase-verification field doesn't say what it wants.** It takes a shell
command that the runner executes directly (`runCheckCommand`,
`pipeline.ts:1080`), but nothing in the control communicates that, so "a command
or a prompt?" is a fair question to ask of it.

## Goals

- A job can force reasoning on or off, independently of the global setting, and
  that choice reaches the model even when the override's model id is
  unrecognized.
- What the server was told about sampling is a visible, deliberate choice —
  with "send nothing, the server knows best" as a first-class option, not an
  accident of an unmatched model id.
- While a step runs, the reasoning is readable as it streams; after the step, it
  is still reachable for as long as the session lasts.
- "How much of that run was thinking?" has a number — per step and per run, in
  both wall clock and tokens — so the reasoning toggle can be judged on
  evidence instead of impression.
- Context usage during a run reflects the model the job is actually using, both
  per step and in the top-right indicator.
- The job editors lead with controls, not paragraphs, and every field's help is
  one consistent affordance away.
- Plan directory is picked, not typed. Phase verification offers real commands
  and is visibly a command field.

## Non-goals

- **Persisting reasoning traces to the run-history DB.** Session-only, by
  decision — an unattended overnight run's traces are large and the value decays
  fast. Revisit if reading yesterday's reasoning turns out to matter.
- **Per-phase / per-stage model selection.** That is open item #2 in
  `futures.md`, and the note there is right that it belongs with the shell-tab
  selector as one "model selection becomes per-context" project. This plan adds
  per-*job* controls only, in the shared editor section where the existing
  per-job model override already lives.
- **Reworking the built-in sampling profiles or the global Settings backend
  form.** Phase 1 changes who wins, not what the tuned values are.
- **Making the run faster directly.** Nothing here changes the loop's work.
  Turning reasoning off may well cut the wall clock substantially, but the
  deliverable is the control and the visibility to decide, not a speed claim.

## Shape

Three phases, shipped as three PRs, plumbing first. Phase 1 alone would have
fixed the run that prompted this, so it ships first and can be re-run against
while 2 and 3 are built.

| Phase | Theme | Touches |
|---|---|---|
| [01](phase-01-model-controls.md) | Per-job reasoning + sampling control, probe-cap persistence | Rust migration, descriptor, settings, runEphemeralTurn, runner, JobEditor |
| [02](phase-02-run-observability.md) | Reasoning disclosure, thinking-vs-answering stats, context usage | runEphemeralTurn, runner, JobRunView, ContextIndicator, markdown, think-stream |
| [03](phase-03-editor-ux.md) | Tooltip component, plan-dir picker, verification dropdown | New Tooltip, four editors, planParse reuse |

Phase 2 depends on Phase 1 only for the `onUsageUpdate` hook, which Phase 1
adds while it is already in `runEphemeralTurn`. Phase 3 is independent and could
land in any order.

## Decisions taken

Recorded here because each closed off a plausible alternative:

- **Sampling gets a three-way source control**, not just a discovery fix.
  Persisting the probed caps makes the behavior correct; the explicit
  `Server defaults / App-tuned profile / Custom` control makes it *legible*, so
  a future unmatched model id is a visible setting rather than a silent
  accident.
- **Reasoning is session-only.** See non-goals.
- **Context usage goes in both the step cards and the top-right indicator.**
  `futures.md` proposed these as alternatives; the step card is the durable
  per-step record and the indicator is where the eye already goes.
- **A real Tooltip component, with a few hints kept inline.** The guidance that
  is a *decision* rather than a description — "Not sure? Leave it blank." —
  stays visible, because that sentence is what makes the preflight interview
  work. Everything descriptive moves behind the ⓘ.
- **Thinking-vs-answering stats report exact time and estimated tokens.** The
  wall-clock split is exact and nearly free — the channel branch already exists
  in `appendStreamDelta`. The token split is a proportional estimate unless the
  server reports `reasoning_tokens`, so it is labeled as one. Reporting an
  estimate honestly beats either omitting the number or dressing it up as a
  count. Note the sequencing cost: phase 01 asks for before/after wall clock
  from a re-run, but phase 02 is what makes that measurement precise — phase
  01's numbers will be whole-run timings, refined later.
- **Verification suggestions are tiered: plan dir → working dir → catalog.**
  The guided-planning template already declares a `## Verification command`
  section per phase (`planParse.ts:33`) that the runner parses at run time, so
  the plan is both the highest-signal source and the one that works for a repo
  with no files in it yet. Where the plan is silent and the repo is empty, the
  plan's prose still names the stack, so the catalog is filtered by stack
  markers found in the plan text.

## Verification

Each phase carries its own checks. Across the whole plan:

- `npm run test`, `npm run check`, `npm run lint`, `npm run format:check`
- `cargo test`, `cargo clippy`, `cargo fmt -- --check` (Phase 1 only — it is the
  only phase touching Rust)
- One real autonomous-coding run against the same repo and plan as the run that
  prompted this, with reasoning forced off, comparing wall clock and watching
  the context bar. Before/after numbers go in the Phase 1 notes.
