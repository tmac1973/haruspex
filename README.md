# Haruspex

Click this screenshot to watch the explainer video:

[![Watch the video](https://img.youtube.com/vi/VT-gGdOAonA/maxresdefault.jpg)](https://youtu.be/VT-gGdOAonA)

Haruspex is a desktop AI researcher and coding tool that runs entirely local by default. It works on Linux, Windows and macOS. There is no account to create and no telemetry. Your conversations and the model's answers stay on your device. You do not need a separate inference server (ollama, LMStudio, Lemonade, vLLM, etc...) as Haruspex will default to automatically downloading an appropriate model for your system and will run it locally. If you prefer to manage your own llms you can turn this off and use a remote model instead.

The **[user guide](https://tmac1973.github.io/haruspex/guide/)** explains every feature and setting. Haruspex reads the same guide to answer questions about itself.

## Goals

- **Privacy** — Your conversations and the model run on your machine. Searches do hit the web, but HTTP proxies and SearXNG are supported so you can hide where they come from.
- **Open Source / Open Weight** — Open weight models mean no monthly bill and no vendor lock-in.
- **Consumer Hardware** — We target normal consumer graphics, from integrated graphics up to 32 GB discrete GPUs. The app looks at your hardware on first run and suggests a model that fits.

  On 8 GB or less you get Qwen 3.5 9B (or Qwen 3.5 4B if memory is tight). These small models are remarkably capable for their size and they do research well, though they aren't great at coding tasks.

  The coding features — Code mode in the Shell tab, guided planning, autonomous coding, audit jobs, and the Python sandbox in the Chat tab — will work much better with a bigger model. We recommend **Qwen 3.6 35B-A3B** or **Qwen 3.8 27B**, which need at least 16 GB of VRAM but better quantizations are available for those with 24 and 32 GB of VRAM. You can also point those features at a bigger model on another machine, or at OpenRouter (though you lose the privacy of running locally).

- **Human Enablement, Not Human Replacement** — Many projects are building fully autonomous agents that replace people. This is not one of them. Haruspex is meant to help you learn, create, and fix things, with you still in the chair.

## Features

### Chat

- **Web research** — Ask a question, and it searches the web, reads the results and answers. Turn on **deep research** for a slower, more thorough answer that uses more sources.
- **Files (you opt in)** — Pick a working directory in the chat tab and the model can read and write files there, and only there. It handles text, PDF, Word, Excel, PowerPoint, OpenDocument and images. Great for creating reports from your research. ([details](https://tmac1973.github.io/haruspex/guide/chat/))
- **Python sandbox** — The model can write and run Python inside the app, in a sandboxed Pyodide environment. It can install packages on demand and make HTTP requests. Use it to make charts, do maths, or build documents. It is on by default and asks once per chat before running code; Settings → Agent → Python Sandbox can make it ask every time, or turn it off. Works best with a larger model.
- **Pictures in answers** — With **Include images in answers** on (Settings → Agent → Pictures in answers), answers about visual things — a place, an animal, an object, a person — come with one to three relevant pictures. They come from Openverse, Wikimedia Commons and Wikipedia, and each one shows who made it and under what licence. Haruspex downloads them itself, so the site never sees your computer, and it keeps them on this device. Small models often look for a picture and then forget to put it in the answer, so when that happens the pictures it found appear under the answer instead of beside the paragraph — you still get them.
- **Vision** — Show it an image or a scanned PDF and it can describe or read it.
- **Voice** — Speak your question with push-to-talk, and have answers read aloud.
- **Memory** — Haruspex quietly reads your finished conversations, keeps the stable facts (your preferences, your corrections, ongoing project details) and brings the relevant ones into later chats. You can also just say "remember that…". What it remembers is stored only on this device. The pass that picks out facts runs on the same model as Chat, so with a remote server or OpenRouter your conversation goes there for that, as it does when you chat. You can mark a single chat as incognito, and you can read, edit or delete anything it remembered. ([details](https://tmac1973.github.io/haruspex/guide/memory/))
- **Open in shell** — If an answer ends with "run this command", press the `>_` button to open the whole conversation in a new Shell tab, where the commands become buttons you can run.
- **Remote access (off by default)** — Let other devices on your home network chat with your Haruspex through a web page, using your computer's GPU. Useful when your main machine is busy with a game and you want to ask a question from a phone or laptop. Share a link or scan a QR code. ([details](https://tmac1973.github.io/haruspex/guide/remote-access/))
- **Email (off by default)** — Connect an IMAP account (Gmail, Fastmail, iCloud, Yahoo or custom) so the model can summarise and search your recent messages. Turn on **Allow sending** and it can also draft replies and new mail — but every draft opens for you to edit, and only your click on Send sends it. ([details](https://tmac1973.github.io/haruspex/guide/integrations/))
- **Calendar and contacts (off by default, read-only)** — Connect a CalDAV/CardDAV account (Nextcloud, Fastmail, iCloud, Radicale, Baikal, Synology), sign in with Google, or paste a calendar link (Outlook, iCloud) and ask what is on this week or how to reach someone. ([details](https://tmac1973.github.io/haruspex/guide/integrations/))
- **MCP integrations (off by default)** — Connect other services through MCP servers. Haruspex installs and runs them itself, so you never need a terminal. ([details](https://tmac1973.github.io/haruspex/guide/integrations/))
- **Screen capture (off by default)** — Ask about what is on your screen. There is also a camera button in the chat box for attaching a screenshot yourself. ([details](https://tmac1973.github.io/haruspex/guide/integrations/))
- **Conversations are saved** — Chat history lives in a local SQLite database and survives restarts.

### Shell

- **A real terminal** _(Linux, macOS and Windows — PowerShell and WSL2 on Windows)_ with an assistant beside it. Open several shell tabs at once.
- **Send output to the assistant** — One click (or `F4`) sends recent commands and their output to the assistant to explain.
- **Read-only by default** — The assistant can read config files and logs anywhere on your system and suggest fixes, but it never runs anything. Suggested commands appear as cards you click to paste at your prompt. Risky patterns (`sudo`, `rm -rf`, `dd of=`, `curl | sh`, `Remove-Item -Recurse -Force`) get a red chip.
- **Code mode (off by default)** — Turn it on per session to let the assistant edit files and **run commands in your live terminal**. Commands it considers risky stop and ask you first; commands it considers safe run on their own. ⚠️ Please read the [AI safety disclaimer](#ai-safety-disclaimer) first. This is a coding feature — expect much better results with a larger model.
- **Repo instructions** — In a git repo with an `AGENTS.md` (or `CLAUDE.md`), the assistant reads it into every turn, so it knows how the project builds, tests and lints. The first time, it asks whether you trust the repo; a badge in the sidebar shows when the file is in use, and lets you stop using it. ([details](https://tmac1973.github.io/haruspex/guide/skills/))
- **Memory limit** _(Linux)_ — Each Shell tab's terminal, and every command the assistant runs on its own, can use at most half your RAM by default (Settings → Shell → Memory limit). A runaway build or test is stopped before it takes the app or your desktop down, the shell around it keeps going, and the assistant is told why so it looks for the bug instead of re-running it.

### Skills and repo instructions

- **Skills** — Folders of instructions for a task, in the open [Agent Skills](https://agentskills.io) format other AI tools use. A skill written for another tool usually works unchanged. ([details](https://tmac1973.github.io/haruspex/guide/skills/))
- **Run one by name** — Type `/` in Chat or Shell for a list of your skills, then `/name what you want`. Works on any model. `/new` starts over and `/skills` lists what you have.
- **Let the model pick** — With Settings → Skills → "When the model uses skills" on, the model sees your skills and loads one when a request matches. Automatic turns this on for remote models only, since small local models handle it poorly.
- **Save a procedure as a skill** — Ask "save what we just did as a skill called deploy-check". The model drafts it, and nothing is written until you have read it, edited it if you like, and approved it.
- **`/init`** — In Code mode, drafts a short `AGENTS.md` for a repo from its manifests, CI and README, for you to review before it is saved.
- **Planning skills** — Pick one when you create a guided planning job (2D game, 3D game, web app, CLI tool, API service), and the interview asks the questions that matter for that kind of project — the window and camera for a game, sign-in and storage for a web app — and the plan is checked against its requirements.

### Jobs and schedules

Save a prompt once and run it again later, by hand or on a schedule, without sitting there. There are five kinds of job: **research**, **audit**, **guided planning**, **autonomous coding** and **asset generation**. Each job can use its own model, so you can send a heavy job to a big remote model while your local model keeps serving the Chat and Shell tabs. ([details](https://tmac1973.github.io/haruspex/guide/jobs/))

Audit, guided planning and autonomous coding are coding-focused. They need a larger model to be useful.

### Image generation (off by default)

- **Pictures in Chat** — Ask Chat to draw something and the picture appears in the answer, and stays with the conversation. ([details](https://tmac1973.github.io/haruspex/guide/images/))
- **Art for the project you are coding** — In the Shell's Code mode, ask for "a 32 px coin sprite in assets/" and the assistant writes a finished sprite, icon or tiling texture into your project, made the same way the asset job makes them. It can match the colours of an asset you already have.
- **Game art from a description** — The asset generation job draws a project's sprites, icons and tiling textures in one consistent style, checks each one, and writes them into the project. Guided planning can hand off to it and then to autonomous coding, so you can go from an idea to a game with its own art in one unattended run. ([details](https://tmac1973.github.io/haruspex/guide/images/))
- **Runs on your machine** — Either a [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server you run, or a bundled engine that needs nothing installed. Nothing starts until you pick one in Settings → Image.

### Where the model runs

- **Local (default)** — A bundled `llama-server` runs the model on your GPU. Vulkan on Linux and Windows, Metal on macOS.
- **Your own server** — Point Haruspex at any OpenAI-compatible server you already run (llama.cpp, LM Studio, Ollama, vLLM and others). ([details](https://tmac1973.github.io/haruspex/guide/models/))
- **OpenRouter (cloud, off by default)** — ⚠️ **This one is not local and may not be private.** Your prompts leave your device and go to OpenRouter's servers, under whatever privacy policy OpenRouter and the model provider have. We include it anyway because some people want access to large frontier models — especially for the coding features —. Add your API key in Settings → Inference and pick from around 300 models. It stays off until you turn it on, and the app labels it clearly while it is on. Local inference is still the recommended setup for privacy.

### Other

- **First-run wizard** — Checks your hardware and downloads a model that fits.
- **Log viewer** — Copy the logs of each background process from the toolbar, so bug reports are easy.
- **Dark mode** — Follows your system, or set it yourself.

## AI safety disclaimer

> [!WARNING]
> **Haruspex is an AI assistant, and AI models hallucinate. Check before you act.**
>
> The model can be confidently wrong. It can invent facts, misread a file or some command output, and — this matters most in the **Shell tab** — suggest commands that are wrong, dangerous or destructive (deleting data, changing system settings, exposing secrets). The small local models this project targets make these mistakes more often than large cloud models do.
>
> Haruspex is built around **human enablement, not human replacement**. By default the Shell assistant is **read-only** and runs nothing: every command it suggests lands at your prompt for you to read and run yourself, with risky patterns (`sudo`, `rm -rf`, `dd of=`, `curl | sh`, …) flagged. But if you turn on **Code mode**, the assistant **runs commands itself in your live terminal**. Commands it flags as risky stop and ask you first, but anything it considers safe runs on its own — and you can even turn that prompt off in Settings. Code mode is off by default and you turn it on per session. Only turn it on for machines and projects you are willing to let the model touch. These flags and prompts help, but they are not a guarantee. **You are the last line of defence.**
>
> Before running anything the model suggests:
>
> - Read the command and understand it. If you do not understand it, do not run it.
> - Take extra care with commands that delete files, change system settings, pipe a download into a shell, or touch passwords and keys.
> - Keep backups of anything you cannot afford to lose.
>
> Haruspex is provided "as is", without warranty of any kind. You use it — and any command or output it produces — **at your own risk**. The authors and contributors are not liable for any damage, data loss or other harm that comes from using it. See the [License](#license) for the full disclaimer.

## Installing

Download the latest release for your platform from the [Releases](https://github.com/tmac1973/haruspex/releases) page.

> **Note on code signing:** Haruspex binaries are **not code-signed on macOS or Windows**. macOS Gatekeeper will refuse to open the app directly, and Windows SmartScreen will warn you before running the installer. See the notes below for how to get past these warnings.

### Debian / Ubuntu

```bash
# The .deb package handles most dependencies automatically
sudo apt install libwebkit2gtk-4.1-0 libayatana-appindicator3-1
```

### Fedora

```bash
# The .rpm package handles most dependencies automatically
sudo dnf install webkit2gtk4.1 libappindicator-gtk3
```

### Arch / CachyOS

```bash
# Use the .AppImage — no package manager dependencies needed
chmod +x Haruspex_*.AppImage
./Haruspex_*.AppImage
```

### Windows

Run the `.msi` or `.exe` installer. The MSVC runtime is included — nothing else to install.

Because the installer is **not code-signed**, Windows SmartScreen shows a "Windows protected your PC" warning. Click **More info → Run anyway**.

### macOS

Open the `.dmg` and drag Haruspex to Applications. Because the app is **not code-signed**, right-click it the first time and choose **Open** to get past Gatekeeper.

## Hardware requirements

Haruspex runs the model on your GPU. How much VRAM you have decides which model you get and how well the coding features work.

| Your GPU          | Model you get                                                          | What to expect                                                            |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Under 8 GB / iGPU | Qwen 3.5 4B                                                            | Chat, research and documents work. Slower. Coding features will struggle. |
| 8 GB              | Qwen 3.5 9B                                                            | Good research and document work. Coding features will struggle.           |
| 12 GB             | Qwen 3.5 9B (Q6)                                                       | Same abilities, better quality answers.                                   |
| 16 GB             | Gemma 4 12B (Q6)                                                       | Coding features become usable, with room for very long conversations.     |
| 24 GB             | Qwen 3.6 35B-A3B _or_ Qwen 3.8 27B                                     | Everything, including the coding features.                                |
| 32 GB and up      | The same two models, at higher-quality quants                          | The best local quality Haruspex offers.                                   |

The first-run wizard picks one of these for you. You can change it later in Settings → Inference → Models, and re-run the wizard from Settings → Inference.

**From 24 GB up, each tier offers two models.** The default is the sparse mixture-of-experts model, which activates only a fraction of its parameters per token and so answers faster; the alternative is a dense model of similar size, which some people prefer. Both are listed in Settings → Inference → Models with their sizes.

**Why a 12B at 16 GB and not something bigger?** A bigger model has to fit its weights *and* the conversation in the same VRAM, and the conversation is not free. Gemma 4 12B keeps only 8 of its 48 attention layers at full range, so its share of the memory grows about four times more slowly per word than a 27B's — which is what lets this tier hold a very long conversation instead of spending everything on parameters and running out of room mid-task.

**Short on VRAM?** Settings → Inference has an option to keep the vision projector in system RAM. The projector only does work on messages that actually contain an image, so moving it out of VRAM buys a longer conversation — up to twice as much on the 8 GB tier, where it is the largest. Messages with images take a few seconds longer to process; nothing else changes.

**Integrated graphics** (Intel HD/UHD/Iris, AMD Vega/Radeon Graphics) will work, but much more slowly. Recent AMD APUs do better than older Intel iGPUs, and both are well behind a discrete card.

**Apple Silicon** Macs use unified memory and Metal, so even a base M1 with 8 GB should work, though more recent "Pro" Apple CPUs will be much faster.

**If you want the coding features but have a less capable local GPU:** point Haruspex at a bigger model on another machine ([remote inference](https://tmac1973.github.io/haruspex/guide/models/)), or use [OpenRouter](#where-the-model-runs) and accept that those prompts leave your device.

> [!WARNING]
> **Haruspex uses your GPU.** While it is running, games and other GPU-heavy programs will be impacted, especially if you don't have enough VRAM to hold both the llm and your other programs resources. Close Haruspex before you play.

## User guide

Everything about using Haruspex is in the **[user guide](https://tmac1973.github.io/haruspex/guide/)**, which is also built into the app: ask the assistant how something works, or press **F1** for the shortcuts and a link to the guide.

- [Getting started](https://tmac1973.github.io/haruspex/guide/) — first run, the tabs, where to go next
- [Models](https://tmac1973.github.io/haruspex/guide/models/) — choosing a model for your hardware, your own server, OpenRouter
- [Chat](https://tmac1973.github.io/haruspex/guide/chat/) — web research, files, the Python sandbox, pictures, voice
- [Shell and Code mode](https://tmac1973.github.io/haruspex/guide/shell/) — the terminal, the assistant, Code mode, command approval, the memory limit
- [Skills](https://tmac1973.github.io/haruspex/guide/skills/) — skills, `/name`, `AGENTS.md`, repo trust, `/init`
- [Jobs](https://tmac1973.github.io/haruspex/guide/jobs/) — research, audit, guided planning, autonomous coding, asset generation, schedules
- [Memory](https://tmac1973.github.io/haruspex/guide/memory/) — what is remembered, approval, duplicates, privacy
- [Image generation](https://tmac1973.github.io/haruspex/guide/images/) — ComfyUI or the bundled engine, models and licences
- [Integrations](https://tmac1973.github.io/haruspex/guide/integrations/) — email, calendar and contacts, MCP servers, screen capture
- [Search and network](https://tmac1973.github.io/haruspex/guide/search-and-network/) — search providers, proxies, sandbox network access
- [Remote access](https://tmac1973.github.io/haruspex/guide/remote-access/) — chatting with this Haruspex from other devices
- [Settings](https://tmac1973.github.io/haruspex/guide/settings/) — every Settings section
- [Keyboard shortcuts](https://tmac1973.github.io/haruspex/guide/shortcuts/)
- [Troubleshooting](https://tmac1973.github.io/haruspex/guide/troubleshooting/) — known issues, small-model limits, logs, reporting a bug

The guide's source is [`docs/guide/`](./docs/guide/). Setup notes for developers are in [`docs/`](./docs/): image generation (including the asset spec format and ComfyUI setup), Google sign-in, and testing.

## Development

### Build prerequisites

Each block below installs **everything** you need to build Haruspex on that platform — system libraries, the Vulkan shader tools, Rust (stable) and Node.js (22+). Copy and run the whole block.

#### Debian / Ubuntu

```bash
# System libraries + Vulkan shader toolchain
sudo apt update && sudo apt install -y build-essential cmake pkg-config curl \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libasound2-dev libxcb1-dev \
  libvulkan-dev glslc spirv-headers libsonic-dev libpcaudio-dev libssl-dev libfuse2

# Node.js 22 (distro packages are usually too old)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs

# Rust (stable, via rustup)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
```

#### Fedora

```bash
# System libraries + Vulkan shader toolchain + Node.js
sudo dnf install -y @development-tools cmake pkg-config \
  webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel alsa-lib-devel libxcb-devel \
  vulkan-headers spirv-headers glslc sonic-devel pcaudiolib-devel openssl-devel nodejs npm

# Rust (stable, via rustup)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
```

#### Arch / CachyOS

```bash
# Everything in one command. spirv-headers is required by llama.cpp's Vulkan
# backend and is NOT pulled in by shaderc, so it must be listed explicitly.
sudo pacman -S --needed base-devel cmake pkg-config \
  webkit2gtk-4.1 libayatana-appindicator librsvg alsa-lib libxcb \
  vulkan-headers shaderc spirv-headers fuse2 libsonic pcaudiolib rust nodejs npm
```

#### Windows

On a fresh Windows 11 install, run the included PowerShell setup script from a normal PowerShell window. It installs Git, Node.js LTS, the Rust MSVC toolchain, VS 2022 Build Tools, CMake, the Vulkan SDK and the WebView2 runtime with `winget`, and skips anything you already have:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\windows-setup.ps1
```

When it finishes, **open a new terminal** so the PATH changes take effect. Sidecar builds run from Git Bash with `./scripts/dev-setup.sh`.

If you would rather install the prerequisites yourself: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload), [CMake](https://cmake.org/download/), [Vulkan SDK](https://vulkan.lunarg.com/), [Git for Windows](https://git-scm.com/download/win).

#### macOS

```bash
# Command Line Tools, then system libraries + Rust + Node via Homebrew
xcode-select --install
brew install cmake pkg-config opus rust node
```

> Prefer to manage Rust yourself? Skip `rust` above and use [rustup](https://rustup.rs/).

### Dev setup

```bash
git clone https://github.com/tmac1973/haruspex.git
cd haruspex

# Required on the first run. This builds the sidecars and downloads the other
# resources the app needs — ruff, PDFium and the Pyodide runtime. `make dev`
# only checks the sidecars, so it does NOT replace this step.
./scripts/dev-setup.sh

# Run the app (after the first time, this is all you need)
make dev
```

### Test machines

A Mac and a Windows PC can be set up as test machines, with suites run on them
from Linux over SSH. Setup is two scripts per machine; see
[`scripts/ci-runner/README.md`](./scripts/ci-runner/README.md).

### CI

Every pull request runs the Linux lint, type-check and test jobs. The Windows and macOS jobs are slow, so they run after every merge to `main`, from **Actions → CI → Run workflow**, or on a pull request labelled `windows-ci` or `macos-ci` — adding the label starts that job straight away.

### Make targets

Run `make help` to see all targets:

| Target               | Description                                                         |
| -------------------- | ------------------------------------------------------------------- |
| `make dev`           | Run the app in dev mode (checks sidecars; run `dev-setup.sh` first) |
| `make check`         | Run all checks (lint, format, typecheck, test)                      |
| `make fmt`           | Auto-format all code (Prettier + cargo fmt)                         |
| `make sidecars`      | Build sidecar binaries (llama-server, whisper-server, koko)         |
| `make app`           | Build the Tauri app packages (needs sidecars)                       |
| `make release-local` | Build everything: sidecars + app packages                           |
| `make clean`         | Remove built sidecars, forcing a rebuild                            |
| `make clean-all`     | Remove sidecars + Rust/frontend build artifacts                     |
| `make reset-data`    | Remove all app data (models, db) for a fresh start                  |

### Data directory

| Platform | Path                                              |
| -------- | ------------------------------------------------- |
| Linux    | `~/.local/share/com.haruspex.app/`                |
| macOS    | `~/Library/Application Support/com.haruspex.app/` |
| Windows  | `%APPDATA%\com.haruspex.app\`                     |

Use `make reset-data` to wipe this directory and start fresh (Linux/macOS).

## Tech stack

| Component                  | Technology                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App framework              | [Tauri 2.x](https://v2.tauri.app/) (Rust backend, system webview)                                                                                                               |
| Frontend                   | [SvelteKit 5](https://svelte.dev/) (TypeScript, static SPA, Svelte 5 runes)                                                                                                     |
| LLM inference              | [llama.cpp](https://github.com/ggml-org/llama.cpp) (Vulkan/Metal, with image support via mmproj)                                                                                |
| Speech-to-text             | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (Vulkan/Metal)                                                                                                           |
| Text-to-speech             | [Kokoros](https://github.com/lucasjinreal/Kokoros) (CPU)                                                                                                                        |
| Models (small)             | [Qwen 3.5 4B](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF) and [Qwen 3.5 9B](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF)                                                 |
| Models (16 GB and up)      | [Gemma 4 12B](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF), [Qwen 3.6 35B-A3B](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF) and [Qwen 3.8 27B](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF) |
| Image generation           | [ComfyUI](https://github.com/comfyanonymous/ComfyUI) (yours) or [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) (bundled, Vulkan/Metal); Ming-Image 0.1 Design and Qwen-Image 2.1 |
| Python sandbox             | [Pyodide](https://pyodide.org/) running in the app's webview                                                                                                                    |
| PDF text extraction        | [PDFium](https://github.com/bblanchon/pdfium-binaries) with custom layout reconstruction                                                                                        |
| PDF rendering (for vision) | [PDF.js](https://mozilla.github.io/pdf.js/) running in the Tauri webview                                                                                                        |
| PDF creation               | [printpdf](https://crates.io/crates/printpdf) (pure Rust)                                                                                                                       |
| docx / xlsx                | Custom zip+XML for docx reads/writes, [calamine](https://crates.io/crates/calamine) for xlsx reads, [rust_xlsxwriter](https://crates.io/crates/rust_xlsxwriter) for xlsx writes |
| odt / ods / odp / pptx     | Hand-written zip+XML following the OASIS OpenDocument and OOXML specs                                                                                                           |
| MCP client                 | [rmcp](https://crates.io/crates/rmcp) (stdio and streamable HTTP), with [node](https://nodejs.org/) and [uv](https://github.com/astral-sh/uv) bundled to run servers |
| Email                      | [async-imap](https://crates.io/crates/async-imap) and [mail-parser](https://crates.io/crates/mail-parser) for reading, [lettre](https://crates.io/crates/lettre) for sending, [keyring](https://crates.io/crates/keyring) for the system keychain |
| Calendar / contacts        | CalDAV and CardDAV over [quick-xml](https://crates.io/crates/quick-xml), with [rrule](https://crates.io/crates/rrule) for recurrence |
| Screen capture             | XDG desktop portal on Linux ([ashpd](https://crates.io/crates/ashpd)), [xcap](https://crates.io/crates/xcap) on macOS and Windows |
| Database                   | SQLite (via rusqlite)                                                                                                                                                           |
| Web search                 | Rotation of free engines, Brave Search API, SearXNG, or a local Chrome/Chromium                                                                                                 |

## Building a release

Releases are automated with [release-please](https://github.com/googleapis/release-please):

1. Commits on `main` must use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `feat!:` for breaking changes).
2. release-please keeps a pull request open, titled "chore(main): release X.Y.Z", that bumps the versions, updates `CHANGELOG.md` and collects the notes from each new commit.
3. Merge that PR to cut a release. That creates the `vX.Y.Z` tag and a draft GitHub release with the changelog already filled in.
4. Pushing the tag runs the `Release` workflow, which builds the sidecars and the app for every platform and attaches the installers (Linux AppImage/deb/rpm, Windows NSIS/MSI, macOS DMG) to the draft.
5. Review the draft and click **Publish**.

To build locally: `make release-local`.

## Credits

The Haruspex application icon comes from a photograph of the **Piacenza Bronze Liver** by **Lokilech**, from [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Piacenza_Bronzeleber.jpg), used under the [Creative Commons Attribution-ShareAlike 3.0 Unported](https://creativecommons.org/licenses/by-sa/3.0/) licence. See [`NOTICE.md`](./NOTICE.md) for details.

## License

Copyright © 2025–2026 Tim MacDonald.

Haruspex is free software: you can redistribute it and modify it under the terms of the **GNU General Public License version 3**, or (at your option) any later version, as published by the Free Software Foundation. The full text is in [`LICENSE`](./LICENSE).

In plain terms: you can use it, read it, change it and share it. If you share a changed version, that version has to be free software too, under the same licence, with its source available and the original credit kept.

Haruspex is distributed in the hope that it will be useful, but **WITHOUT ANY WARRANTY** — without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See sections 15 and 16 of the GNU General Public License for details.

The application icon is licensed separately under CC BY-SA 3.0. See [`NOTICE.md`](./NOTICE.md).

> Versions up to and including v0.1.61 were released under the MIT licence. That does not change retroactively — the licence applies from this commit onward.
