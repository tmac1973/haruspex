# Phase 07 — Image generation in Chat

Depends on: — (05 is recommended first, for clean cancel on ComfyUI) /
Enables: 08

## Goal

When Settings → Image has a backend, Chat offers a `generate_image` tool.
"Draw me a lighthouse at dusk" produces an image inline in the answer, and it
is still there after a reload or a restart.

This phase also lays down `generateForTool`, the single-image core that
phase 08 reuses.

**Two gaps in today's image cache must be fixed for this to hold:**
- **The startup sweep deletes the image.** `image_store_bytes` never links
  the image to a conversation, so `sweep_orphans` treats it as unreferenced.
- **The image is gone after a reload.** Rehydration looks images up by
  `source_url`. A generated image's message text holds
  `haruspex-img://localhost/<hash>`, but the stored `source_url` is
  `haruspex-generated:<hash>`, so the lookup misses and the renderer drops
  the image.

## Files touched

- `src-tauri/src/image_cache/commands.rs`:
  - `image_store_bytes` takes an optional `conversation_id`;
  - new `image_rehydrate_local(conversation_id, hashes)`.
- `src-tauri/src/lib.rs`: register the new command.
- `src/lib/images/resolve.svelte.ts` and `eligible.ts`: rehydrate local
  hashes found in the text.
- `src/lib/agent/tools/types.ts`:
  - `ToolContext.conversationId?: string`;
  - new category `'image'`.
- `src/lib/agent/loop.ts` (`AgentLoopOptions`) and `loop/iteration.ts`
  (around :225-250 and :1448-1463): carry `conversationId` into
  `ToolContext`.
- `src/lib/agent/tools/registry.ts`: gate `'image'` at schema and at
  execution, on the backend setting AND an `interactive` flag in
  `ToolFilterOpts`.
- New `src/lib/image/forTool.ts`, with `generateForTool` (built on
  `generateOneImage`, `src/lib/image/generateOne.ts`).
- New `src/lib/agent/tools/image-gen.ts`, with `generate_image`.
- `src/lib/stores/chat.svelte.ts`: pass `conversationId`.
- `src/lib/agent/tools/index.ts` (or wherever tools are imported).
- Tests beside each; `./scripts/export-ipc-types.sh`.

## Steps

1. **Link on store.** `image_store_bytes(..., conversation_id:
   Option<String>)` calls `db.link_image` when it is given, **before** the
   dedupe early return (around `image_cache/commands.rs:175-179`), so storing
   identical bytes again still links them. Existing callers, such as the
   asset job's anchor, pass none and behave as today. Put the work in a
   helper taking `&Database` and the cache directory, so it can be tested
   without an `AppHandle`.
2. **Rehydrate local images.** `image_rehydrate_local(conversation_id,
   hashes)` returns the `ImageRow`s it holds and links each one to the
   conversation.
   - In `eligible.ts`, add `localImageHashesInText(text)`. It recognises both
     forms `imageSrc` builds: `haruspex-img://localhost/<hash>` and, on
     Windows, `http://haruspex-img.localhost/<hash>` (`images/url.ts:20`).
     Exclude both forms from `imageUrlsInText`, so a Windows URL is never
     fetched as if a model had invented it.
   - In `resolve.svelte.ts`, when a message is (re)displayed, call
     `image_rehydrate_local` with those hashes.
   - Each returned row goes through `registerLocalImage`, so the renderer has
     the URL.
   - Generated images don't count toward `MAX_IMAGES_PER_MESSAGE`, which caps
     fetched pictures.
3. **`generateForTool(req, opts)`** in `forTool.ts`:
   - `req`: a full `ImageRequest` (prompt, negativePrompt, width, height,
     seed, model, transparent, seamless), so phase 08 can pass the asset
     job's requests unchanged.
   - `opts`: signal, onProgress.
   - Steps:
     1. probe the backend;
     2. refuse plainly when it is `none` or the probe fails, using the
        probe's own detail;
     3. read the capabilities, and drop `transparent` or `seamless` when the
        backend lacks them, noting each one dropped;
     4. call `generate`.
   - Returns `{ bytes, width, height, seed, model, notes: string[] }`.
   - **GPU-full errors** (decision 3) become one sentence. These are
     `vae encode compute failed`, `cannot make enough memory available`, or an
     sd-server 500 with no image, together with a local engine. The sentence:
     "The image engine ran out of GPU memory beside the chat model. A smaller
     chat model in Settings → Models, or ComfyUI on another machine in
     Settings → Image, would leave room." The raw detail goes in the tool
     result, after that sentence.
4. **The `generate_image` tool** (category `'image'`).
   - Arguments:
     - `prompt` (required);
     - `shape`: `square` (1024²), `landscape` (1344×768) or `portrait`
       (768×1344);
     - `transparent`: boolean, default false.
   - Execution:
     1. call `generateForTool`, forwarding `ctx.signal`;
     2. stream progress through `ctx.onProgress`, as "Drawing… 40 s";
     3. `image_store_bytes` with `ctx.conversationId`;
     4. `registerLocalImage`.
   - Its result tells the model the markdown to place: "Image ready. Put
     `![<short alt>](<url>)` in your answer where it belongs." It also gives
     the model, seed and any notes.
   - **If the model leaves it out:** the existing fallback is specific to
     `image_search` (`eligible.ts:240`, `:269`), so don't reuse it. An image
     produced by `generate_image` in the turn whose URL is absent from the
     final text gets its markdown appended to the committed message text,
     after a blank line. It is then stored, and rehydrates like any other.
   - Schema description: "Generate a picture from a description, with the
     image generation set up in Settings → Image. Takes 30 s to a few
     minutes. Use it when the user asks you to draw, paint, illustrate or make
     an image; don't use it to find real photos."
5. **Gating.** `'image'` tools are offered only when
   `getSettings().imageBackendKind !== 'none'` **and** the filter's new
   `interactive` flag is true.
   - Chat sets the flag; job turns never do.
   - The flag is needed because a research job runs without an allowlist
     (`research/pipeline.ts:87`) and so gets the Chat filter.
   - `executeTool` refuses an `'image'` tool when either condition fails.
6. **Licence note.** When the configured model's catalogue entry has
   commercial use off (Qwen 2.1, `qwen21`; for ComfyUI, the family the
   settings name), the tool result says so in one clause, so the model can
   mention it if the user is making something to publish.

## Build gate

The overview's gate. `check-ipc` must pass.

## Test plan

- **Rust:**
  - `image_store_bytes` with a conversation id survives `sweep_orphans`;
  - without one it is swept, as today;
  - `image_rehydrate_local` returns the rows it has, ignores unknown hashes,
    and links them.
- **TS, `generateForTool`:**
  - backend `none` refuses with the Settings path;
  - a backend lacking transparency drops the flag and adds a note;
  - each of the three memory errors becomes the GPU sentence, and other
    errors pass through.
- **TS, tool:**
  - the schema is offered only with a backend and the `interactive` flag;
  - a research job's filter (no allowlist, not interactive) doesn't get it;
  - execution refuses without one;
  - a successful run stores with the conversation id and returns markdown
    with a `haruspex-img` URL;
  - an aborted signal rejects as cancelled.
- **TS, resolver:**
  - a message whose text holds a `haruspex-img` URL, in either form,
    rehydrates through `image_rehydrate_local` and registers the URL;
  - neither form appears in `imageUrlsInText`.
- **Manual:**
  - in Chat, with the bundled engine on Ming, ask for "a pixel-art
    lighthouse"; the image appears inline;
  - reload the webview and the image is still there;
  - restart the app and it is still there;
  - with ComfyUI as the backend, do the same once.
  - With a 9B chat model loaded on the same GPU and Qwen 2.1 selected,
    confirm what happens: an image, or the GPU sentence.

## Commit

`feat(chat): draw images with the configured image backend, inline and kept across reloads`

## Rollback

Revert the commit and re-export the IPC types. Images already generated stay
in the cache and remain linked; with the revert, the startup sweep keeps them
because they are linked.
