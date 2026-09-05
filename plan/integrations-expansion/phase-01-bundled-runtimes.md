# Phase 01 — Bundle the runtimes: node + npm + uv

**Depends on:** nothing · **Enables:** Phases 02, 04 (nothing can install or launch an MCP server without these).

## Goal

Ship Node + npm and `uv` inside the app so a non-technical user never installs
anything to use an MCP server. This is long-lead work — per-platform binaries,
bundle configuration and CI — and gates everything else in track A, so it starts
first. It can also run in parallel with the independent track B phases.

`uv` provisions its own CPython on demand, so Python is **not** bundled
separately.

## Files touched

- **NEW** `NODE_VERSION`, `UV_VERSION` — pinned versions at the repo root,
  matching the existing `RUFF_VERSION` / `LLAMA_CPP_VERSION` convention.
- **NEW** `scripts/fetch-node.sh`, `scripts/fetch-uv.sh` — modelled directly on
  `scripts/fetch-ruff.sh`.
- **NEW** `src-tauri/src/runtimes.rs` — resolves bundled runtime paths in both
  dev and packaged layouts.
- **EDIT** `src-tauri/tauri.conf.json` — `bundle.externalBin` gains
  `binaries/node` and `binaries/uv`; `bundle.resources` gains the npm tree.
- **EDIT** `scripts/dev-setup.sh` — call both fetch scripts alongside
  `fetch-ruff.sh` / `fetch-pdfium.sh`.
- **EDIT** `scripts/link-sidecar-libs.sh` — symlink the new binaries into
  `target/debug/` for dev mode.
- **EDIT** `.github/workflows/build-sidecars.yml` — fetch on every target.
- **EDIT** `.gitignore` — the new binaries and the npm tree.
- **EDIT** `src-tauri/src/lib.rs` — `mod runtimes;`.
- **EDIT** `NOTICE.md` — Node (MIT) and uv (MIT/Apache-2.0) attribution.

## Implementation

### Fetching

`fetch-uv.sh` is nearly a copy of `fetch-ruff.sh` — same vendor (astral-sh), same
release-asset layout, single static binary, per-triple asset name. Keep the same
structure: idempotent, `--target` flag, skip-with-warning on an unknown triple.

`fetch-node.sh` differs in one important way: **Node is not a single file.** The
official distribution is an archive containing `bin/node` *and* the npm CLI as a
JavaScript tree under `lib/node_modules/npm`. The binary alone cannot run npm.
So the script:

1. Downloads the official archive for the triple
   (`node-vX-linux-x64.tar.xz`, `node-vX-darwin-arm64.tar.gz`,
   `node-vX-win-x64.zip`).
2. Verifies it against `SHASUMS256.txt` from the same release directory —
   the checksum is published, so verify it rather than trusting the transfer.
3. Copies `bin/node` to `src-tauri/binaries/node-<triple>` (`.exe` on Windows,
   as `fetch-ruff.sh` already handles).
4. Copies `lib/node_modules/npm` to `src-tauri/binaries/node-modules/npm`,
   which ships via `bundle.resources` — the same mechanism `espeak-ng-data`
   already uses.

### Resolving at runtime (`runtimes.rs`)

Two layouts to handle, exactly as the sidecars already do:

- **Dev** — binaries symlinked into `target/debug/` by `link-sidecar-libs.sh`.
- **Packaged** — Tauri's resolved sidecar path plus the resource directory.

Expose:

```rust
pub fn node_path(app: &AppHandle) -> Result<PathBuf, String>;
pub fn npm_cli_path(app: &AppHandle) -> Result<PathBuf, String>;  // …/npm/bin/npm-cli.js
pub fn uv_path(app: &AppHandle) -> Result<PathBuf, String>;
pub fn npm_command(app: &AppHandle) -> Result<Command, String>;   // node <npm-cli.js>
```

`npm_command` matters: npm is invoked as `node <npm-cli.js> …`, never as a
platform shim, so nothing depends on a `PATH` we do not control. Every spawned
runtime gets an explicit environment — do not inherit an ambient `NODE_PATH`,
`NPM_CONFIG_PREFIX` or `UV_*` from the user's shell, which is exactly how a
"works on my machine" bug reaches a non-technical user's install.

A `runtimes_available()` health check returns which runtimes resolved, so
Phase 06's UI can explain a broken install instead of failing at spawn time.

### Bundle size

Node adds roughly 100–150 MB per platform and `uv` roughly 35 MB, before
compression. That is deliberate and is the price of the zero-install
requirement. Record the measured numbers in the commit message so the tradeoff is
visible in history.

## Build gate

```bash
./scripts/dev-setup.sh --skip-models     # must fetch both runtimes cleanly
npm run check && npm run lint && npm run test
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## Test plan

- **Unit (Rust)** — path resolution for both layouts against a temp dir.
- **Script** — run each fetch script twice; the second run must no-op. Run with an
  unknown `--target`; must warn and exit 0, not fail the build.
- **Manual, per platform:**
  - `<binaries>/node-<triple> --version` prints the pinned version.
  - `node <npm-cli.js> --version` prints npm's version.
  - `<binaries>/uv-<triple> --version` prints the pinned version.
  - Build a packaged app and confirm all three resolve from inside the bundle.
  - macOS: confirm the bundled binaries survive codesigning and the app still
    launches them (externalBin entries are signed; the npm JS tree is a resource
    and is not a Mach-O object).

## Commit

`feat(runtimes): bundle node, npm and uv for MCP servers`

## Rollback

Revert. Nothing consumes `runtimes.rs` until Phase 02, so a revert is inert
beyond bundle size.
