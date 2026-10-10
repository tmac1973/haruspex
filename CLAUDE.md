# Haruspex

Private local AI desktop app — Tauri 2.x + SvelteKit 5 + llama.cpp sidecar.

## Tech Stack

- **Frontend**: SvelteKit 5 (Svelte 5 runes, TypeScript, static adapter for SPA)
- **Backend**: Tauri 2.x (Rust)
- **LLM Inference**: llama-server sidecar (port 8765, OpenAI-compatible API)
- **Speech-to-Text**: whisper-server sidecar (port 8766, whisper.cpp)
- **Text-to-Speech**: koko sidecar (port 3001, Kokoros OpenAI-compatible API)
- **Image generation**: ComfyUI (a server the user runs) or the bundled
  sd-server sidecar (port 8767, stable-diffusion.cpp). Off by default; nothing
  starts until Settings → Image selects one. See `docs/image-generation.md`.
- **Integrations**: MCP servers (stdio + streamable HTTP), IMAP email, CalDAV/CardDAV, screen capture
- **Default model**: Qwen 3.5 9B (Q4_K_M, ~5.7 GB)
- **Image models**: Ming-Image 0.1 Design (MIT; the default, ComfyUI) and
  Qwen-Image-2.1 (non-commercial), installed into the user's ComfyUI from
  Settings → Image (`comfy_models.rs`); the bundled engine runs the same two
  as GGUF (`image_models.rs`, Ming converted by us and hosted on Hugging Face),
  downloaded to `models/image/<id>/`. Licence and commercial use are
  first-class fields in both

## Dev Setup

```bash
# First time: builds all sidecars and downloads models
./scripts/dev-setup.sh

# Install git hooks (pre-commit formatting check)
./scripts/install-hooks.sh

# Run the app
GDK_BACKEND=x11 npm run tauri dev

# Rebuild sidecars only (skips models)
./scripts/dev-setup.sh --skip-models

# Re-download models only (skips builds)
./scripts/dev-setup.sh --skip-build
```

### Sidecar binaries (in src-tauri/binaries/)

Every one is named `haruspex-<tool>-{triple}`. The deb and rpm bundlers install
each `externalBin` into `/usr/bin` under its stem with the triple stripped, and
rpm fails the whole transaction when two packages claim one path — so an
unprefixed `node`, `uv`, `ruff`, `llama-server` or `koko` is an app that will
not install on a machine that has the distro's package of the same name. A test
in `runtimes.rs` guards the rule. The one thing it costs is covered by
`runtimes::node_shim_dir`: npm hands a lifecycle script a `PATH` and lets it
call plain `node`, so we link one into the app's data directory.

| Binary | Source | GPU | Purpose |
|---|---|---|---|
| `haruspex-llama-server-{triple}` | llama.cpp | Vulkan | LLM inference |
| `haruspex-whisper-server-{triple}` | whisper.cpp | Vulkan | Speech-to-text |
| `haruspex-koko-{triple}` | Kokoros | CPU | Text-to-speech |
| `haruspex-node-{triple}` | nodejs.org | — | Runs npm-packaged MCP servers |
| `haruspex-uv-{triple}` | astral-sh/uv | — | Runs PyPI-packaged MCP servers |
| `haruspex-sd-server-{triple}` | stable-diffusion.cpp | Vulkan / Metal | Local image generation |

`sd-server` is DOWNLOADED, not built — upstream ships a Vulkan/Metal binary for
every triple we target. Its shared libraries live in `binaries/sd-libs/`, apart
from `binaries/libs/`, because it carries its own ggml whose sonames collide
with llama.cpp's; see `docs/image-generation.md`.

`node` and `uv` are bundled so a user never needs a terminal to install an MCP
server. They are fetched by `./scripts/fetch-node.sh` and `./scripts/fetch-uv.sh`;
npm ships alongside node under `src-tauri/binaries/node-modules/`. CI creates
stub files for all of them because `tauri-build` validates every `externalBin`
path at compile time.

Binaries and `.so` files are gitignored. Run `./scripts/link-sidecar-libs.sh` to symlink them to `target/debug/` for dev mode.

### Localhost ports

| Port | What |
|---|---|
| 1420 | SvelteKit dev server |
| 3001 | koko (TTS) |
| 8765 | llama-server |
| 8766 | whisper-server |
| 8767 | sd-server, when the bundled image engine is running |
| 9876 | Blender, when its companion addon is running |
| 9080 | Godot's editor bridge, when its addon is enabled |

The last two are **not ours** — they belong to the third-party app an MCP
companion server bridges to. Haruspex only probes them (see
`integrations/mcp/companion.rs`), and the proxy config never applies to
loopback.

## Build Commands

```bash
npm run dev          # SvelteKit dev server (port 1420)
npm run build        # Build frontend
npm run build:web    # Build the web client (Settings → Remote control's page); make dev runs it when src/web or src/lib changed
npm run check        # TypeScript / Svelte type checking
npm run lint         # ESLint
npm run format       # Prettier format
npm run format:check # Prettier check
npm run test         # Vitest (run once)
npm run test:watch   # Vitest (watch mode)
npm run tauri dev    # Full Tauri dev (frontend + Rust)
npm run tauri build  # Production build

# Rust (from src-tauri/)
cargo test           # Rust unit tests
cargo clippy         # Rust lints
cargo fmt -- --check # Rust format check
```

## Conventions

- SvelteKit SPA mode (SSR disabled, static adapter with `fallback: 'index.html'`)
- Svelte 5 runes mode everywhere
- Imports from `src/lib` use `#lib/...` (package.json `imports`) with the file's
  extension: `#lib/stores/settings.ts`, `#lib/components/Foo.svelte`. Vite resolves
  an extensionless `#lib/agent/loop` to the `loop/` folder, not `loop.ts`.
- Tabs for indentation, single quotes, no trailing commas (Prettier)
- Rust: 4-space indent, 100 char line width
- Tests co-located with source: `foo.ts` → `foo.test.ts`
- Sidecar pattern: long-running processes as HTTP servers on localhost
- UI copy: one short sentence per section, no exposition and no sales language.
  Extra detail belongs in a `title` tooltip. Always name the settings path
  ("Settings → Network") rather than describing where to look.
- Settings are plain JSON. Anything handed to a `stores/settings.ts` setter is
  snapshotted — never store a `$state` proxy, or `structuredClone` of the
  settings blob throws and wedges the panel.
- Changing a Tauri command or a `#[ts(export)]` struct means running
  `./scripts/export-ipc-types.sh`, or CI fails on drift.

## Outstanding work

Open work lives in GitHub issues, not in session notes. Before ending a
session, file anything left undone (follow-ups, hand tests, the user's own
pending steps) with `gh issue create`, grouping related items into one issue
with a checklist rather than one issue each, and add to an existing open issue
when it already covers the area. Check `gh issue list` at the start of a
session to see what's pending, and close an issue (or tick its box) in the PR
that finishes it.

## User guide

`docs/guide/` is the user guide: compiled into the app, where the model reads
it through `haruspex_docs` to answer questions about Haruspex, and published
on the website. It has to describe the app as it is.

- A change users can see (a setting, a tool, a job type, a slash command, a
  shortcut, a shipped skill, or different behaviour) updates its page in the
  same PR, and the PR body names the page. The `Guide` check
  (`scripts/guide-check.mjs`) fails a PR that touches those paths without
  touching `docs/guide/`; label it `no-docs` when nothing a user sees changed.
- Keyboard shortcuts live in `src/lib/shortcuts.ts`; the `shortcuts` page
  writes each key exactly as that list does, and a test holds them together.
- Writing: headings say what the user wants to do; Settings paths in full
  ("Settings → Shell → Memory limit"); plain words, no marketing; say what it
  doesn't do as well. Each page stands alone, since the model reads one at a
  time: point at others by name ("see the `skills` page"). Every page has
  `title` and `description` frontmatter, and stays under 6 KB.
