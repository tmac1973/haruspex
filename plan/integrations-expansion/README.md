# Integrations Expansion — Implementation Plan

Phased, dependency-ordered plan for broadening Haruspex's integration surface:
hand-built desktop context and CalDAV/CardDAV, plus a full MCP client with a
curated, zero-install server catalog. See [`overview.md`](./overview.md) for the
project definition and the full Decisions appendix.

**Status:** Locked 2026-09-03. Not yet implemented.

## Phase map (strictly dependency-ordered)

Three tracks. **A** and **C** are independent of everything else and of each
other. **B** is the bulk of the work and is internally sequential.

| # | File | Phase | Track | Depends on |
|---|---|---|---|---|
| 1 | `phase-01-desktop-context.md` | Clipboard + active-window tools | A | — |
| 2 | `phase-02-global-hotkey.md` | Global hotkey → capture into a new chat | A | 1 |
| 3 | `phase-03-bundled-runtimes.md` | Bundle node + npm + uv | B | — |
| 4 | `phase-04-mcp-process-lifecycle.md` | Spawn, crash, hang, zombie reaping (adds the rmcp dep) | B | 3 |
| 5 | `phase-05-mcp-client-protocol.md` | Dual-era negotiation, discovery, MRTR | B | 4 |
| 6 | `phase-06-catalog-install-manager.md` | Catalog format + install manager | B | 3, 5 |
| 7 | `phase-07-tool-registration-budget-approval.md` | Dynamic tools, budget, approval | B | 5, 6 |
| 8 | `phase-08-mcp-settings-ui.md` | Settings UI | B | 6, 7 |
| 9 | `phase-09-http-transport.md` | Streamable HTTP transport | B | 5, 8 |
| 10 | `phase-10-screenshots.md` | Screen capture, all platforms | C | — |
| 11 | `phase-11-dav-foundation-caldav.md` | DAV client + CalDAV read | C | — |
| 12 | `phase-12-carddav.md` | CardDAV read | C | 11 |
| 13 | `phase-13-hardening.md` | Hardening + cross-platform verification | — | all |

`rmcp`'s stdio transport (`TokioChildProcess`) spawns the child itself, so the
lifecycle supervisor is built around it — the dependency lands in phase 4, not
phase 5. Phase 5 is then purely protocol: negotiation, discovery and MRTR.

Phase 1 is the deliberate warm-up: it ships something useful in a weekend and
touches the tool-registry gating pattern that phase 7 later extends. Phase 3 is
long-lead work (per-platform binaries, CI, bundle config) and can start in
parallel with track A.

## Locked decisions (full list in `overview.md`)

**MCP:** rmcp 3.x · both protocol eras · bundled node/npm/uv · release-binary
acquisition as a third kind · explicit install with progress, never `npx -y` ·
dynamic registration into the existing registry under an `mcp` category ·
annotation-driven approval with missing-annotation-means-unsafe · per-tool
toggles plus a model-scaled budget *warning* · bundled JSON catalog · GitHub and
Google Drive/Workspace as v1 entries · guided-setup steps in the catalog format ·
stdio first, HTTP in phase 9 · MRTR mapped onto the existing `ask_user_question`
primitive · secrets in the settings blob.

**Desktop:** agent tools *and* a global hotkey · reuse the existing
`clipboard.rs` · best-effort active window with an honest Wayland "unavailable" ·
never polled.

**Screenshots:** portal-first on Linux · whole-screen or user-chosen window ·
vision confirmed on every shipped model, no OCR fallback.

**DAV:** read-only v1 · basic/app-password only · no OAuth added · Google
Calendar ships as an MCP config, not a hand-built integration.

**Platforms:** Linux, macOS and Windows implemented up front.

## Global build gate (every phase)

CI runs clippy with `-D warnings` and treats ESLint errors as blocking; the
pre-commit hook only checks Prettier, so run the full gate locally.

```bash
npm run check && npm run lint && npm run test
cargo check   --manifest-path src-tauri/Cargo.toml
cargo clippy  --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
node scripts/check-ipc.mjs                 # any phase adding Tauri commands
```

Any phase that adds a `#[tauri::command]` must regenerate the IPC bindings
(`node scripts/check-ipc.mjs --write`) and the ts-rs types
(`./scripts/export-ipc-types.sh`) in the same commit — a rename on either side
otherwise compiles fine and fails at chat time.

## Working notes

- **Restart cleanly after Rust changes.** Hot-reload leaves sidecars holding
  8765/3001/8766; from phase 4 on it will leave MCP children too.
- **Git operations touching `src-tauri/` silently restart a running dev app.**
  Coordinate before checkouts while `make dev` is up.
- Commits follow Conventional Commits — release-please parses every one to
  compute versions and the changelog.
