---
title: Specialists
description: Specialist models in the Code tab — small models tuned for one job (text, 3D assets as GLB) that the coding agent hands work to, how to add one and turn it on.
---

# Specialists

A specialist is a small model tuned for one narrow job, such as writing SQL or turning a request into a 3D scene. In the Code tab, the coding agent can hand that job to a specialist with the `ask_specialist` tool and carry on with what comes back. The agent decides when to use one; you ask as usual. For the Code tab itself, see the `code` page.

You run the specialist's server yourself: llama-server, llama-toolchest, Lemonade or any OpenAI-compatible server. Haruspex never downloads or starts a specialist model.

## Add a specialist

In Settings → Code → Specialists, pick a kind from **Add specialist…**, then fill in:

- **Name**: what the agent calls it. Each name is used once.
- **Server**: the server's address, such as `http://localhost:8080`. **API key** picks a key from Settings → Inference → API Keys if the server needs one.
- **Model**: the model's id on that server. **Fetch** lists the ids the server offers.
- **Description**: tells the agent when to use it. Empty uses the kind's own.
- **System prompt**: sent before every request. It starts as the kind's prompt; **Reset** puts that back. Tick **Send no system prompt** when the server sets the prompt itself.
- **Sampling**: temperature, top-p, top-k, min-p and max tokens. Empty fields use the kind's values, shown in grey.
- **Thinking**: **On**, **Off** or the kind's default. Some small models think until they run out of tokens and never answer; turn it off for those.
- **Accepts images**: tick it when the server has the model's vision projector loaded.

**Test** sends a one-line request and shows the first line of the answer, or the error. **Save** keeps the specialist; **Cancel** drops your changes.

## Turn specialists on for a session

A Code session offers the agent only the specialists that are on for it. **Specialists: N** in the session's header opens a list with a checkbox for each one; a change applies from the next message. **Use defaults** goes back to the ones ticked **On by default** in Settings → Code → Specialists, which is what a new session starts with. The menu is hidden while you have no specialists.

A read-only session can't use a specialist that writes files.

## Send a reference image

When a specialist has **Accepts images** on, the agent can send up to three images from the project folder with a request: PNG, JPEG or WebP, up to 8 MB each. Ask for it in your message ("make a scene like `refs/tree.png`").

## Kinds

- **Text**: sends the request and hands the answer back to the agent as text, cut at 24,000 characters. Use it for any model that answers in text.
- **3D asset (GLB)**: for a model that writes a Three.js page with an Export GLB button, such as `ccore/Qwen3.5-4B-GLB-3D-Coder`. The agent gives a path ending in `.glb`; the page is saved beside it as `<name>.glb.html`, run hidden in the app, and its export checked: the GLB has to load, have meshes and no broken geometry. When that passes, the GLB is written and, if the agent's model can see images, it gets a render to judge. When it fails, the agent gets every error with its line, fixes the `.glb.html` and asks for a recheck, which runs the page again without a new request. The page loads Three.js from a CDN, so it needs the network.

New kinds come with the app; Settings can't define one.

## What it doesn't do

- Specialists work only in the Code tab, not in Chat, the Shell, jobs or subtasks.
- Haruspex doesn't download, install or run specialist models.
- The agent sees what the specialist returns, not its reasoning.
