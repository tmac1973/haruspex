# AGENTS.md

Compact agent guide for Haruspex (Tauri 2 + SvelteKit 5 + llama.cpp sidecar).
See `CLAUDE.md` for the tech-stack overview and `maintenance.md` for the
detailed maintainer guide (sidecar pattern, agent loop, tool system,
fs_tools, proxy, settings UI, jobs, shell tab). `audits/` holds
architecture/complexity audits with findings referenced below.

## Canonical commands

- `make dev` — full dev entrypoint. Runs all `ensure-*` targets (sidecars,
  pdfium, ruff, pyodide, node_modules, lib symlinks) then
  `GDK_BACKEND=x11 npm run tauri dev`. Prefer this over raw
  `npm run tauri dev`, which assumes sidecars + libs are already in place.
- `make check` — the one-command pre-PR gate. Runs, in order: `npm run lint`,
  `npm run format:check`, `npm run check`, `npm run test`,
  `cargo fmt --check` (manifest `src-tauri/Cargo.toml`),
  `cargo clippy -- -D warnings`, `cargo test`. CI runs the same chain.
- `make fmt` — auto-format both JS/TS (Prettier) and Rust (cargo fmt).
- Single test: `npx vitest run src/lib/path/to/file.test.ts` (or
  `npm run test -- <path>`). Tests are co-located: `foo.ts` → `foo.test.ts`.
- `make reset-data` — wipes app data at `~/.local/share/com.haruspex.app`.

## IPC contract (do not hand-edit generated files)

The TS↔Rust boundary is generated and CI-enforced. After changing any
`#[tauri::command]` in `generate_handler![...]` (`src-tauri/src/lib.rs`) or
any `#[ts(export)]` struct:

1. Run `scripts/export-ipc-types.sh`. This regenerates both
   `src/lib/ipc/commands.ts` (command-name constants, from `generate_handler!`)
   and `src/lib/ipc/gen/*.ts` (ts-rs struct types, into the committed dir).
2. Commit the regenerated files. CI fails on drift (audit findings X2/X3).

Do not hand-edit `src/lib/ipc/gen/` or `src/lib/ipc/commands.ts`. ESLint
ignores `src/lib/ipc/gen/`. Dynamic `invoke()` call sites must take command
names from the `IPC` constant in `commands.ts` (correct by construction);
literal `invoke('name')` calls are scanned by `node scripts/check-ipc.mjs`
and fail CI if the name isn't registered in Rust.

## Architecture guards

- **No chat-store imports from sandbox/agent-tools.** `src/lib/sandbox/` and
  `src/lib/agent/tools/` must NOT import `stores/chat.svelte`. CI has a grep
  guard (audit findings A1/A6). Read ambient session id / workdir from
  `stores/session.svelte` instead. (`madge` can't see `$lib` aliases, so the
  grep guard is the real check.)
- Rust `cargo clippy` runs with `-D warnings` — warnings are errors in CI
  and `make check`.
- `audits/architecture-2026-06-09.md` documents the layering: frontend
  `routes/ → components/ → stores/ → agent/,sandbox/ → api.ts`; backend
  `db/commands.rs` (thin) → `db/{conversations,jobs,runs,stats}.rs` →
  `rusqlite`. Sidecars are co-located localhost HTTP services, not
  microservices.

## Sidecars & vendored runtimes (all gitignored)

Sidecar binaries in `src-tauri/binaries/` are gitignored and built/fetched
separately. Localhost ports: llama-server `8765`, whisper-server `8766`,
koko `3001`.

- `./scripts/build-sidecars.sh --target <triple>` (or `make sidecars`) —
  builds llama-server, whisper-server, koko. `make ensure-sidecars` only
  rebuilds when the binary is missing or the pinned version file
  (`LLAMA_CPP_VERSION` / `WHISPER_CPP_VERSION`) changed.
- `make ensure-pdfium`, `make ensure-ruff`, `make ensure-pyodide` — fetch
  PDFium, the ruff linter sidecar, and the Pyodide runtime + wheels into
  `static/pyodide/` (vite copies `static/` verbatim, so without this the
  shipped app has no local Pyodide and falls back to CDN at runtime).
- `./scripts/link-sidecar-libs.sh` (or `make ensure-libs-linked`) — symlinks
  sidecar shared libs into `src-tauri/target/debug/` so dev mode finds them.
- First-time setup: `./scripts/dev-setup.sh` (builds sidecars + downloads
  models). `--skip-models` / `--skip-build` to redo only one half.

## Style & framework quirks

- Prettier: **tabs**, single quotes, no trailing commas, printWidth 100
  (`.prettierrc`). Rust: 4-space indent, 100 char (`rustfmt.toml`).
- Svelte 5 runes mode is forced on for all non-`node_modules` files via
  `svelte.config.js` `compilerOptions.runes`. Use `$state` / `$derived` /
  `$effect` — `prefer-const` is off for `.svelte.ts` because `$state()`
  requires `let` even when never reassigned.
- ESLint `max-lines` (400) and `max-lines-per-function` (80) are enforced on
  TS modules, with overrides: off for `.svelte` files and `*.test.ts`.
  `complexity` 15, `max-depth` 4. Keep new modules under those thresholds.
- Vitest uses `jsdom` + `@testing-library/svelte/vite`'s `svelteTesting()`.
  The `svelteTesting()` plugin is required — without it component `mount()`
  fails with SSR lifecycle errors (see `vitest.config.ts`).
- Pre-commit hook (install via `./scripts/install-hooks.sh`) runs only
  `npm run format:check`. It does not lint or typecheck.

## Release & versioning

- release-please manages a single version across `package.json`,
  `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`
  (`release-please-config.json` extra-files). **Don't bump versions by
  hand** — edit the release PR. Releases are `draft: true`.
- The Linux build job runs inside `ubuntu:25.10` (not the runner default)
  to bundle a webkit2gtk-4.1 new enough for modern Mesa on AMD/Intel.
- Windows CI (`windows` job in `.github/workflows/ci.yml`) only runs on PRs
  carrying the `windows-ci` label or on manual `workflow_dispatch`. Add
  the label to Shell-tab / Phase-17 / `fs_tools` PRs so the
  `#[cfg(windows)]` branches get compiled + tested.
