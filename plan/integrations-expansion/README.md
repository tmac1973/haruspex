# Integrations Expansion — Implementation Plan

Phased, dependency-ordered plan for broadening Haruspex's integration surface:
a full MCP client with a curated, zero-install server catalog, plus hand-built
screen capture and CalDAV/CardDAV. See [`overview.md`](./overview.md) for the
project definition and the full Decisions appendix.

**Status:** Locked 2026-09-03 · revised 2026-09-05 (clipboard, active-window and
global-hotkey phases cut; companion-app catalog entries added). Not yet
implemented.

## Phase map (strictly dependency-ordered)

Two tracks. **A** is the bulk of the work and is internally sequential. **B** is
three independent phases that can land at any point alongside it.

| # | File | Phase | Track | Depends on |
|---|---|---|---|---|
| 1 | `phase-01-bundled-runtimes.md` | Bundle node + npm + uv | A | — |
| 2 | `phase-02-mcp-process-lifecycle.md` | Spawn, crash, hang, zombie reaping (adds the rmcp dep) | A | 1 |
| 3 | `phase-03-mcp-client-protocol.md` | Dual-era negotiation, discovery, MRTR | A | 2 |
| 4 | `phase-04-catalog-install-manager.md` | Catalog format + install manager | A | 1, 3 |
| 5 | `phase-05-tool-registration-budget-approval.md` | Dynamic tools, budget, approval | A | 3, 4 |
| 6 | `phase-06-mcp-settings-ui.md` | Settings UI | A | 4, 5 |
| 7 | `phase-07-companion-app-servers.md` | Companion-app entries: Blender, Godot | A | 4, 6 |
| 8 | `phase-08-http-transport.md` | Streamable HTTP transport | A | 3, 6 |
| 9 | `phase-09-screenshots.md` | Screen capture, all platforms | B | — |
| 10 | `phase-10-dav-foundation-caldav.md` | DAV client + CalDAV read | B | — |
| 11 | `phase-11-carddav.md` | CardDAV read | B | 10 |
| 12 | `phase-12-hardening.md` | Hardening + cross-platform verification | — | all |

`rmcp`'s stdio transport (`TokioChildProcess`) spawns the child itself, so the
lifecycle supervisor is built around it — the dependency lands in phase 2, not
phase 3. Phase 3 is then purely protocol: negotiation, discovery and MRTR.

Phase 1 is long-lead work (per-platform binaries, CI, bundle config) and gates
everything in track A, so it starts first. Phases 7 and 8 are both leaves off the
settings UI and are independent of each other. Phase 9 is self-contained — it
creates the `desktop/` module and its Settings section rather than inheriting
them, since the phases that used to do that are cut.

## Locked decisions (full list in `overview.md`)

**MCP:** rmcp 3.x · both protocol eras, scoped to connect/list/call · bundled
node/npm/uv · release-binary acquisition as a third kind · explicit install with
progress, never `npx -y` · dynamic registration into the existing registry under
an `mcp` category · annotation-driven approval with
missing-annotation-means-unsafe · per-tool toggles plus a model-scaled budget
*warning* · bundled JSON catalog · GitHub and Google Drive/Workspace as v1
entries, plus Blender and Godot as companion-app entries · guided-setup steps in
the catalog format · stdio first, HTTP in phase 8 · MRTR (modern era only) mapped
onto the existing `ask_user_question` primitive · secrets in the settings blob.

**Companion-app servers:** Blender and Godot drive an application we neither
bundle nor install · the entry declares a `companion` block and the app probes it
· companion state is a field beside the four-state process status, not a fifth
state · a probe may only call a `readOnlyHint` tool · community servers carry
pinned versions and a provenance line shown before install.

**Screen capture:** an agent tool plus a composer attach control, no global
hotkey · portal-first on Linux · whole-screen or user-chosen window · vision
confirmed on every shipped model, no OCR fallback · never polled.

**Cut 2026-09-05:** clipboard and active-window tools, and the global hotkey.
Heavy per-platform native work for something pasting into the composer already
covers, and the hotkey is the hardest part of it to get right on three platforms.

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
  8765/3001/8766; from phase 2 on it will leave MCP children too.
- **Git operations touching `src-tauri/` silently restart a running dev app.**
  Coordinate before checkouts while `make dev` is up.
- Commits follow Conventional Commits — release-please parses every one to
  compute versions and the changelog.
