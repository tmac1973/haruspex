# Phase 12 — Local engine: fetch, bundle and gate the stable-diffusion.cpp binary

**Depends on:** nothing in this plan's code — it touches build tooling only, and
is placed here because the ComfyUI path had to be proven first. · **Enables:**
13, which supervises and drives what this phase makes available.

## Goal

Get a `sd-server` binary into the build the same way the other six sidecars get
there, without starting it and without downloading any weights. After this phase
a developer who runs `./scripts/dev-setup.sh` has the binary, CI still builds
with stubs, and a packaged app contains it — and a user who never opts in sees
no change at all.

## Files touched

- `scripts/fetch-sdcpp.sh` — new. Build `stable-diffusion.cpp` from a pinned
  tag with the Vulkan backend for the host triple.
- `scripts/sdcpp-capabilities.sh` — new. Emit the capability fixture phase 13
  declares from.
- `scripts/dev-setup.sh` — call it, behind the existing `--skip-build` flag,
  and add it to the sidecar table.
- `scripts/link-sidecar-libs.sh` — include its `.so` files.
- `src-tauri/tauri.conf.json` — add `binaries/sd-server` to `externalBin`.
- `.github/workflows/*` — create the `sd-server` stub alongside the existing
  six, since `tauri-build` validates every `externalBin` path at compile time.
- `CLAUDE.md` — add the binary to the sidecar table and the port to the
  localhost table.
- `docs/image-generation.md` — **created here**, as a short page recording the
  pinned `SDCPP_VERSION` and how to rebuild. Phase 15 expands it into the full
  guide; a phase cannot write into a file three phases downstream.
- `src/lib/image/local/capabilities.json` — the emitted fixture, committed.
- `.gitignore` — the binary, alongside the others.

## Steps

1. Write `fetch-sdcpp.sh` following the llama.cpp build path in
   `dev-setup.sh`: **build from source**, not download. Upstream publishes no
   Vulkan server binary for every host triple, and the other GPU sidecars are
   already built locally, so building keeps one story. Clone at the pinned tag,
   configure with the Vulkan backend, build, place the result at
   `src-tauri/binaries/sd-server-{triple}`, `chmod +x`, and no-op when the
   binary is already present and executable.
2. Pin an exact upstream git tag in `SDCPP_VERSION` at the top of the script.
   The value is the newest upstream release at implementation time, and the
   implementer records the tag they chose in the script and in
   `docs/image-generation.md`, which this phase creates. The choice is bounded
   rather than open: the tag must be one whose build passes step 3's capability
   script and serves a generation route, since a build that cannot generate
   makes phase 13 impossible. The build gate fails when `SDCPP_VERSION` is empty
   or the two records disagree. An unpinned sidecar is a reproducibility hole,
   and the existing fetch scripts pin.
3. Write `scripts/sdcpp-capabilities.sh`: run the built binary's `--help` and a
   one-shot generation, and emit a JSON fixture recording which features the
   pinned build actually has (reference conditioning, seamless tiling, LoRA
   slots) and which HTTP routes it serves. It writes to
   `src/lib/image/local/capabilities.json`, which is committed — phase 13
   declares its capabilities from that exact path rather than asserting them,
   so a version bump that changes support fails a test instead of drifting
   silently.
4. Build with the Vulkan backend, matching `llama-server` and `whisper-server`
   so one GPU story covers every sidecar.
5. Reserve **port 8767** — the next free number after whisper's 8766 — and add
   it to the CLAUDE.md localhost table now, so nothing else claims it.
6. Add the CI stub. Verify by running the CI build locally with the binary
   absent: the Rust build must succeed on a stub, exactly as it does for the
   other six.
7. Update the sidecar table in CLAUDE.md with source, GPU and purpose, keeping
   the existing format.
8. Do **not** register a sidecar in `lib.rs`, do not start anything, and do not
   add any settings. This phase ends with a binary on disk that nothing runs.

## Build gate

```
./scripts/dev-setup.sh --skip-models      # produces src-tauri/binaries/sd-server-<triple>
cd src-tauri && cargo build && cargo fmt -- --check && cargo clippy --all-targets
cd .. && npm run test
```

Plus one explicit check: with `src-tauri/binaries/sd-server-*` deleted and the
CI stub in place, `cargo build` still succeeds.

## Test plan

- Running `fetch-sdcpp.sh` twice is a no-op the second time.
- `sdcpp-capabilities.sh` emits a fixture, and running it twice on the same
  build emits identical JSON.
- The produced binary answers `--help` with a zero exit code.
- `cargo build` succeeds with the real binary present.
- `cargo build` succeeds with only the CI stub present — the case that actually
  breaks CI if `externalBin` is added without a stub.
- No new process appears in the process list after `npm run tauri dev`, because
  nothing starts it. This is the phase's real assertion.
- `npm run test` is unchanged; no frontend code was touched.

## Commit

```
build(sidecar): fetch and bundle the stable-diffusion.cpp server binary
```

## Rollback

Remove the `externalBin` entry, the CI stub, the fetch script and its dev-setup
call, and revert the CLAUDE.md tables. Nothing depends on it yet, so removal is
total. A developer with the binary already on disk can delete it or leave it —
it is gitignored and unreferenced either way.
