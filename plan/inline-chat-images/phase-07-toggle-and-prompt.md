# Phase 07 — The Include images toggle and prompt fragment

**Depends on:** 06 · **Enables:** the success criterion — images appearing
unprompted on the default 9B.

## Goal

Add the user-facing switch and the prompt text it controls. This is last on
purpose: nudging the model to produce images before the pipeline can render
them would ship a broken experience. By this phase everything works for an
explicit request, and the toggle only changes whether the model volunteers.

## Files touched

- `src/lib/stores/settings.ts` — `includeImages: boolean` on `AppSettings`
  (near `responseFormat`, line 239), default `false` (line 543), and a
  `getIncludeImagesPrompt()` helper beside `getResponseFormatPrompt()`
  (line 1212).
- `src/lib/components/settings/GeneralSection.svelte` — the toggle, below
  Response Format.
- `src/lib/agent/system-prompt.ts` — inject the fragment in
  `buildSystemPrompt`.
- `README.md` — a Features bullet and a Known issues note.

## Steps

1. **Setting.** `includeImages`, default `false`. It follows the
   `getResponseFormatPrompt()` precedent exactly: a settings value that maps to
   a prompt fragment, with no other behaviour attached.

2. **Toggle UI.** A checkbox row in Settings → General under Response Format:

   > **Include images in answers**
   > When on, answers may include a few relevant pictures from freely-licensed
   > sources. Images are downloaded by Haruspex, not by the page, and are
   > stored on this device.

   The second line is doing real work: it tells a privacy-minded user that
   turning this on does not start leaking their browsing to third parties,
   which is the obvious worry and the thing the whole design was built to
   avoid.

3. **Prompt fragment.** Injected **only when the toggle is on**, and only for
   chat — `buildSystemPrompt` already serves the shell assistant, job runs and
   remote guests through the same function, so gate on the chat surface as well
   as the setting to honour the local-Chat-tab-only decision.

   ```
   IMAGES:
   - When the answer is about something visual — a place, an object, an animal,
     a person, a plant, a building, a product — include 1 to 3 relevant images.
   - Get them with image_search, or use an [Image: <url>] line from a page you
     fetched. Only use image URLs that appeared in a tool result this
     conversation. Never invent an image URL.
   - Embed with markdown: ![short description](URL)
   - Place each image right after the paragraph it illustrates, not all at the
     end.
   - Do NOT include images for abstract or technical questions — code, maths,
     definitions, comparisons of numbers, how-to instructions.
   - Never use more than 3 images in one answer. Fewer is better. An image that
     does not help the reader understand something is noise.
   ```

   The wording is deliberately concrete and imperative. A 9B given "include
   relevant images where appropriate" will either ignore it or paste an image
   after every paragraph; naming the categories on both sides is what produces
   consistent behaviour. Note that the 3-image ceiling is stated here _and_
   enforced in Phase 05 — the prompt sets the intent, the code guarantees it.

4. **Off is genuinely off.** With the toggle off, no fragment is added and the
   turn is byte-identical to today's. Both image tools stay in the schema, so
   "show me a picture of X" still works and the model can still offer images on
   its own initiative. Verify this by diffing the built system prompt with the
   toggle off against the current one.

5. **Docs.** Add to the README Features list under Chat, and add a Known issues
   entry: on a 9B the model sometimes picks a weakly related image, and image
   coverage is thin for very recent products and events.

## Build gate

```bash
npm run check && npm run lint && npm run test && npm run format:check
cd src-tauri && cargo fmt -- --check && cargo clippy && cargo test
```

Then `make check` in full, which also runs the CI drift guards.

## Test plan

- **Unit:** `buildSystemPrompt` contains the IMAGES block when the setting is
  on and does not when it is off.
- **Unit:** with the setting on, a shell-assistant prompt and a job prompt do
  **not** get the block — chat only.
- **Unit:** the toggle-off prompt is byte-identical to the current prompt.
  Snapshot this; it is the regression that proves nothing changed for users who
  never turn the feature on.
- **Manual, the success criterion:** with the toggle on and the default
  **Qwen 3.5 9B** loaded, ask three topical questions ("What is a red panda?",
  "Tell me about Kyoto", "What is the ThinkPad X1?") and confirm each answer
  carries 1–3 relevant, correctly attributed inline images without being asked.
  Repeat each three times — small-model behaviour varies between runs, and one
  good run is not evidence.
- **Manual:** ask an abstract question ("explain recursion") with the toggle on
  and confirm no images appear.
- **Manual:** turn the toggle off, ask "show me a picture of a red panda", and
  confirm it still works.
- **Manual:** configure an HTTP proxy, run an image-bearing turn, and confirm
  every image fetch appears in the proxy log.

## Commit

```
feat(chat): add an Include images setting that puts pictures in answers
```

## Rollback

Revert the commit. The setting disappears and the prompt returns to its current
text; the whole pipeline from Phases 01–06 stays in place and inert, still
serving explicit image requests. A stale `includeImages` key left in a user's
stored settings is ignored by the parser, so no settings migration is needed to
back this out.
