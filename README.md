# Haruspex

A cross-platform desktop AI assistant that runs entirely on your computer. No cloud, no accounts, no telemetry. Your conversations never leave your device.

Haruspex wraps a local LLM (via [llama.cpp](https://github.com/ggml-org/llama.cpp)) with web research capabilities, speech-to-text, and text-to-speech — all running locally.

## Features

- **Private by design** — all inference runs on your hardware, nothing is sent to the cloud
- **Web research** — searches the web and reads pages to answer questions about current events
- **Voice input** — speak your questions via the built-in microphone button (powered by [whisper.cpp](https://github.com/ggml-org/whisper.cpp))
- **Voice output** — listen to responses read aloud with natural-sounding voices (powered by [Kokoros](https://github.com/lucasjinreal/Kokoros))
- **GPU accelerated** — Vulkan (Linux/Windows) and Metal (macOS) for fast inference
- **First-run wizard** — downloads a model and gets you chatting in minutes
- **Dark mode** — system-aware theme with manual override
- **Persistent conversations** — SQLite-backed chat history survives restarts
- **Configurable** — context size, search provider, voice selection, response formatting

## Tech Stack

| Component | Technology |
|---|---|
| App framework | [Tauri 2.x](https://v2.tauri.app/) (Rust backend, system webview) |
| Frontend | [SvelteKit 5](https://svelte.dev/) (TypeScript, static SPA) |
| LLM inference | [llama.cpp](https://github.com/ggml-org/llama.cpp) sidecar |
| Speech-to-text | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) sidecar |
| Text-to-speech | [Kokoros](https://github.com/lucasjinreal/Kokoros) sidecar |
| Default model | [Qwen 3.5 9B](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF) (Q4_K_M) |
| Database | SQLite (via rusqlite) |
| Web search | DuckDuckGo, Brave Search, or SearXNG |

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 22+
- CMake
- Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libasound2-dev`
- Vulkan headers (optional, for GPU acceleration)

### Dev Setup

```bash
git clone https://github.com/tmac1973/haruspex.git
cd haruspex

# Build sidecars and download models (first time only)
./scripts/dev-setup.sh

# Run the app
npm run tauri dev
```

On Linux with Wayland, you may need:
```bash
GDK_BACKEND=x11 npm run tauri dev
```

### Project Structure

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
│   │   ├── whisper.rs       # whisper-server sidecar manager
│   │   ├── tts.rs          # Kokoros TTS sidecar manager
│   │   ├── audio.rs        # Microphone recording (cpal)
│   │   ├── proxy.rs        # Web search & URL fetching
│   │   ├── models.rs       # Model download & management
│   │   └── db.rs           # SQLite conversation persistence
│   └── binaries/           # Sidecar binaries (gitignored)
├── scripts/
│   ├── dev-setup.sh        # One-command dev environment setup
│   ├── build-sidecars.sh   # Build all sidecars for a target
│   └── bump-version.sh     # Version bump across all files
└── plan/                   # Implementation plans
```

## Building a Release

Releases are built via GitHub Actions:

1. Go to Actions > "Release" > "Run workflow"
2. Enter the version number (e.g., `0.1.0`)
3. Click "Run workflow"

This bumps the version, creates a git tag, builds sidecars and the app for all platforms, and creates a draft GitHub release.

## Search Providers

| Provider | Setup | Limits |
|---|---|---|
| DuckDuckGo | None (default) | Rate limited, may show captcha |
| Brave Search | API key in Settings | 2,000 free queries/month |
| SearXNG | Instance URL in Settings | Unlimited (self-hosted) |

## License

MIT
