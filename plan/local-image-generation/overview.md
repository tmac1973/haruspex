# Image Generation Backend and Asset Job — Project Overview

## Problem

Haruspex can plan a game and build it unattended, but it cannot make the art. A
user with no art skills who runs the planning → coding chain wakes up to a
working project and no graphics, and their options are to learn pixel art, buy
an asset pack, or stand up a diffusion stack themselves and drive it by hand.
The dark_times run makes the gap concrete: the coding job wrote a 2,000-line
procedural `asset-gen` binary that draws every sprite from rectangles and lines,
because that was the only way to get art out of an LLM-only tool. It works, and
at 32×32 it is even competitive — but it cannot make an item icon, a portrait, a
title screen, or a terrain texture that looks like anything but rectangles.

The reason nobody just bolts a diffusion model on is that generation is the easy
half. Any model will produce a nice sprite from a prompt; no model will produce
forty sprites that look like they came from the same game. A tool that generates
assets one prompt at a time hands the user an incoherent pile and leaves the
actual problem — uniformity across a whole asset set — exactly where it was.
That is the problem this work solves, and it is a pipeline problem rather than a
model problem.

## Goals

- Add an **image backend** to Haruspex — a configured image-generation service,
  the way the LLM backend already is — with a stable interface that both a
  remote endpoint and a locally managed engine can implement.
- Ship a **ComfyUI HTTP backend** first, targeting either a remote server or a
  ComfyUI the user runs themselves on localhost.
- Ship a **local, Haruspex-managed engine** behind the same interface, optional
  and opt-in: not started by default, weights downloaded only when the user
  chooses it.
- Add an **asset-generation job type** that consumes a spec of required assets
  and produces normalized, style-coherent image files on disk.
- Keep the backend **usable by consumers that do not exist yet** — an image tab,
  a chat turn that shows a generated image inline, another job type. Those are
  out of scope here, but adding one later must be additive work on top of this
  layer, never a refactor of it.
- Make style coherence a **property of the pipeline**, not of the prompt, via
  three independent layers: an approved style anchor, reference-conditioned
  generation, and mechanical normalization.
- Make the style **reproducible months later** by committing the anchor and its
  full recipe into the project alongside the assets it produced.
- Keep the job **chainable**: guided planning can emit the asset spec, and the
  job can run in the unattended chain without ever asking a question.
- **Check every generated artifact** before accepting it, and record what could
  not be made rather than silently shipping a blank PNG.
- Default to **commercially safe model weights**, so a user who later sells
  their game is protected by the default rather than by having read a licence.

## Non-goals

- **Training.** No LoRA or fine-tune training inside Haruspex. A user-supplied
  LoRA can be referenced, but Haruspex never trains one. Training is the
  strongest answer to uniformity and also means owning kohya/ai-toolkit, a
  training UI and hours of GPU time; it is deliberately left for later.
- **Autotile set generation.** Haruspex stops at seamless textures. It will not
  emit 47-tile blob sets, Wang sets, or any engine-specific tilemap layout.
- **3D-to-sprite.** No mesh generation, no orthographic rendering pipeline.
- **Animation.** Single frames only. No sprite sheets with motion, no rigging.
- **Runtime generation.** Assets are produced at development time and written to
  disk. Nothing in a user's shipped game calls an image model.
- **An in-app image editor.** Haruspex generates and normalizes; touch-up is
  Aseprite's job.
- **An image tab, and inline images in chat.** Both are wanted and both are
  deferred to a later plan. They are a non-goal for the work, *not* for the
  design: the backend must already be able to serve them, and the constraint
  below says what that means concretely. If building either one later requires
  changing this layer, this plan failed.
- **A general `generate_image` agent tool.** Same footing — deferred, not
  designed out. The backend must expose a single-image call that needs no spec,
  no anchor and no job.
- **Bundling ComfyUI itself.** Haruspex talks to a ComfyUI over HTTP; it never
  installs, supervises, or ships one, and never owns a torch install.
- **Replacing procedural generation.** Where a project has a deterministic
  painter, that remains a legitimate and often better choice at small sizes.

## Users & primary flow

**Who:** someone building a 2D game or graphical project who has no art skills,
already uses Haruspex's planning and coding jobs, and wants a coherent asset set
without standing up and hand-driving a diffusion stack.

**Standalone flow (the first-use path):**

1. The user opens Settings → Image and picks a backend. They point it at a
   ComfyUI endpoint, or choose the local engine and let Haruspex download the
   weights.
2. They create an asset-generation job, give it a working directory and a prompt
   describing the game and the look they want.
3. The job's first stage writes an **asset spec** — every asset it intends to
   make, with its id, kind, prompt and output path — and reports what it
   contains. It does not stop here.
4. The job generates a **style anchor**: a small reference sheet in the target
   style. It presents the anchor *and* a summary of the spec together, and the
   user approves both, asks for a different anchor, or stops to edit the spec
   file by hand. This is the only checkpoint, and it covers both questions —
   what is about to be made, and what it will look like.
5. The anchor image and the exact recipe that produced it — seed, prompt, model,
   LoRA, sampler settings, palette — are written into the project.
6. The job walks the spec. Each entry is generated conditioned on the anchor,
   then normalized: palette quantized to the anchor's palette, downscaled by an
   integer factor to the target grid, background removed, outline weight
   normalized. Each result is checked; failures retry within a budget.
7. The job writes a report: what was made, what failed and why, and where the
   files are. The user opens the output directory and has a coherent asset set.

**Chained flow (the overnight path):**

1. A guided-planning run produces a plan that includes an asset spec.
2. It starts the asset job with the chained trigger. The anchor checkpoint is
   auto-accepted, so nothing asks.
3. The asset job finishes and starts the coding job, which builds against assets
   that already exist on disk.
4. The user wakes up to a project with code and art.

**Re-run flow (the one that proves the design):**

1. Months later the user adds ten entries to the spec and re-runs the job.
2. The committed anchor is reused rather than regenerated, so the ten new assets
   match the hundred already shipped.

## Constraints

- **Stack:** Tauri 2.x + SvelteKit 5 (runes) + Rust. Sidecars are long-running
  HTTP servers on localhost; the existing three are `llama-server` (8765),
  `whisper-server` (8766) and `koko` (3001).
- **Existing plumbing to reuse, not reinvent:** `ModelManager` in
  `src-tauri/src/models.rs` already owns a model catalogue, download with
  progress, cancel, import and delete, and already serves a second model family
  through `download_whisper_model`. `sidecar_utils.rs` owns process spawning.
  `TtsEngine` in `tts.rs` is the precedent for a sidecar that starts on demand
  rather than at boot — `tts_initialize` is a command, not boot code.
  `hardware.rs` reports VRAM. `src-tauri/src/image_cache/` already stores images
  content-addressed and serves them to the webview over the `haruspex-img://`
  scheme (`protocol.rs`), with licence tracking and a sweep — that is where a
  generated image goes to be displayed. `JobRunContext.visionSupported()`
  already reports whether the job's model accepts images. The job-type registry,
  the FIFO runner, the `RunTrigger` values, `startChainedRun` and the `chained`
  muteness contract are all in place.
- **Optional by construction.** No new process may start at boot and no weights
  may be downloaded unless the user opts in. A user who never touches this
  feature must see no new processes, no new disk usage, and no startup cost.
- **Availability gate.** The job type must follow the existing `available()`
  pattern so it is only offered when an image backend is configured, and the
  local-engine option must be offered only where its sidecar is bundled.
- **Drift guards.** Any change to a Tauri command or a `#[ts(export)]` struct
  requires `./scripts/export-ipc-types.sh` or CI fails.
- **CI stubs.** `tauri-build` validates every `externalBin` path at compile
  time, so a new sidecar needs a CI stub like the six existing entries.
- **The backend layer must not know the asset job exists.** This is the
  constraint that keeps a later image tab or chat integration additive, and it
  is enforceable rather than aspirational:
  - the backend layer is `src/lib/image/` and it imports nothing from
    `src/lib/agent/jobs/`, asserted by a test;
  - its vocabulary is *request → images + metadata*. The words "spec",
    "anchor", "entry" and "asset" never appear as identifiers in it, asserted by
    a second test that scans the module's source (identifiers, not prose —
    a comment may still explain what the module deliberately does not know). Everything asset-shaped — the spec,
    the anchor types, the normalization wrapper — lives in `src/lib/assets/`
    instead, which may depend on `src/lib/image/` but never the reverse;
  - a **single-image call is a first-class operation**, not a degenerate spec
    run of one — that call is exactly what a chat turn or an image tab would
    use;
  - progress streaming and cancellation are part of the backend interface, so a
    future UI gets a progress bar and a stop button without new plumbing;
  - backend configuration lives in **Settings → Image**, not in the job's
    `type_config`, so every consumer reads one configured backend;
  - style anchoring, normalization and the quality gate live **above** the
    backend, in the job — a chat turn asking for a picture of a cat must not be
    palette-quantized to somebody's tileset.
- **The runner is single-slot FIFO.** An asset job occupies the same queue as
  planning and coding runs; it cannot run concurrently with them.
- **Generation is slow.** An asset set is tens to hundreds of images at seconds
  to a minute each. The job must stream progress, be cancellable, and survive a
  backend that disappears mid-run.
- **Licensing bounds the defaults.** Recommended weights must be permissively
  licensed (Apache 2.0 / OpenRAIL-M class). The bundled workflow templates are
  authored for this repository and carry its licence, recorded in the template
  registry (a ComfyUI API graph must parse as strict JSON, which has no
  comments) and asserted by a test.
- **Models do not obey colour or composition instructions.** Measured on
  SD1.5: asking for "a flat magenta background" yields whatever backdrop the
  model prefers, and asking for an isolated centred object yields a full-frame
  composition. Both are preconditions of background removal, so neither may be
  left to the prompt alone — the prompt asks, and the pipeline verifies and
  falls back. This is the same reasoning as the rest of the design, arrived at
  the hard way rather than by argument.
- **Generation is slow enough to be interrupted.** A backend can vanish
  mid-run. The job must treat that as a per-entry failure that the remaining
  entries retry through, not as a crash.

## Success criteria

- A user with a ComfyUI endpoint can configure it in Settings → Image, run the
  job from a one-line prompt, and get a directory of normalized PNGs — without
  authoring a ComfyUI workflow and without writing a spec by hand. Editing the
  generated spec is offered, not required, and is done in a text editor; this
  plan ships no spec editor.
- A user with no ComfyUI can opt into the local engine, and the same job
  produces the same shape of output. Nothing about the local engine runs or
  downloads until they opt in.
- Every asset in a generated set shares one palette and one pixel grid, and the
  contact sheet the run assembles from its own output reads as belonging to one
  game.
- Deleting ten output files and re-running regenerates exactly those ten, in a
  style indistinguishable from the ones that were kept, because the anchor was
  reused rather than rebuilt.
- A run started from the chain asks nothing, from first stage to last.
- A blank, uniform, or off-palette generation is caught by the quality gate and
  retried; if it still fails, the run finishes and the report names the asset
  and the reason. No unchecked artifact is ever written as if it succeeded.
- The asset spec, the anchor image and the anchor recipe are all committed
  files, so the art is reproducible from a fresh clone on another machine.
- A single image can be generated through the backend with one call, given only
  a prompt and the configured backend — no spec, no anchor, no job, no job
  runner. This is the observable proof that a later image tab or chat
  integration is additive, and it is exercised by a test that touches nothing
  under `src/lib/agent/jobs/`.
- `npm run check`, `npm run lint`, `npm run format:check`, `npm run test`,
  `cargo test`, `cargo clippy` and `cargo fmt --check` all pass, and
  `./scripts/export-ipc-types.sh` reports no drift.

## Decisions

- **Capability shape** → An image backend abstraction mirroring the LLM one,
  with the asset-generation job built on top of it. A job-only design has
  nowhere for local engine management to live.
- **Backend order** → ComfyUI over HTTP first, with the locally managed engine
  in later phases behind the same interface. ControlNet, LoRAs, IP-Adapter and
  seamless-tiling nodes only exist in that ecosystem, so the hard part — style
  consistency — is proven before anything is bundled.
- **Consistency strategy** → Style anchor, plus reference-conditioned
  generation, plus mechanical normalization. Three independent layers, so that
  if conditioning drifts the mechanical pass still homogenises the result.
- **Terrain tiling** → Stop at seamless textures; the consuming game does its
  own bitmask autotiling. Transitions come from code, which is always correct,
  rather than from asking a model to draw 47 mutually consistent corners.
- **Job input** → A machine-readable asset spec is the contract. A prompt-only
  run derives the spec in its first stage and presents it; a chained run
  receives one from guided planning. Same contract both ways.
- **Checkpoints** → The style anchor is the only human checkpoint, with a
  run-mode setting that auto-accepts it so the job is fully chainable.
- **Anchor persistence** → The approved anchor image and its full recipe are
  committed project artifacts, reused by every later run, so style is versioned
  and reproducible rather than dependent on model weights never changing.
- **Model licensing** → Commercially safe weights by default, with non-permissive
  weights usable only on explicit opt-in and an unmissable warning.
- **Future consumers** → An image tab and inline chat images stay out of scope,
  but the backend is designed to serve them: no dependency on the jobs layer, a
  first-class single-image call, streaming progress and cancellation in the
  interface, configuration in Settings rather than job config, and all
  asset-specific behaviour kept above the backend. Adding either later must be
  additive.
- **Quality gate** → Mechanical acceptance checks (alpha coverage, entropy,
  palette distance from the anchor) with bounded retries, plus an optional
  vision-model judge scoring the image against the anchor. Unresolved failures
  are reported, never silently accepted.

### Implementation decisions

- **Workflow expression** → Bundled API-format workflow templates plus a field
  map saying which node input carries each parameter. The same map mechanism
  lets a power user point at their own exported workflow, so custom workflows
  fall out of the bundled ones rather than being separate work.
- **Backend return value** → Encoded bytes plus generation metadata. The
  backend writes no files; the caller decides where pixels go. This is what
  makes the single-image call usable by a consumer with no project directory.
- **Normalization** → Rust, using the existing `image = "0.25"` dependency.
  Background removal is a deterministic chroma key against a flat background
  requested in the prompt, not a segmentation model — unit-testable with
  fixture PNGs, and nothing extra to ship.
- **Spec format** → JSON at a conventional path inside the project, holding the
  entry list, the anchor recipe path and the normalization settings.
- **Local engine** → `stable-diffusion.cpp` as a sidecar. Backends declare
  their capabilities (reference conditioning, seamless tiling, LoRA slots) and
  the job degrades per entry and reports which coherence layer it did without.
  This is the reason the design has three independent layers. ControlNet is not
  a declared capability: no phase ships a ControlNet workflow, and a capability
  nothing reads is a lie waiting to be believed.
- **Chain position** → Planning → assets → coding, so the coding run builds
  against art that already exists. The plan is the single source of asset ids;
  the chain writes them into the plan and hands the coding run the spec path so
  its preflight can check them.
- **Anchor form** → One contact sheet containing several representative
  subjects, generated as a single coherent image. The shared palette is
  extracted from it, and it is the reference every entry is conditioned on.
