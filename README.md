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
- **Web research** — searches the web and reads pages to answer questions about current events
- **Voice input** — speak your questions via the built-in microphone button (powered by [whisper.cpp](https://github.com/ggml-org/whisper.cpp))
- **Voice output** — listen to responses read aloud with natural-sounding voices (powered by [Kokoros](https://github.com/lucasjinreal/Kokoros))
- **Audio device selection** — choose specific input/output audio devices in settings
- **GPU accelerated** — Vulkan (Linux/Windows) and Metal (macOS) for fast inference
- **First-run wizard** — detects your hardware, downloads a model, and gets you chatting in minutes
- **Sidecar log viewer** — inspect LLM, TTS, and Whisper server logs from the toolbar for easy troubleshooting
- **Dark mode** — system-aware theme with manual override
- **Persistent conversations** — SQLite-backed chat history survives restarts
- **Configurable** — context size, thinking mode, search provider, voice selection, response formatting

## Tech Stack

| Component | Technology |
|---|---|
| App framework | [Tauri 2.x](https://v2.tauri.app/) (Rust backend, system webview) |
| Frontend | [SvelteKit 5](https://svelte.dev/) (TypeScript, static SPA) |
| LLM inference | [llama.cpp](https://github.com/ggml-org/llama.cpp) sidecar (Vulkan/Metal) |
| Speech-to-text | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) sidecar (Vulkan/Metal) |
| Text-to-speech | [Kokoros](https://github.com/lucasjinreal/Kokoros) sidecar (CPU) |
| Default model | [Qwen 3.5 9B](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF) (Q4_K_M) |
| Database | SQLite (via rusqlite) |
| Web search | DuckDuckGo, Brave Search, or SearXNG |

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

| Target | Description |
|---|---|
| `make dev` | Run the app in dev mode (auto-checks sidecars) |
| `make check` | Run all checks (lint, format, typecheck, test) |
| `make fmt` | Auto-format all code (Prettier + cargo fmt) |
| `make sidecars` | Build sidecar binaries (llama-server, whisper-server, koko) |
| `make app` | Build the Tauri app packages (requires sidecars) |
| `make release-local` | Build everything: sidecars + app packages |
| `make clean` | Remove built sidecars, forcing rebuild |
| `make clean-all` | Remove sidecars + Rust/frontend build artifacts |
| `make reset-data` | Remove all app data (models, db) for a fresh start |

### Project structure

```
haruspex/
├── src/                    # SvelteKit frontend
│   ├── lib/
│   │   ├── agent/          # Tool-calling agent loop
│   │   ├── components/     # Svelte components
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
│   │   ├── models.rs       # Model download & management
│   │   └── db.rs           # SQLite conversation persistence
│   └── binaries/           # Sidecar binaries + libs (gitignored)
├── scripts/
│   ├── dev-setup.sh        # One-command dev environment setup
│   ├── build-sidecars.sh   # Build all sidecars for a target triple
│   ├── link-sidecar-libs.sh # Symlink shared libs for dev mode
│   └── bump-version.sh     # Version bump across all files
└── Makefile                # Dev and build targets
```

### Data directory

Haruspex stores models, database, and settings in:

| Platform | Path |
|---|---|
| Linux | `~/.local/share/com.haruspex.app/` |
| macOS | `~/Library/Application Support/com.haruspex.app/` |
| Windows | `%APPDATA%\com.haruspex.app\` |

Use `make reset-data` to wipe this directory for a fresh start (Linux only).

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

## Search providers

| Provider | Setup | Notes |
|---|---|---|
| Auto (default) | None | Rotates between Qwant, DuckDuckGo, and Bing with automatic failover and health tracking to avoid rate limits |
| DuckDuckGo | None | Single engine, may get rate limited |
| Brave Search | API key in Settings | 2,000 free queries/month, most reliable |
| SearXNG | Instance URL in Settings | Unlimited (self-hosted) |

## License

MIT
