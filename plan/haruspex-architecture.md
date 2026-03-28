# Sage — Architecture Decision Record & Project Scaffold

## Overview

A cross-platform native desktop app that wraps llama.cpp for non-technical users,
providing private, local AI with web research capability. No cloud, no accounts,
no telemetry.

---

## Technology Stack

| Concern | Choice | Rationale |
|---|---|---|
| App framework | **Tauri 2.x** | System webview (tiny installers), Rust core, sidecar API, built-in packaging |
| Frontend | **SvelteKit 5** | Familiar from LlamaCtl, fast, small bundle |
| Inference backend | **llama-server** (bundled sidecar) | OpenAI-compatible API, Vulkan/Metal support |
| GPU — Linux/Windows | **Vulkan** | Zero-driver-install GPU acceleration, AMD/NVIDIA/Intel, CPU fallback |
| GPU — macOS | **Metal (MPS)** | Native Apple GPU API, faster than MoltenVK shim |
| Web search | **DuckDuckGo HTML** (zero-config) + Tavily opt-in | No API key required by default |
| Packaging | **tauri build** via GitHub Actions matrix | .msi / .dmg / .deb / .rpm / .AppImage |

---

## Repository Structure

```
sage/
├── src/                        # SvelteKit frontend
│   ├── lib/
│   │   ├── components/
│   │   │   ├── ChatMessage.svelte
│   │   │   ├── SearchStep.svelte
│   │   │   ├── SourceChip.svelte
│   │   │   └── ThinkingIndicator.svelte
│   │   ├── stores/
│   │   │   ├── chat.ts           # conversation history
│   │   │   ├── server.ts         # llama-server status + config
│   │   │   └── settings.ts       # persisted user prefs
│   │   ├── agent/
│   │   │   ├── loop.ts           # tool-call agent loop
│   │   │   ├── tools.ts          # web_search + fetch_url definitions
│   │   │   └── search.ts         # DDG + Tavily adapters
│   │   └── api.ts                # llama-server OpenAI client wrapper
│   ├── routes/
│   │   ├── +layout.svelte
│   │   ├── +page.svelte          # main chat
│   │   └── setup/+page.svelte    # first-run wizard
│   └── app.html
│
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── server.rs             # spawn/stop llama-server sidecar
│   │   ├── proxy.rs              # HTTP proxy command (web search/fetch)
│   │   └── models.rs             # download + verify GGUF files
│   ├── binaries/                 # pre-compiled llama-server sidecars
│   │   ├── llama-server-x86_64-unknown-linux-gnu
│   │   ├── llama-server-x86_64-pc-windows-msvc.exe
│   │   ├── llama-server-x86_64-apple-darwin
│   │   └── llama-server-aarch64-apple-darwin
│   ├── icons/                    # app icons (all sizes)
│   └── tauri.conf.json
│
├── .github/
│   └── workflows/
│       ├── build.yml             # matrix build: ubuntu/windows/macos
│       └── release.yml           # tag → draft GitHub release
│
└── scripts/
    └── build-llama-server.sh     # build script for all sidecar targets
```

---

## Tauri Sidecar Configuration

In `tauri.conf.json`:

```json
{
  "tauri": {
    "bundle": {
      "externalBin": [
        "binaries/llama-server"
      ]
    }
  }
}
```

Tauri automatically appends the platform triple suffix at build time.
At runtime, use `Command::new_sidecar("llama-server")` from `tauri::api::process`.

---

## llama-server Invocation

The Rust sidecar manager spawns llama-server with these flags:

```
llama-server
  --model <appDataDir>/models/<active_model>.gguf
  --port 8765
  --ctx-size 16384           # Granite 4.0 Micro supports 128K; 16K is a safe default
  --n-gpu-layers 99          # attempt full GPU offload; auto-fallback to CPU
  --flash-attn               # memory efficiency on supported hardware
  --cache-type-k q8_0        # KV cache quantization
  --cache-type-v q8_0
  --jinja                    # enable Jinja template for chat formatting
  --host 127.0.0.1           # localhost only, never expose to LAN
```

CPU-only fallback: if llama-server exits with a Vulkan/Metal init error, the Rust
layer retries with `--n-gpu-layers 0`.

### Granite 4.0 tool-call output format

Granite 4.0 Micro emits tool calls wrapped in XML tags rather than the standard
OpenAI `tool_calls` array:

```
<tool_call>
{"name": "web_search", "arguments": {"query": "..."}}
</tool_call>
```

When running with `--jinja`, llama.cpp applies the Granite chat template correctly
for *input* formatting. Verify whether your llama.cpp build parses the XML output
tags back into the standard OpenAI response format — behaviour varies by build version.

If `finish_reason` comes back as `"stop"` instead of `"tool_calls"` and the raw
content contains `<tool_call>` blocks, add a fallback parser in the agent loop:

```typescript
// src/lib/agent/parser.ts
export function extractToolCalls(content: string) {
  const calls = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    try {
      calls.push(JSON.parse(match[1]));
    } catch {}
  }
  return calls;
}
```

Test this integration before anything else — it's the most likely early friction point.

Health check: poll `GET http://127.0.0.1:8765/health` until 200 OK before
signalling the frontend that the model is ready.

---

## Agent Loop (TypeScript)

```typescript
// src/lib/agent/loop.ts

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch and extract text from a web page",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"]
      }
    }
  }
];

export async function* runAgentLoop(messages, onSearchStep) {
  while (true) {
    const response = await llamaServer.chat({
      messages,
      tools: TOOLS,
      stream: true
    });

    if (response.finish_reason === "tool_calls") {
      for (const call of response.tool_calls) {
        onSearchStep({ name: call.function.name, args: call.function.arguments, status: "running" });

        let result;
        if (call.function.name === "web_search") {
          result = await invoke("proxy_search", { query: call.function.arguments.query });
        } else if (call.function.name === "fetch_url") {
          result = await invoke("proxy_fetch", { url: call.function.arguments.url });
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: result });
        onSearchStep({ name: call.function.name, status: "done" });
      }
      // continue loop with tool results appended
    } else {
      // stream final answer to UI
      yield response;
      break;
    }
  }
}
```

---

## Model Management

Default model: `granite-4.0-micro-Q4_K_M.gguf` (~2.1 GB)
HuggingFace repo: `unsloth/granite-4.0-micro-GGUF`
HuggingFace URL: https://huggingface.co/unsloth/granite-4.0-micro-GGUF

Released: October 2nd, 2025 — 3B parameter dense transformer, 128K context window,
Apache 2.0 license.

### Available quantizations (all from unsloth/granite-4.0-micro-GGUF)

| Quant | Size | Use case |
|---|---|---|
| `IQ4_XS` | 1.89 GB | Minimum viable — very constrained RAM/VRAM |
| `Q4_K_M` | 2.1 GB | **Default** — best quality/size balance |
| `Q5_K_M` | 2.44 GB | Optional upgrade for users with ≥6GB VRAM |
| `Q8_0` | 3.62 GB | High-quality option for users with ≥6GB VRAM |

Offer `IQ4_XS` as an alternative download in the first-run wizard for users who
flag limited disk space or are on CPU-only hardware.

### First-run flow

1. App opens → check for model file in `appDataDir()/models/`
2. If absent → navigate to `/setup` route
3. Setup wizard: welcome screen → download progress bar → test message → "You're ready"
4. Download via Tauri's `download` plugin with SHA256 verification
5. Allow "Use existing file" picker for users with their own GGUF

### Model storage paths (resolved by Tauri)

- Linux: `~/.local/share/sage/models/`
- macOS: `~/Library/Application Support/sage/models/`
- Windows: `%APPDATA%\sage\models\`

---

## GPU Backend Build Matrix

| Target | GPU API | Build flags |
|---|---|---|
| `x86_64-unknown-linux-gnu` | Vulkan | `cmake -DGGML_VULKAN=ON` |
| `x86_64-pc-windows-msvc` | Vulkan | `cmake -DGGML_VULKAN=ON` |
| `x86_64-apple-darwin` | Metal | `cmake -DGGML_METAL=ON` |
| `aarch64-apple-darwin` | Metal | `cmake -DGGML_METAL=ON` |

Note: macOS does NOT support Vulkan natively. llama.cpp's Metal backend provides
equivalent GPU acceleration on both Intel Macs and Apple Silicon without any
additional driver installation. MoltenVK (Vulkan-on-Metal shim) is explicitly
avoided — it adds complexity with no benefit over native Metal.

Vulkan on Linux/Windows requires the Vulkan runtime (`libvulkan.so` / `vulkan-1.dll`)
which ships with all modern GPU drivers. No special user action needed.

---

## Packaging & Code Signing

### GitHub Actions matrix build

```yaml
# .github/workflows/build.yml
jobs:
  build:
    strategy:
      matrix:
        include:
          - platform: ubuntu-22.04
            args: ''
          - platform: windows-latest
            args: ''
          - platform: macos-latest
            args: '--target aarch64-apple-darwin'
          - platform: macos-latest
            args: '--target x86_64-apple-darwin'
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: tauri-apps/tauri-action@v0
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_PRIVATE_KEY }}
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERT }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          WINDOWS_CERTIFICATE: ${{ secrets.WIN_CERT }}
        with:
          args: ${{ matrix.args }}
```

### Code signing requirements for consumer distribution

| Platform | Requirement | Cost |
|---|---|---|
| macOS | Apple Developer Program + notarization | ~$99/year |
| Windows | EV or OV code signing certificate | ~$200/year |
| Linux | GPG-signed packages (optional but recommended) | Free |

Without signing: macOS Gatekeeper blocks the app, Windows SmartScreen shows a
red warning. Both are showstoppers for non-technical users. Budget for both.

---

## Web Search — Zero Config Design

DuckDuckGo HTML endpoint (no JS, no API key):

```
GET https://html.duckduckgo.com/html/?q=<query>
```

The Tauri `proxy_search` command fetches this URL (bypassing browser CORS),
parses result titles/URLs/snippets from the HTML, and returns JSON to the frontend.
The agent then optionally calls `proxy_fetch` on 2-3 result URLs to get full page
text, which it uses as context for the answer.

Optional upgrade path in settings:
- Tavily API key → better quality, 1000 free searches/month
- Brave Search API key → 2000 free searches/month, more reliable

---

## First-Run Wizard States

```
[Welcome] → [Checking hardware] → [Downloading model] → [Test query] → [Done]
```

- Welcome: "Sage runs entirely on your computer. Nothing you ask leaves your device."
- Hardware check: detect Vulkan/Metal availability, show "GPU acceleration enabled" or
  "Running on CPU (slower but works fine)"
- Download: progress bar, estimated time, cancel option
- Test query: send "Hello! Can you introduce yourself in one sentence?" — proves
  the stack is working before releasing the user to the main UI
- Done: brief tour tooltip overlay

---

## Advanced Config (Stretch Goal)

Hidden behind Settings → Advanced:

- Model selector (switch between downloaded GGUFs)
- Context length slider (2048 – 32768 tokens; model supports up to 128K)
- GPU layers override
- Temperature / top-p sliders
- llama-server port override
- Search provider selector + API key fields
- Log viewer (tail of llama-server stdout/stderr)

Default: all hidden. The app works with zero configuration.

---

## Vane Compatibility Notes

Vane (MIT licensed) provides useful reference for:
- System prompt structure for web research agents
- Tool definitions for search + fetch
- Response formatting instructions

Key differences from Vane:
- Vane runs in Docker with a Node.js backend; Sage is a native Tauri app
- Vane requires Docker setup; Sage is a single installer
- Vane's search uses Tavily by default; Sage defaults to zero-config DDG
- Sage targets smaller models (3B vs 7B+) to support low-VRAM hardware

---

## Recommended First Sprint

1. `npm create tauri-app@latest sage -- --template svelte-ts`
2. Add llama-server Linux binary to `src-tauri/binaries/`, wire up sidecar spawn
3. Implement bare-bones chat UI with streaming — prove the IPC works
4. Add first-run wizard with model download
5. Implement agent loop with DDG search
6. Polish UI to mockup spec
7. Test on Windows VM (WSL2 Vulkan passthrough or native)
8. Set up GitHub Actions matrix build
