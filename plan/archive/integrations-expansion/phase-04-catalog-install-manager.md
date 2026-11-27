# Phase 04 — Curated catalog, install manager, settings shape

**Depends on:** Phases 01, 03 · **Enables:** Phases 05, 06, 07.

## Goal

Turn "add an integration" into something a non-technical user completes in the
app: a bundled catalog of vetted servers, a one-click install with a progress bar,
and guided setup steps for servers that need credentials before they will start.

## Files touched

- **NEW** `src-tauri/resources/mcp-catalog.json` — the bundled catalog.
- **NEW** `src-tauri/src/integrations/mcp/catalog.rs` — parse and validate it.
- **NEW** `src-tauri/src/integrations/mcp/install.rs` — the install manager.
- **NEW** `src-tauri/src/integrations/mcp/server_config.rs` — the ts-rs-exported
  `McpServerConfig`, mirroring how `EmailAccount` is defined in
  `integrations/email/auth.rs`.
- **EDIT** `src-tauri/tauri.conf.json` — the catalog joins `bundle.resources`.
- **EDIT** `src/lib/stores/settings.ts` — `integrations.mcp.servers[]` plus an
  `hasEnabledMcpServer()` predicate beside `hasEnabledEmailAccount()`.
- **EDIT** `src-tauri/src/lib.rs` — register the install/catalog commands.

## Implementation

### Catalog format

One JSON file, shipped in the bundle. Offline-capable, reviewable in git, updated
on app release. Each entry:

```jsonc
{
  "id": "github",
  "name": "GitHub",
  "description": "Read and search your repositories, issues and pull requests.",
  "homepage": "https://github.com/github/github-mcp-server",
  "acquisition": {
    "kind": "binary",              // "npm" | "pypi" | "binary"
    "repo": "github/github-mcp-server",
    "version": "v0.0.0",           // pinned
    "assets": { "x86_64-unknown-linux-gnu": "…", "aarch64-apple-darwin": "…" },
    "sha256": { "x86_64-unknown-linux-gnu": "…" }
  },
  "command": { "args": ["stdio"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "$secret.token" } },
  "defaultTools": ["search_repositories", "get_file_contents"],
  "setup": [ /* ordered steps — see below */ ]
}
```

**Three acquisition kinds, and why:**

- `npm` — installed with the bundled node + npm into the server's own directory.
- `pypi` — installed with the bundled `uv`, which also provisions CPython.
- `binary` — a pinned per-platform release asset, downloaded and checksum-verified.

The third kind is not optional: GitHub's official MCP server ships as a hosted
endpoint, a Docker image, or a **native Go binary** — never as an npm package.
Docker is not bundled and is not a supported kind. The `binary` path is the same
shape `scripts/fetch-ruff.sh` and `fetch-pdfium.sh` already use for third-party
release assets, just performed at runtime instead of build time.

### Guided setup steps

Some servers cannot start until the user has done something outside the app.
Google Drive/Workspace is the forcing case: it needs a Google Cloud project, an
OAuth client, a downloaded credentials file, and a browser auth run. A catalog
entry therefore declares ordered steps, each one of:

- `instruction` — text plus an optional link the app opens in a browser.
- `secret` — a labelled masked input (e.g. a PAT), stored with the server config.
- `file` — a file picker whose chosen file is copied into the server's directory
  (e.g. `gcp-oauth.keys.json`), using the existing `tauri-plugin-dialog`.
- `command` — a post-install command run with the bundled runtime, whose stdout
  and stderr are shown live, for the "run this once to authenticate in your
  browser" step.

Steps are data, not code: adding a server to the catalog must never require a
code change. Validate the shape at parse time and fail loudly on an unknown step
kind rather than silently skipping it.

The entry shape is additive by design. Phase 07 extends it with a `companion`
block and an `optional` flag on steps, for servers that drive a third-party
application; an entry without either must keep parsing unchanged.

### Install manager

Model the flow on `ModelManager` in `src-tauri/src/models.rs`, which already
solves exactly this problem for model weights: a `DownloadProgress` struct emitted
to the frontend, staged download, checksum verification, cancellation
(`cancel_download`), and cleanup of a failed partial.

Per-server directory: `<app_data>/mcp/servers/<id>/`. Everything a server owns —
its package tree, its credentials file, its virtualenv — lives there, so
uninstall is a directory removal and one settings entry.

Installs are **explicit and up front**, never `npx -y` at launch. That decision is
what makes launches offline-capable, fast and version-pinned, and it is what turns
an install failure into a progress bar with an error message instead of opaque npm
output in the middle of a conversation.

### Settings and secrets

`McpServerConfig` mirrors `EmailAccount`'s conventions: a frontend-generated UUID
as the stable key, a human label, a per-server `enabled` toggle, and camelCase
serde so one object round-trips through `invoke` untranslated.

Secrets live in the settings blob, the same trust level as the existing Brave key,
remote-inference key and IMAP passwords. This is a deliberate consistency choice,
not an oversight — say so in the module docs, as `email/auth.rs` does. A keyring
migration remains a cross-cutting change for all credentials at once.

## Build gate

```bash
npm run check && npm run lint && npm run test
cargo test  --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
node scripts/check-ipc.mjs && ./scripts/export-ipc-types.sh
```

## Test plan

- **Unit (Rust)** — catalog parses; an unknown acquisition or step kind is a loud
  error; per-platform asset selection; checksum mismatch aborts and cleans up;
  `$secret.*` references resolve into the spawn environment.
- **Unit (TS)** — settings round-trip; `hasEnabledMcpServer()`.
- **Manual:**
  - Install GitHub (binary kind), supply a PAT, and start it.
  - Install a small npm-kind server and confirm it launches offline afterwards
    (disconnect the network and restart it).
  - Cancel an install mid-download; confirm no partial directory survives.
  - Uninstall; confirm the directory and the settings entry both go.

## Commit

`feat(mcp): bundled server catalog with guided setup and install manager`

## Rollback

Revert. Servers already installed keep their directories; the settings entries
become inert until the feature returns.
