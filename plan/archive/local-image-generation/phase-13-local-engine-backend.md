# Phase 13 — Local engine: supervision, backend implementation, capabilities

**Depends on:** 01 (the interface), 03 (Settings has a backend picker), 12 (the
binary exists) · **Enables:** 14, which gives it weights to load.

## Goal

Start the local engine on demand, talk to it through the same `ImageBackend`
interface ComfyUI implements, and declare honestly what it cannot do. After this
phase a user with a model file on disk can select the local backend in Settings,
probe it, and use Test generation — and the asset job works against it, degrading
per entry where the engine lacks a capability.

## Files touched

- `src-tauri/src/image_engine.rs` — new. `ImageEngine` state: spawn, readiness
  poll, stop, log buffer. Modelled on `TtsEngine` in `tts.rs`, which is the
  precedent for a sidecar that starts on demand rather than at boot.
- `src/lib/image/local/capabilities.json` — the fixture from phase 12.
- `src-tauri/src/lib.rs` — `.manage(ImageEngine::new())` and the commands
  `image_engine_start`, `image_engine_stop`, `image_engine_status`,
  `image_engine_logs`.
- `src/lib/image/local/backend.ts` — new. The `ImageBackend` implementation.
- `src/lib/image/local/adapter.ts` — new. Maps step 4's contract onto the
  routes the phase-12 fixture recorded.
- `src/lib/image/index.ts` — register it.
- No settings change: `ImageBackendKind` already includes `'local'`, and both
  `imageLocalModelPath` and `imageLocalModelId` were added in phase 01.
- `src/lib/components/settings/ImageSection.svelte` — the Local option, a
  start/stop control, status and a log view.
- Tests for each.

## Steps

1. `ImageEngine::start(app)`: refuse if no model is configured, spawn the
   sidecar on port 8767 with the selected weights, capture stdout/stderr into a
   **500-line** ring buffer, and poll `GET /health` every **500 ms** for at most
   **120 s**. Return a typed error naming the cause, never a bare string. This
   phase reads `imageLocalModelPath` only: an id has no meaning until phase 14
   builds the catalogue that resolves one, and that phase adds the resolution
   with the precedence phase 01 fixed.
2. **Nothing starts at boot.** `image_engine_start` is a command, called from
   Settings or lazily by the backend's first `generate()`. A user who never
   selects the local backend has no extra process and no startup cost — the
   overview makes this a hard constraint.
3. `stop()` terminates the child and clears readiness. Stopping is also wired to
   the backend kind changing away from `local`, so switching to ComfyUI does not
   leave a GPU-resident process behind.
4. The TS backend mirrors the ComfyUI one in shape, against this HTTP contract
   — stated here because phase 02 enumerates every ComfyUI route and this one
   deserves the same:
   - `GET /health` → `200` once weights are loaded;
   - `POST /txt2img` and `POST /img2img`, body `{ prompt, negative_prompt,
     seed, width, height, steps, cfg_scale, sampler, seamless, init_image
     (base64, img2img only), strength, loras: [{name, strength}] }`, response
     `{ images: [base64], seed, sampler }`;
   - the same 120 s / 600 s timeouts phase 02 uses.
   The pinned build is what it is, so `adapter.ts` sits between: it maps this
   contract onto whatever routes the phase-12 fixture recorded. A missing
   optional route (img2img, say) becomes a missing capability phase 09 degrades
   around; a missing generation route entirely is not survivable, which is why
   phase 12 constrains its pin to a build that has one. `probe()` reports whether the engine is running and which
   model is loaded; `generate()` starts the engine if needed, POSTs, and
   returns bytes and metadata.
5. `capabilities()` is the honest declaration phase 09 consumes, and it is
   **read from the fixture `scripts/sdcpp-capabilities.sh` emitted for the
   pinned build** — not asserted by hand. Whatever that build genuinely
   supports is what the backend reports, and the expectation going in is that
   `referenceConditioning` is false, which is exactly why the design has three
   independent coherence layers. Reporting a capability the engine lacks would
   be worse than lacking it: the job would stop degrading and start silently
   producing off-style art.
6. A test compares the declared capabilities against the committed fixture, so
   a version bump that changes support fails a test rather than drifting
   quietly. Regenerating the fixture is a deliberate act with a diff.
7. Settings UI: Local appears as a third option — **only where the sidecar is
   bundled for the host platform**, which is the availability gate the overview
   asks for and the one thing phase 06's backend check cannot cover — with a
   model-path picker, a Start/Stop button, a status line and a collapsible log
   view, the same affordances the TTS section already gives koko.
8. Run `./scripts/export-ipc-types.sh` for the four new commands.

## Build gate

```
cd src-tauri && cargo test --lib && cargo clippy --all-targets && cargo fmt -- --check
cd .. && npm run check && npm run lint && npm run format:check && npm run test
./scripts/export-ipc-types.sh   # must report no drift
```

## Test plan

- Rust: `start` with no model path configured returns a named error and spawns
  nothing; `start` twice is idempotent; `stop` on a stopped engine is a no-op;
  the log buffer holds exactly 500 lines and drops the oldest beyond that;
  readiness polling gives up after 120 s with a timeout error rather than
  hanging.
- The adapter maps the documented contract onto the fixture's recorded routes,
  and a route the fixture says is absent surfaces as a missing capability.
- The Local option is hidden on a platform with no bundled sidecar.
- **Boot test:** with `imageBackendKind` set to `'local'` and a model path
  configured, launching the app starts no image process until something asks.
  This is the constraint's test and it must fail if a `.manage` becomes a spawn.
- Backend: `generate()` starts the engine if stopped; `probe()` reports not-ready
  before start and ready after; abort cancels the request.
- Capabilities: the declared object matches
  `src/lib/image/local/capabilities.json` byte for byte; editing the fixture
  without rebuilding fails the test. The degradation test below reads
  `referenceConditioning` from the fixture rather than hardcoding false, so it
  has a subject whichever way the pinned build answers.
- Degradation end-to-end: an asset run against the local backend with
  `referenceConditioning: false` produces assets, records every entry as
  degraded with that reason, and the report names it. The set is still palette-
  and grid-coherent, which is the claim the three-layer design makes and the
  place to prove it.
- Switching the backend kind away from `local` stops the engine.

## Commit

```
feat(image): add the local stable-diffusion.cpp backend, started on demand
```

## Rollback

Drop the registration in `src/lib/image/index.ts` and the `'local'` option from
the settings type; leave `image_engine.rs` in place or remove it with its four
commands and re-run `./scripts/export-ipc-types.sh`. An install configured for
`local` falls back to the `none` backend, which reports cleanly rather than
throwing. The bundled binary from phase 12 is then unreferenced but harmless.
