# Image model routing — Project Overview

## Problem
Settings → Image holds one backend at a time: `imageBackendKind` plus that
kind's address, key and model fields. Every image tool, the asset-generation
job, the licence note and the "Set up now" line in the `fix-picture` skill read
that one choice. But no single image model does everything. On asmodean's
llama-toolchest, klein draws and edits up to 4 pictures, qwen-image-edit-2511
edits up to 3, Ming-Image draws with transparency but cannot edit, and
Real-ESRGAN only upscales. Toolchest starts and evicts instances on demand, so
one GPU can serve all of them. Today a user who wants to draw with Ming, edit
with klein and then upscale has to open Settings between every step, and the
chat model can only do whatever the one chosen model can.

The single choice is also built into the code. The backend registry is a map
with one entry per kind, each backend reads its config from settings at module
level, and a background image task routes by whatever is in Settings when it
runs, not by what was chosen when it started. Two toolchest instances, or two
ComfyUI servers, cannot be in use at the same time.

## Goals
- **A list of image models.** Settings → Image holds an ordered list of
  entries. Each entry is one model on one server: backend kind (ComfyUI,
  bundled engine, Lemonade, llama-toolchest), address, API key and model. The
  same server can appear in several entries.
- **Routing by need.** Each image tool call works out what it needs (draw, edit
  N pictures, masked edit, extend, upscale, transparency, tiling) and runs on
  the first entry in the user's order that can do it. A picture drawn by one
  entry can be edited or upscaled by another.
- **The chat model may choose.** `generate_image`, `edit_image` and
  `upscale_image` take an optional `model` argument, an enum of the entry
  names. The system prompt and the `fix-picture` skill list each entry with
  its capability line.
- **Failover.** When an entry is unreachable or unconfigured, the call moves on
  to the next entry that can do the job. A request the server rejects (a bad
  prompt, too many pictures) does not move on. When the list holds more than
  one entry, the tool result names the entry that ran.
- **Entries carry their own config.** Backends take an entry as an argument
  instead of reading settings, so two entries of the same kind work side by
  side. Background tasks record the entry they started on, and resume uses it.
- **Per-entry facts.** The licence note, the asset job's model name and native
  edge, and the GPU-full rewrite use the entry that actually ran.
- **llama-toolchest upscale.** The toolchest backend gains `upscale()` through
  `/v1/images/upscale`. As with the other backends, the upscaler belongs to
  the server: a toolchest entry can upscale when its server has an upscaler
  instance.
- **Drawing** → Every entry can draw, edit models included (sd.cpp, ComfyUI
  and toolchest run them text-to-image too). A user who wants drawing elsewhere
  puts that entry first.
- **Masked edits** need an entry that can edit, as today; extending a
  picture needs one that can inpaint.
- **Edit picture count from the models.** `edit_image` takes as many pictures
  as the most capable entry takes (FLUX.3 Image Klein: 10) instead of a fixed 4.
- **A shape that fits music and video.** The entry type and the routing module
  are written so music and video lists can follow with the same pattern.

## Non-goals
- Music and video routing. Settings → Music and Settings → Video keep their
  single backend in this project.
- Routing by licence. Routing ignores whether a model allows commercial use;
  the non-commercial note stays, now for the entry that ran.
- Job handles for Lemonade and the bundled engine. Their background tasks
  still end when the app quits.
- Running two bundled-engine models at once. The bundled engine stays one
  process; two bundled entries take turns, restarting sd-server between them.
- A generic OpenAI-images backend, or any new backend kind.
- Image routing in the Code tab. The Code tab still offers only `make_asset`.

## Users & primary flow
1. The user opens Settings → Image. An existing setup already shows as entry 1.
2. They press **Add model**, pick a backend, choose a saved server or type an
   address, pick a key, press Probe and pick a model. The entry's capability
   line shows what it can do.
3. They add more entries and move them up or down. Order is priority.
4. In Chat they ask for a transparent sprite. `generate_image` needs
   transparency, so it skips entries that can't do it and runs on Ming-Image.
5. They ask to put a hat on it using a reference picture. `edit_image` needs an
   edit with two pictures and runs on the first entry that takes two, klein.
6. They ask for a bigger copy. `upscale_image` runs on the first entry whose
   server has an upscaler, here asmodean's Real-ESRGAN instance.
7. If they say "use qwen-image-edit for this", the chat model passes
   `model: "qwen-image-edit-2511"`, and that entry runs if it can do the job.
8. If asmodean is down, the call falls through to the next capable entry, and
   the result says which model drew the picture.

## Constraints
- Tauri 2 + SvelteKit 5 runes; settings are plain JSON in localStorage
  (`haruspex-settings`), loaded through `stores/settings.ts`.
- The four backends keep their HTTP behaviour: ComfyUI workflows and family
  templates, the bundled sd-server sidecar on port 8767, Lemonade's sd-cpp
  recipe, toolchest's job and sync routes.
- The 9B default model is the floor. Routing must work without the chat model
  ever naming an entry. The entry list in the prompt must stay short.
- API keys: today ComfyUI and Lemonade keys are keychain secrets
  (`stores/imageSecrets.ts`) and toolchest keys are named keys from Settings →
  Inference → API Keys. After this work every entry stores a named-key
  reference, never a key.
- A downgrade to the previous release must still find its image setup, so the
  old single-backend fields stay readable for one release.
- The user guide pages (`images`, `image-editing`) must describe the new
  behaviour in the same PRs and stay under 6 KB each.

## Success criteria
- With entries Ming-Image and klein on a toolchest that also runs Real-ESRGAN, a Chat turn
  can draw a transparent picture, edit it with a second picture and upscale
  it, with no visit to Settings, and each result names the model that ran.
- A user with one configured backend before the update sees it as entry 1
  after it, and every image tool behaves as before.
- Two entries of the same kind on different servers both work in one turn.
- With the first capable entry's server stopped, the call runs on the next
  capable entry; with a rejected request, it fails without trying another.
- A background image task started on entry A resumes on entry A after a
  restart, even if the list changed in between.
- `edit_image` with 10 pictures runs on FLUX.3 Image Klein and is refused,
  before anything is sent, when no entry takes 10.
- A toolchest upscaler instance upscales a picture through `upscale_image`.
- Existing tests pass; new tests cover routing, failover, migration and the
  per-entry facts.

## Decisions
- **Scope** → Build image routing now; shape the entry type and routing module
  so music and video can follow, but don't build them here.
- **Who picks the model** → Code routes by need to the first capable entry in
  the user's order; the image tools also take an optional `model` argument, and
  the chat model sees the entries and their capabilities.
- **What an entry is** → One model on one server: `{backend, address, key,
  model}`. One server can appear in several entries.
- **Settings UI** → An ordered list of rows (name, server, capability line,
  up/down/remove); order is priority; one row's editor open at a time, reusing
  today's Connection editor; **Add model** appends an entry.
- **Failover** → An unreachable or unconfigured entry falls through to the
  next capable entry; a rejected request does not.
- **Licence** → Routing ignores licence; the non-commercial note stays, for the
  entry that ran.
- **Related gaps in scope** → llama-toolchest upscale, and `edit_image`'s
  picture limit from the entries. Lemonade and bundled-engine resume stay out.
- **Entry name** → Defaults to the model's display name (the backend's label
  until a model is chosen); the user can rename it; duplicates get the host
  appended, or a number when the host is the same. The `model` argument is an enum of
  these names.
- **Migration** → A configured single backend becomes entry 1; `none` becomes
  an empty list. The old fields and the old key secrets stay for one release;
  their removal is filed as a GitHub issue when Phase 03 merges.
- **Backend API** → Each kind exports `forEntry(entry)`, returning an
  `ImageBackend` bound to that entry; module-level caches become per object.
- **Capabilities for routing** → A successful probe saves the entry's
  capabilities in the entry. Routing reads these snapshots; the chosen entry is
  still probed before it runs, and a changed answer updates its snapshot.
- **Transparency and tiling** → Prefer an entry that can do everything asked;
  otherwise use the first that can do the rest, with today's note.
- **A named entry that can't do the job** → Refuse, naming the entries that can.
- **Asset job and `make_asset`** → Route each draw, edit and upscale like a
  tool call.
- **Keys** → Every entry uses a named key from Settings → Inference → API Keys.
  Migration turns the `comfy:key` and `lemonade:key` secrets into named keys.
- **Tool offer** → Chat offers `edit_image` only when some entry can edit, and
  `upscale_image` only when some entry can upscale.
- **Toolchest upscaler** → A server add-on, as on the other backends, not an
  entry of its own.
