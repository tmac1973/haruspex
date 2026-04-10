# Haruspex

A cross-platform desktop AI assistant that runs entirely on your computer. No cloud, no accounts, no telemetry. Your conversations never leave your device.

Haruspex wraps a local LLM (via [llama.cpp](https://github.com/ggml-org/llama.cpp)) with web research capabilities, speech-to-text, and text-to-speech — all running locally.

## Hardware Requirements

**Recommended:** A discrete AMD or NVIDIA GPU with 8 GB or more of VRAM. This is what Haruspex is designed for and where it performs best.

**Minimum:** Any system with a Vulkan-capable GPU and 8 GB of system RAM. Haruspex includes a smaller 4B parameter model for systems with limited VRAM.

**Integrated graphics** (Intel HD/UHD/Iris, AMD Vega/Radeon Graphics) will work but inference will be significantly slower since these GPUs share system memory and have limited compute throughput. Recent AMD APUs with RDNA-class integrated graphics perform better than older Intel iGPUs, but still fall well short of a discrete card. The setup wizard detects integrated graphics automatically and recommends an appropriately sized model.

**Apple Silicon** Macs use unified memory and Metal acceleration, so even the base M1 with 8 GB provides a good experience.

Haruspex uses your GPU for inference. While it is running, other GPU-intensive applications like games may experience reduced performance. For the best experience, close Haruspex before launching games or other GPU-heavy programs.

## Features

- **Private by design** — all inference runs on your hardware, nothing is sent to the cloud
- **Web research** — searches the web and reads pages to answer questions about current events. Two URL-reading modes: `fetch_url` returns the raw page text, `research_url` runs the page through a focused sub-agent that extracts only the parts relevant to a specific question, returning concise findings instead of the full page.
- **Deep research mode** — optional toggle for thorough multi-source synthesis. Allows up to 25 tool-call iterations per turn, forces the model to use the context-light `research_url` tool for every page (so a single research turn can fan out across many more sources without running out of context), and runs in-loop trimming of older tool results when context fills up. Each sub-agent processes one URL sequentially through the same llama-server slot — the win comes from context isolation, not parallelism.
- **Local file access (opt-in)** — pick a working directory to let the model read and write files within it. See [Local files](#local-files) below for the full list of supported formats and tools. Sandboxed to the chosen directory; the model cannot touch anything outside it.
- **Vision** — analyze images and form PDFs using the model's built-in vision capability (via the mmproj projector bundled with Qwen 3.5)
- **Voice input** — speak your questions via the built-in microphone button (powered by [whisper.cpp](https://github.com/ggml-org/whisper.cpp))
- **Voice output** — listen to responses read aloud with natural-sounding voices (powered by [Kokoros](https://github.com/lucasjinreal/Kokoros))
- **Audio device selection** — choose specific input/output audio devices in settings
- **GPU accelerated** — Vulkan (Linux/Windows) and Metal (macOS) for fast inference
- **First-run wizard** — detects your hardware (GPU type, VRAM, integrated vs discrete), downloads a model appropriate for your system, and gets you chatting in minutes
- **Log viewer** — toolbar modal with tabs for the main app and each sidecar (LLM, TTS, Whisper). Copy-all button makes bug reports trivial.
- **Dark mode** — system-aware theme with manual override
- **Persistent conversations** — SQLite-backed chat history survives restarts
- **Configurable** — context size, search provider, voice selection, response formatting

## Local files

When you select a working directory from the folder icon in the chat input, Haruspex exposes filesystem tools to the model — scoped strictly to that directory. Without a working directory set, the model has no filesystem access at all and doesn't even know those tools exist.

**What the model can read**:

- Plain text, markdown, CSV, JSON, shell scripts, YAML, TOML, etc. (`fs_read_text`)
- PDFs — text extraction via PDFium with position-aware layout reconstruction, so form PDFs like tax forms and invoices come out in the correct reading order (`fs_read_pdf`)
- PDFs as images — renders each page via PDF.js and feeds them to the vision model, for scanned documents or when text extraction isn't enough (`fs_read_pdf_pages`)
- Microsoft Word (.docx) documents (`fs_read_docx`)
- Excel (.xlsx) spreadsheets, returned as CSV text (`fs_read_xlsx`)
- Images (PNG, JPEG, WebP) using the vision model (`fs_read_image`)
- Directory listings (`fs_list_dir`)

**What the model can write**:

- Plain text files — markdown, CSV, JSON, bash scripts, etc. (`fs_write_text`)
- Targeted find-and-replace edits to existing text files (`fs_edit_text`)
- Microsoft Word (.docx) documents from markdown-style input (`fs_write_docx`)
- Excel (.xlsx) spreadsheets with multiple sheets (`fs_write_xlsx`)
- PDFs from markdown-style input (`fs_write_pdf`)

**What the model cannot do**: delete files, move files, execute scripts, or touch anything outside the working directory. These are intentional restrictions — if you want the model to delete or run something, you do it manually after reviewing what it created.

Working directory selection is per-conversation and not persisted across app restarts. Each new conversation starts with no working directory; opt in when you need it.

## Tech Stack

| Component                       | Technology                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App framework                   | [Tauri 2.x](https://v2.tauri.app/) (Rust backend, system webview)                                                                                                               |
| Frontend                        | [SvelteKit 5](https://svelte.dev/) (TypeScript, static SPA, Svelte 5 runes)                                                                                                     |
| LLM inference                   | [llama.cpp](https://github.com/ggml-org/llama.cpp) sidecar (Vulkan/Metal, multimodal with mmproj)                                                                               |
| Speech-to-text                  | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) sidecar (Vulkan/Metal)                                                                                                   |
| Text-to-speech                  | [Kokoros](https://github.com/lucasjinreal/Kokoros) sidecar (CPU)                                                                                                                |
| Default models                  | [Qwen 3.5 9B](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF) and [Qwen 3.5 4B](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF) (both vision-language)                          |
| PDF text extraction             | [PDFium](https://github.com/bblanchon/pdfium-binaries) (same library Chrome uses) with custom position-aware layout reconstruction                                              |
| PDF rendering (vision fallback) | [PDF.js](https://mozilla.github.io/pdf.js/) running in the Tauri webview                                                                                                        |
| PDF creation                    | [printpdf](https://crates.io/crates/printpdf) (pure Rust)                                                                                                                       |
| docx / xlsx                     | Custom zip+XML for docx reads/writes, [calamine](https://crates.io/crates/calamine) for xlsx reads, [rust_xlsxwriter](https://crates.io/crates/rust_xlsxwriter) for xlsx writes |
| Database                        | SQLite (via rusqlite)                                                                                                                                                           |
| Web search                      | Auto-rotation (Brave HTML / DuckDuckGo / Mojeek), Brave Search API, or SearXNG                                                                                                  |

## Installing

Download the latest release for your platform from the [Releases](https://github.com/tmac1973/haruspex/releases) page.

### Runtime prerequisites

The release packages bundle everything needed. However, the system webview and a few shared libraries are required:

#### Debian / Ubuntu

```bash
# The .deb package handles most dependencies automatically
sudo apt install libwebkit2gtk-4.1-0 libayatana-appindicator3-1
```

#### Fedora

```bash
# The .rpm package handles most dependencies automatically
sudo dnf install webkit2gtk4.1 libappindicator-gtk3
```

#### Arch / CachyOS

```bash
# Install from the .AppImage — no package manager dependencies needed
# Just make sure you have a working GPU driver (mesa/vulkan)
chmod +x Haruspex_*.AppImage
./Haruspex_*.AppImage
```

#### Windows

Run the `.msi` or `.exe` installer. No additional dependencies required — the MSVC runtime is bundled.

#### macOS

Open the `.dmg` and drag Haruspex to Applications. On first launch, right-click and choose "Open" to bypass Gatekeeper (the app is not code-signed).

## Development

### Build prerequisites

#### Debian / Ubuntu

```bash
sudo apt install build-essential cmake pkg-config \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libasound2-dev \
  libvulkan-dev glslc libsonic-dev libpcaudio-dev libssl-dev libfuse2
```

#### Fedora

```bash
sudo dnf groupinstall "Development Tools"
sudo dnf install cmake pkg-config \
  webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel alsa-lib-devel \
  vulkan-headers glslc sonic-devel openssl-devel
```

#### Arch / CachyOS

```bash
sudo pacman -S base-devel cmake pkg-config \
  webkit2gtk-4.1 libappindicator-gtk3 librsvg alsa-lib \
  vulkan-headers shaderc fuse2
```

#### Windows

- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload)
- [CMake](https://cmake.org/download/)
- [Vulkan SDK](https://vulkan.lunarg.com/)

#### macOS

```bash
xcode-select --install
brew install cmake pkg-config opus
```

#### All platforms

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 22+

### Dev setup

```bash
git clone https://github.com/tmac1973/haruspex.git
cd haruspex

# Build sidecars and download models (first time only)
./scripts/dev-setup.sh

# Run the app
make dev
```

### Make targets

Run `make help` to see all targets:

| Target               | Description                                                 |
| -------------------- | ----------------------------------------------------------- |
| `make dev`           | Run the app in dev mode (auto-checks sidecars)              |
| `make check`         | Run all checks (lint, format, typecheck, test)              |
| `make fmt`           | Auto-format all code (Prettier + cargo fmt)                 |
| `make sidecars`      | Build sidecar binaries (llama-server, whisper-server, koko) |
| `make app`           | Build the Tauri app packages (requires sidecars)            |
| `make release-local` | Build everything: sidecars + app packages                   |
| `make clean`         | Remove built sidecars, forcing rebuild                      |
| `make clean-all`     | Remove sidecars + Rust/frontend build artifacts             |
| `make reset-data`    | Remove all app data (models, db) for a fresh start          |

### Project structure

```
haruspex/
├── src/                    # SvelteKit frontend
│   ├── lib/
│   │   ├── agent/          # Tool-calling agent loop
│   │   │   ├── loop.ts     # Main agent iteration logic
│   │   │   ├── tools.ts    # Tool schema definitions
│   │   │   ├── search.ts   # Tool dispatch (web + filesystem)
│   │   │   ├── pdf-render.ts # PDF.js renderer for vision fallback
│   │   │   └── parser.ts   # Tool call XML/JSON parsing
│   │   ├── components/     # Svelte components (chat, log viewer, etc.)
│   │   ├── stores/         # Reactive state (Svelte 5 runes)
│   │   ├── api.ts          # llama-server API client
│   │   └── markdown.ts     # Markdown rendering + TTS text prep
│   └── routes/             # Pages (chat, setup wizard, settings)
├── src-tauri/
│   ├── src/
│   │   ├── server.rs       # llama-server sidecar manager
│   │   ├── whisper.rs      # whisper-server sidecar manager
│   │   ├── tts.rs          # Kokoros TTS sidecar manager
│   │   ├── audio.rs        # Microphone recording + device enumeration
│   │   ├── proxy.rs        # Web search & URL fetching
│   │   ├── models.rs       # Model download & management, mmproj support
│   │   ├── fs_tools.rs     # Sandboxed filesystem tools + PDFium integration
│   │   ├── app_log.rs      # In-memory log capture for the Log Viewer
│   │   └── db.rs           # SQLite conversation persistence
│   └── binaries/           # Sidecar binaries + bundled libs incl. libpdfium (gitignored)
├── plan/                   # Phase plans and architecture notes
├── scripts/
│   ├── dev-setup.sh        # One-command dev environment setup
│   ├── build-sidecars.sh   # Build sidecars + download libpdfium for a target triple
│   ├── link-sidecar-libs.sh # Symlink shared libs for dev mode
│   └── bump-version.sh     # Version bump across all files
└── Makefile                # Dev and build targets
```

### Data directory

Haruspex stores models, database, and settings in:

| Platform | Path                                              |
| -------- | ------------------------------------------------- |
| Linux    | `~/.local/share/com.haruspex.app/`                |
| macOS    | `~/Library/Application Support/com.haruspex.app/` |
| Windows  | `%APPDATA%\com.haruspex.app\`                     |

Use `make reset-data` to wipe this directory for a fresh start (Linux/macOS).

## Building a release

Releases are built via GitHub Actions:

1. Go to Actions > "Release" > "Run workflow"
2. Enter the version number (e.g., `0.1.0`)
3. Click "Run workflow"

This bumps the version, creates a git tag, builds sidecars and the app for all platforms (Linux AppImage/deb/rpm, Windows NSIS/MSI, macOS DMG), and creates a draft GitHub release.

To build locally:

```bash
make release-local
```

**Bundled binaries**: The release includes three sidecar binaries (llama-server, whisper-server, koko) and one shared library (libpdfium) per platform. `scripts/build-sidecars.sh` handles all of this — it compiles the sidecars from source and downloads the appropriate libpdfium from [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries). No manual library management required.

## Search providers

| Provider          | Setup                    | Notes                                                                                                                          |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Auto (default)    | None                     | Rotates between Brave HTML scrape, DuckDuckGo, and Mojeek with round-robin scheduling, per-engine health tracking, and failover |
| DuckDuckGo        | None                     | Single engine, may get rate limited                                                                                            |
| Brave Search API  | API key in Settings      | 2,000 free queries/month, most reliable                                                                                        |
| SearXNG           | Instance URL in Settings | Unlimited (self-hosted)                                                                                                        |

When deep research mode is on _and_ the Auto provider is selected _and_ no Brave API key is configured, the search proxy automatically switches to **slow mode** — longer per-engine pacing (~6s vs 2s) and shorter cooldowns after a failure (~45s vs 5min) so engines can recover within the same research turn. A small notice appears above the search-steps panel explaining the slow pacing and pointing the user to Settings. Configuring a Brave API key or a SearXNG instance bypasses slow mode entirely and runs at full speed.

Bing and Qwant were previously in the Auto rotation but were removed: as of April 2026 both serve fully client-rendered SPAs gated by JavaScript bot challenges (Bing uses Cloudflare Turnstile, Qwant uses DataDome), so plain-HTTP scraping returns no results. They could be revived only with a headless browser or a paid API.

## License

MIT
