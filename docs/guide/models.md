---
title: Models
description: Choosing, downloading and switching local models, context size, response length, reasoning settings, your own server, and OpenRouter.
---

# Models

Haruspex runs a language model on your GPU by default. This page covers which model you get, how to change it, and how to use a model on another server instead.

## Which model fits your hardware

The first-run wizard reads your GPU's memory (VRAM) and recommends a model. It also sets a context size that fits.

| Your GPU | Recommended model | What to expect |
|---|---|---|
| Under 8 GB or integrated | Qwen 3.5 4B | Chat and research work, slowly. Coding struggles. |
| 8 GB | Qwen 3.5 9B | Good research and documents. Coding struggles. |
| 12 GB | Qwen 3.5 9B (Q6) | Same, with better answers. |
| 16 GB | Gemma 4 12B (Q6) | Coding features become usable. |
| 24 GB | Qwen 3.6 35B-A3B or Qwen 3.8 27B | Everything, including coding. |
| 32 GB and up | The same two, at higher quality | The best local quality. |

From 24 GB up there are two choices. Qwen 3.6 35B-A3B is the default and answers faster; Qwen 3.8 27B is a dense model some people prefer. Integrated graphics work but are much slower. Apple Silicon Macs use shared memory, so even an 8 GB M1 should work.

Haruspex uses your GPU heavily. Games and other GPU programs will run worse while it is open.

## Download, switch or delete a model

Go to Settings → Inference → Models. Each model shows its size and a **Download**, **Use** or **Delete** button. The active model is marked **active**. Only one download runs at a time.

**Legacy models** are older choices kept so you can go on using one you already have. They are not suggested for new setups.

To use a GGUF file you already have, run Settings → Inference → **Run Setup Wizard** and choose **Use existing GGUF file**.

**Multi-token prediction** appears for models that support it. It makes replies faster with the same output, costs a little VRAM, and takes effect on the next restart. Turn it off if output looks corrupted.

## Context size: how long a conversation can be

Settings → Inference → Context Size sets how much of the conversation the model can see at once: 8K, 16K, 32K (the default), 64K, 128K or 256K. Bigger needs more VRAM, and changing it restarts the model once any reply in progress finishes. Sizes your GPU cannot hold are greyed out.

- **Let models use system RAM** (off by default) unlocks larger sizes. See below.
- **Keep the vision projector in system RAM** (off by default) frees about 1 GB of VRAM, usually buying a longer conversation. Only messages with an image get slower.

When a conversation gets long, Haruspex summarises older parts so it still fits.

## Run a model bigger than your VRAM

Turn on Settings → Inference → **Let models use system RAM**, or pick the larger model the setup wizard offers. Haruspex keeps what it can in VRAM and moves the rest into system RAM, and the context sizes unlock up to what both can hold. Replies get slower. Qwen 3.6 35B-A3B slows the least, because only a few of its experts run for each word; dense models slow down a lot. It does not help on integrated graphics, which already use system RAM.

## Response length

Settings → Agent → Response Length limits how much the model writes in one reply. This is separate from context size.

- **Max response tokens** — normal chat, shell and agent turns (default 8192).
- **Max response tokens (file writes)** — turns that write a whole file (default 65536).

If a reply hits the limit, Haruspex tells you and does not write a half-finished file. Raise the limit or ask for a smaller piece of work.

## Reasoning (thinking)

In Settings → Agent → Behavior:

- **Reasoning mode** (on by default) lets the model think before it answers. It helps with code and multi-step tasks but uses more of the context. Turn it off for light chat.
- **Reasoning effort** (default medium) sets how long it thinks. Not every model accepts an effort level; where it is not understood it is ignored. A high level can make a long coding task run out of room.

## Use your own server

If you already run an OpenAI-compatible server (llama.cpp, LM Studio, Ollama, vLLM, Lemonade and others), pick **Remote server (advanced)** in Settings → Inference → Inference backend, or **Connect to an existing server** in the wizard.

Enter the **Server URL** and an optional **API Key**, then press **Probe connection**. Haruspex finds the models and, where the server reports them, the context size and image support. Otherwise fill these in yourself. Turn on **Allow parallel inference** only if your server handles several requests at once.

Switching to a remote server stops the local model to free VRAM; **Local** starts it again. Remote server and OpenRouter each keep their own address, key and model.

The built-in model server answers only Haruspex. To share a model with other apps, run your own server and point Haruspex at it.

## OpenRouter (cloud)

**OpenRouter (cloud)** gives access to hundreds of large hosted models. **Your prompts and the model's answers leave your device** and are handled by OpenRouter and the model provider under their privacy policies. It is off by default and labelled while in use.

Add an API key from openrouter.ai/keys, press **Load models**, and pick one. Keep **Only show models that support tool calling** on; the assistant needs tools.

## Different models for different jobs

Each job can use its own model or server, so a heavy job can go to a big remote model while your local model serves Chat and Shell. See the `jobs` page.

## Features that need a bigger model

The Code tab, the Shell's Full access, guided planning, autonomous coding, audit jobs and the Python sandbox ask the model to write code. The 4B and 9B models are weak at coding, so these often fail on them. They become usable at 16 GB and work well at 24 GB, or on a bigger remote model. See the `troubleshooting` page for small-model limits.
