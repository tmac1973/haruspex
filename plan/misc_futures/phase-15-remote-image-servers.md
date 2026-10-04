# Phase 15 — Image generation on other servers

Depends on: 07 (the image tool), 10 (the secret store, for an API key) /
Enables: —

## Goal

Two more places to generate images, besides ComfyUI and the bundled engine
on this machine:

1. **The bundled engine on another machine.** The same sd-server binary and
   the same model files, run on a GPU box elsewhere, and Haruspex pointed at
   it.
   - It keeps everything, Ming included: transparency, seam repair, the
     asset job unchanged.
   - It is mostly a URL field, because the client already speaks sd-server's
     API.
   - It frees this machine's GPU for the chat model, which is decision 3's
     way out ("ComfyUI on another machine") without needing ComfyUI.
2. **Any OpenAI-images-API server.** One generic client for
   `/v1/images/generations`, which covers:
   - vLLM-Omni, which serves Qwen-Image 2.1 and runs beside the vLLM the
     jobs already use on compute:3000;
   - Lemonade (stable-diffusion.cpp underneath, a fixed model list);
   - LocalAI and hosted services.

   It is text-to-image only. Chat's drawing works fully. The asset job
   degrades through the paths it already has: a keyed background instead of
   real transparency, and textures marked "not seamless". The model is
   whatever the server runs — in practice Qwen, which is non-commercial.

**What was ruled out.** A generic AUTOMATIC1111 backend (SD.Next, Forge)
looks cheap because the client speaks `/sdapi`. But each server names models
and handles tiling and alpha its own way, so it needs per-server probing, and
all it adds is a third route to Qwen-Image. Not planned unless someone asks.

**The facts this rests on** (checked 2026-10-04):
- **The bundled client speaks AUTOMATIC1111.** `src/lib/image/local/adapter.ts`
  uses `/sdapi/v1/txt2img`, `/img2img` and `/sd-models`.
- **Every call goes through Rust,** in `image_engine_request`
  (`src-tauri/src/image_engine.rs`), to a fixed `base_url(IMAGE_PORT)`.
  ComfyUI's client (`comfy.rs`) already takes a `base_url` per call and uses
  a no-proxy client for LAN hosts.
- **sd-server loads one model when it starts.** Its command line is built in
  `image_engine.rs` from the catalogue entry in `image_models.rs`.
- **Ming runs only on ComfyUI and our stable-diffusion.cpp conversion.**
  vLLM-Omni has had Qwen-Image 2.1 since day 0. Lemonade lists "Qwen Image"
  from v10.2, with an unclear version.

## Part A — the bundled engine on another machine

### Files touched

- `src/lib/stores/settings.ts`: `imageLocalRemoteUrl: string`. Empty means
  this machine.
- `src-tauri/src/image_engine.rs`:
  - `image_engine_request` takes an optional `base_url`;
  - a new `image_engine_remote_status(base_url)`;
  - a new `image_engine_launch_command(model_id, os)`.
- `src/lib/image/local/backend.ts`: remote mode.
- `src/lib/components/settings/ImageSection.svelte`: the "Runs on" choice,
  the URL field, and the setup panel.
- `docs/image-generation.md` and `README.md`.
- Tests; `./scripts/export-ipc-types.sh`.

### Steps

1. **One backend, two places.** Don't add a new `ImageBackendKind`.
   - The bundled engine gains **Runs on: This computer / Another computer**.
   - The model picker, catalogue, licence fields and capabilities stay the
     same. Only where the HTTP goes changes.
2. **Rust.** `image_engine_request(path, body, timeout_ms, base_url?)`:
   - Validate `base_url` as `http(s)://host[:port]`, with no path, query or
     credentials.
   - Use a no-proxy client, as `comfy.rs` does. It is a LAN server.
   - Name the host in every error: "192.168.1.40:8767 did not answer
     /sdapi/v1/img2img".
3. **No local process in remote mode.**
   - `ensureEngine` skips `image_engine_start`.
   - The probe is `GET /sdapi/v1/sd-models` on the remote.
   - Switching to remote stops a running local engine.
   - The sidecar watchdog and phase 13's orphan sweep never touch the remote.
4. **Check the remote is running the model the settings name.**
   - Read the loaded model from `/sdapi/v1/sd-models` and map it to a family
     with `familyOfId`, or by matching the catalogue's file names.
   - A mismatch refuses with one sentence: "The engine at <host> is running
     <file>, not Ming — restart it with the command in Settings → Image."
   - An unknown model is refused the same way. Capabilities depend on the
     family, so guessing would produce wrong output.
5. **Setup panel** (Settings → Image, shown when Another computer is chosen):
   - the files to put on that machine, with their Hugging Face URLs, from
     the `image_models.rs` catalogue entry;
   - where to get sd-server: the upstream release we pin, for that machine's
     OS;
   - **Copy launch command** — the exact arguments `image_engine.rs` uses
     for the chosen model, with the model paths relative to a folder the user
     names. Add `--listen-ip 0.0.0.0` and the port. Check the flag names
     against the pinned sd-server's `--help` when building this; don't
     assume them.
   - **Check**: probe, then show the loaded model or the refusal from step 4.
   - One line under it: "Anyone on your network can use this engine — it has
     no password." The detail goes in a tooltip.
6. **Everything downstream is unchanged:**
   - transparency through the clear-canvas img2img start;
   - the seam pass (Rust builds the inputs locally, img2img runs remotely);
   - the asset job;
   - the GPU-full sentence. It now names the remote host: "The engine at
     <host> ran out of GPU memory".
7. **The boundary needs no change.** `src/lib/shell/boundary.ts` already
   adds the image backend's port only for a loopback URL. The engine's fixed
   local port stays on the denylist, where it is harmless with nothing
   listening.

### Test plan

- **Rust:**
  - `base_url` validation accepts `http://host:port` and refuses paths,
    queries, credentials and non-http schemes;
  - the error names the host;
  - the launch command for each catalogue entry has every file argument and
    the listen address.
- **TS:**
  - remote mode never calls `image_engine_start`;
  - every request carries the URL;
  - a remote running the wrong model is refused with the Settings sentence;
  - capabilities follow the remote's family;
  - switching to remote stops a local engine.
- **Manual:**
  - run sd-server with Ming on compute:3000 (or any GPU box), using the
    copied command;
  - Check reports Ming;
  - draw in Chat;
  - run a small asset job with a sprite sheet and a texture: the sprites are
    transparent and the texture tiles;
  - stop the remote mid-generation, and the error names the host.

### Commit

`feat(image): run the bundled engine on another machine`

## Part B — any OpenAI-images-API server

### Files touched

- `src/lib/image/types.ts`: `ImageBackendKind` gains `'openai'`.
- New `src/lib/image/openai/backend.ts` and `adapter.ts`.
- New `src-tauri/src/image_openai.rs`, registered in `lib.rs`: the HTTP
  call, with the cancellable pattern from `comfy.rs`.
- `src/lib/stores/settings.ts`:
  - `imageOpenAiBaseUrl`;
  - `imageOpenAiModel`;
  - `imageOpenAiKeyRef`, a secret-store reference;
  - `imageOpenAiLicence`.
- `src-tauri/src/secrets.rs`: allow the `image:` key namespace beside
  `email:`.
- The image settings component: the new backend's card.
- `src/lib/image/forTool.ts`: the licence note for this backend.
- `docs/image-generation.md` and `README.md`.
- Tests; `./scripts/export-ipc-types.sh`.

### Steps

1. **Settings → Image → OpenAI-compatible server:**
   - a base URL — the one you'd give an OpenAI client, `/v1` included (for
     Lemonade, `…/api/v1`);
   - an optional API key, kept in the keychain under `image:openai`, with
     the same fallback rules as phase 10;
   - a model, picked from `GET /v1/models`, or typed when the server lists
     none.
2. **The call** (`image_openai.rs`):
   - `POST {base}/images/generations` with `model`, `prompt`, `n: 1`,
     `size: "WxH"` and `response_format: "b64_json"`.
   - A `url` in the response is fetched by Rust.
   - A no-proxy client for a private address; the configured proxy
     otherwise, since a hosted service is the internet. This is the same
     rule as the LLM remote backend.
   - The call runs as a registered task under a call id, so a cancel aborts
     it.
3. **Extras.** `seed`, `negative_prompt` and `num_inference_steps` are not
   OpenAI fields.
   - Send them by default (vLLM-Omni and Lemonade take them).
   - On a 400 that names an unknown field, drop all extras, retry once, and
     remember per base URL for the session.
   - Report the seed as "not reported" when the server echoes none.
4. **Capabilities, declared honestly:**
   - `transparency: false`, `seamlessTiling: false`, `loras: false`;
   - no img2img, so the seam pass and the clear-canvas start never run;
   - the asset job takes its keyed-background path, and textures carry the
     existing NOT_SEAMLESS note;
   - Chat's `transparent` argument is dropped with the existing note.
5. **Sizes.** Send what was asked for.
   - A 400 about size retries once at the nearest of 1024×1024, 1536×1024
     and 1024×1536, and says so in the result's notes.
   - A plain picture from `make_asset` already asks for 512–1024.
6. **Licence.**
   - Known model ids map to their licence: anything matching
     `qwen-image` is the Qwen Research License, non-commercial.
   - An unknown model is "licence unknown". Settings shows it, `forTool`
     adds "Check the model's licence before using this commercially", and
     the asset report names it.
   - The user can set the licence for an unknown model in Settings
     (`imageOpenAiLicence`: unknown, commercial or non-commercial).
7. **The asset job's preflight** says up front what this backend will
   produce: "No transparency or seamless tiling on this backend — sprites are
   keyed out of a flat background and textures may not tile." That is better
   than finding out from the report.
8. **Probe** (`probe()`): `GET {base}/models` with the key. The errors name
   the host and whether the key was refused (401/403).

### Test plan

- **Rust:**
  - the request body;
  - a `url` response is fetched;
  - a cancel aborts the task;
  - the proxy is used for a public host and not for a private one;
  - a 401 names the key.
- **TS:**
  - the extras are dropped and retried once on an unknown-field 400;
  - the size fallback;
  - the capabilities are all false, so the asset job takes its keyed path,
    with the NOT_SEAMLESS note on textures;
  - the licence mapping and the unknown-licence note;
  - the API key goes through `secret_set` with the `image:` key.
- **Manual:**
  - `vllm serve Qwen/Qwen-Image-2.1 --omni` on compute:3000, then draw in
    Chat;
  - run a two-sprite asset job and read its preflight line and report;
  - if a Lemonade box is handy, draw in Chat against it.

### Commit

`feat(image): generate with any OpenAI-images-API server`

## Build gate

The overview's gate, after each part. `check-ipc` must pass after the type
export.

## Rollback

Revert either commit and re-export the IPC types.
- **Part A:** settings with `imageLocalRemoteUrl` set fall back to this
  machine, which starts the local engine. That's safe, but say so in the
  release notes.
- **Part B:** an `imageBackendKind` of `'openai'` is unknown to the old code
  and reads as `none`. Image generation is then off until the user picks a
  backend again. The `image:openai` keychain entry stays, unused.
