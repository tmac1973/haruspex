---
title: Models
description: Choosing, downloading and switching local models, context size, response length, reasoning settings, your own server, and OpenRouter.
---

# Models

Haruspex runs a model on your GPU by default.

## Which model fits your hardware

The first-run wizard reads your GPU's memory (VRAM) and recommends a model and context size. On a Mac it counts the GPU's share of memory, less what other apps hold. A model already on disk is marked "(downloaded)"; **Use This Model** skips the download.

| Your GPU | Recommended model | What to expect |
|---|---|---|
| Under 8 GB or integrated | Qwen 3.5 4B | Chat and research work, slowly. Coding struggles. |
| 8 GB | Qwen 3.5 9B | Good research and documents. Coding struggles. |
| 12 GB | Qwen 3.5 9B (Q6) | Same, with better answers. |
| 16 GB | Gemma 4 12B (Q6) | Coding features become usable. |
| 24 GB | Qwen 3.6 35B-A3B or Qwen 3.8 27B | Everything, including coding. |
| 32 GB and up | The same two, at higher quality | The best local quality. |

From 24 GB up, Qwen 3.6 35B-A3B is the default and answers faster; Qwen 3.8 27B is dense, and some prefer it. Even an 8 GB M1 Mac should work.

Haruspex uses your GPU heavily, so games run worse alongside it.

## Download, switch or delete a model

Settings → Inference → Models lists each model's size with a **Download**, **Use** or **Delete** button; the active one is marked **active**. Only one download runs at a time.

**Legacy models** are older choices, not for new setups.

To use a GGUF file you already have, run Settings → Inference → **Run Setup Wizard** and choose **Use existing GGUF file**.

**Multi-token prediction** appears for models that support it. It speeds up replies with the same output, costs a little VRAM, and applies on the next restart. Turn it off if output looks wrong.

## Context size: how long a conversation can be

Settings → Inference → Context Size sets how much of the conversation the model can see at once: 32K (the default), 64K, 128K or 256K. Bigger needs more VRAM, and changing it restarts the model once any reply finishes. Sizes your GPU cannot hold are greyed out.

- **Let models use system RAM** (off by default) unlocks larger sizes. See below.
- **Keep the vision projector in system RAM** (off by default) frees about 1 GB of VRAM, usually buying a longer conversation. Only messages with an image get slower.

Haruspex summarises the older parts of long chats and Code sessions so they fit. If a new chat says the context is too small for its instructions and tools, raise it.

## Run a model bigger than your VRAM

Turn on Settings → Inference → **Let models use system RAM**, or pick the larger model the setup wizard offers. Haruspex keeps what it can in VRAM and moves the rest to system RAM, so context can grow to what both hold. Replies get slower. Qwen 3.6 35B-A3B slows the least; dense models slow down a lot. It does not help on integrated graphics, which already use system RAM.

## Response length

Settings → Inference → Model defaults limits how much the model writes in one reply, in every tab.

- **Max response tokens** — Chat, the Shell's Read-only assistant and jobs (default 8192).
- **Max response tokens (file writes)** — a chat that writes a file, the Code tab and the Shell's Full access (default 65536).

A reply that hits the limit is reported; a file is never half-written.

## Reasoning (thinking)

In Settings → Inference → Model defaults (a Shell tab's Think toggle, a Code session or a job can override):

- **Reasoning mode** (on by default) lets the model think before it answers. It helps with code and multi-step tasks but uses more context.
- **Reasoning effort** (default medium) sets how long it thinks; models without effort levels ignore it. A high level can make a long coding task run out of room.

## Use your own server

If you already run an OpenAI-compatible server (llama.cpp, LM Studio, Ollama, vLLM, Lemonade and others), pick **Remote server (advanced)** in Settings → Inference → Inference backend, or **Connect to an existing server** in the wizard.

Enter the **Server URL** and an optional **API Key**, then press **Probe connection**. Haruspex finds the models and, where reported, their context size and image support; otherwise fill these in. Turn on **Allow parallel inference** only if your server handles several requests at once.

Switching to a remote server stops the local model to free VRAM; **Local** starts it again. Remote server and OpenRouter each keep their own address, key and model.

At startup Haruspex checks that the server or OpenRouter still has your model. If not, the status badge reads **Model not found** (or **Unreachable**); click it to pick one in Settings → Inference. Haruspex never changes the model itself.

The built-in model server answers only Haruspex. To share a model with other apps, run your own server.

## OpenRouter (cloud)

**OpenRouter (cloud)** gives access to hundreds of large hosted models. **Your prompts and the model's answers leave your device** and are handled by OpenRouter and the model provider under their privacy policies. It is off by default and labelled while in use.

Add an API key from openrouter.ai/keys, press **Load models**, and pick one. Keep **Only show models that support tool calling** on; the assistant needs tools.

A reasoning model's conversation stays with the provider that wrote its reasoning. If that provider is rate-limited, Haruspex waits up to two minutes with a notice; then try later or switch models.

## Different models for different jobs

Each job can use its own model or server, so a heavy job can go to a big remote model while your local model serves Chat and Shell. See the `jobs` page.

## Features that need a bigger model

The Code tab, the Shell's Full access, guided planning, autonomous coding, audit jobs and the Python sandbox write code. The 4B and 9B models often fail at these. See the `troubleshooting` page.
