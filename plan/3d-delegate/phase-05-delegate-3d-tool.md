# Phase 05 — `delegate_3d` tool, settings and guide

**Depends on:** phases 01–04 · **Enables:** phase 06 (live run).

## Goal

Ship the feature. Settings → Code → Helpers → 3D gets a **Delegate to** model,
a round cap and a dollar cap. When a delegate model is set and the 3D helper is
on, the Code tab's agent gets `delegate_3d` beside `check_3d`. The tool runs a
subtask with the 3D profile, in the foreground or the background. It checks the
result in code, and returns the report with the final sheet when the parent's
model can see images. The guide and showcase describe it.

## Files touched

- `src/lib/agent/tools/delegate-3d.ts` (new) — the tool: refusals, profile,
  foreground and background runs, result text and sheet.
- `src/lib/agent/tools/index.ts` — import it.
- `src/lib/helpers/three/helper.ts` — the 3D helper owns `check_3d` and
  `delegate_3d`. It gets `settings` (parse + component) and a `prompt`
  function that adds the `delegate_3d` line while a delegate is set.
- `src/lib/agent/tools/registry.ts` — `delegate_3d` is offered only when
  `delegate3dConfig().backend` is set, and never to a subtask.
- `src/lib/helpers/three/ThreeSettings.svelte` (new) — the 3D row's editor.
  `src/lib/components/settings/HelpersSection.svelte` already mounts a
  helper's `settings.component` under its switch, as the Search helper's
  does, so it needs no change.
- `src/lib/code/backgroundSubtasks.ts` — no change expected: it runs specs
  through `runSubtaskSpec`, which handles the profile and `finish` (phase 03).
  Its test gains a profiled spec.
- `src/lib/code/systemPrompt.ts` — nothing new; the helper's `prompt` covers
  the TOOLS line.
- `docs/guide/helpers.md` — "The 3D helper" gains a short "Hand 3D work to
  another model" part; What it doesn't do is updated.
- `docs/guide/3d-helper.md` — a `delegate_3d` section: arguments, files,
  caps, report.
- `docs/guide/code-subtasks.md` — one line: `delegate_3d` runs as a subtask
  on its own model and follows Settings → Code → Helpers → 3D, not
  Settings → Code → Subtasks.
- `docs/showcase/code.md` — a card: a local model hands a character with a
  walk cycle to an OpenRouter model.
- Tests: `delegate-3d.test.ts`, `ThreeSettings.test.ts`,
  `registry.test.ts`, `helper.test.ts` (3D), `backgroundSubtasks.test.ts`.

## Steps

1. **Tool schema** `delegate_3d`:
   - `path` (required): where the `.glb` goes, relative to the session folder.
   - `task` (required): what to make, with size in metres, style, target
     engine, clips and anything from the project it needs to fit.
   - `images` (optional): up to 3 PNG, JPEG or WebP files in the project,
     8 MB each.
   - `label` (optional).
   - `background` (optional, default false).

   Description: "Hand one 3D asset to the 3D delegate model: it writes the
   build module and animation module, checks them with check_3d until clean,
   and writes the .glb. It can't see this conversation: put everything it
   needs in task. To change an asset it made, call again with the same path."

2. **Refusals**, as tool errors:
   - a subtask calling it;
   - no project folder;
   - a read-only session;
   - no delegate model set ("Set one in Settings → Code → Helpers → 3D");
   - `path` not ending in `.glb` or outside the folder;
   - an empty task;
   - a bad image (same rules as above);
   - `background` without `ctx.startBackgroundSubtask`. The Code store
     always passes it (`code.svelte.ts`), whatever Settings → Code →
     Subtasks says, so this happens only outside a Code session.
   - more than `SUBTASKS_PER_TURN` subtasks this turn. The counter is shared
     with `delegate`, so the per-turn limit covers both kinds. Settings →
     Code → Subtasks is not read.
3. **Profile:**
   - `backend` comes from the config, with its `visionSupported`.
   - `system` is `delegate3dSystemPrompt()`.
   - `firstMessage` is `delegate3dFirstMessage(...)`, with `existing` read
     from the folder.
   - `images` are loaded as data URLs.
   - `tools`: `fs_list_dir`, `fs_read_text`, `fs_read_image`, `code_grep`,
     `code_glob`, `fs_write_text`, `fs_edit_text`, `check_3d`.
   - `helpers` is `['3d']`.
   - `writablePaths` is `delegate3dFiles(path)`.
   - `maxRounds` and `maxCostUsd` come from the config, and `finalReport` is
     `delegate3dFinalReport`.
   - `doneCheck` ignores `steps` and runs `finalCheck3d` on the files on
     disk. Its host is `check3dHost({ ...ctx, writablePaths: [glb],
pendingImages: [] })`. If the check is not ok, it nudges: "The final
     check still fails: <errors>. Fix them, run check_3d, then give your
     report." A missing module counts as not ok. If ok, it returns null.
   - `finish` runs `finalCheck3d` once more on the same host and builds the
     result (step 5).
4. **Spec:**
   - `mode: 'write'` with `wt: null`, so the card says it writes. A profiled
     subtask never makes a worktree.
   - `label` is the given label, else "3D: <file name>".
   - `task` is the given task.
5. **After the run (`finish`):**
   - Run `finalCheck3d` once more, so the result reflects the files on disk.
   - Result text: the subtask's report, then "Final check: clean" or "Final
     check: errors remain:" with the error lines, then the files written and
     the cost when known.
   - Return the final PNG as `png`. Phase 03 puts it on the card's `sheet`.
   - In the foreground, the tool attaches `SubtaskRunResult.png` through the
     tool result's image when `ctx.visionSupported !== false`.
   - In the background, the notification is `finish`'s text only, delivered
     through `runSubtaskSpec` as phase 03 set up. The card shows the sheet.
6. **Helper prompt line** while a delegate is set: "- delegate_3d — hand a
   new 3D asset, or a change to one it made, to <model label>; describe it
   fully. Use check_3d yourself to look at or measure an asset, not to build
   one." The model label comes from `overrideModelLabel`.
7. **`ThreeSettings.svelte`**, shown under the 3D switch:
   - **Delegate to** opens the Jobs model picker (`JobModelFields`) in a
     modal, limited to the remote and OpenRouter sources, with **None**
     clearing it. "Remote" takes any OpenAI-compatible URL, a llama-server
     on localhost included. That is how a local delegate is set, and the
     same-lane slot rule in phase 03 covers it. The "Settings" source is
     left out: it would follow the global model rather than name a delegate. It converts through `backendFromModelForm` and
     `modelFormFromBackend`, and shows the model label.
   - **Rounds per asset** is a number field, 5–500.
   - **Cost limit per asset** is a dollar field with an **Unlimited**
     checkbox, checked by default. Its tooltip: "Counts the cost the server
     reports, or OpenRouter's prices for the model; a server with neither
     has no cost to limit."
   - Section copy: "Hands 3D modelling to another model."
   - Saving goes through `setCodeHelperConfig('3d', …)` with plain JSON, not
     `$state` proxies.
8. **Guide:** write the sections listed above, with Settings paths in full,
   under 6 KB a page. Point at the other pages by name.
9. **Showcase:** add the card to `docs/showcase/code.md` in the format at the
   top of `scripts/build-showcase.mjs`.

## Build gate

```bash
npm run check
npm run lint
npm run format:check
npm run test
node scripts/guide-check.mjs
node scripts/build-showcase.mjs
```

If any `#[ts(export)]` type changed: `./scripts/export-ipc-types.sh` (none is
expected).

## Test plan

- `delegate-3d.test.ts`, with the subtask runner and `finalCheck3d` mocked:
  - Each refusal.
  - The profile carries the config's backend, caps and the three writable
    paths.
  - An existing module sets `existing`.
  - Foreground with vision attaches the PNG; without vision it doesn't.
  - Background returns at once and hands the spec to `startBackgroundSubtask`.
  - Result text for a clean and an erroring final check.
- `registry.test.ts`: `delegate_3d` is absent with no backend and present
  with one (3D on). It is absent in a subtask and absent with 3D off.
- `helper.test.ts`: the TOOLS line appears only with a backend.
- `ThreeSettings.test.ts`:
  - Picking a model, then **None**, saves `backend` and then null.
  - Unlimited saves `maxCostUsd: null`.
  - The round field clamps.
  - The saved value is plain JSON (`structuredClone` passes).
- `backgroundSubtasks.test.ts`: a profiled spec runs with its profile and
  its notification carries the result text.
- Manual, in `GDK_BACKEND=x11 npm run tauri dev`, with an OpenRouter delegate:
  - "make a wooden crate at `assets/crate.glb`" ends with the three files, a
    clean final check and the cost on the card.
  - A repeat call "make it taller" edits the module instead of starting over.

## Commit

`feat(code): hand 3D assets to a delegate model with delegate_3d`

## Rollback

Revert the commit. The stored `codeHelperConfig['3d']` stays in settings and
nothing reads it. Sessions with `delegate_3d` steps keep loading: their cards
are ordinary subtask cards.
