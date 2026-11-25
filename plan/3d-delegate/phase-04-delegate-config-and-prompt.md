# Phase 04 — 3D delegate config and prompts

**Depends on:** phases 01–03 · **Enables:** phase 05 (the tool reads this
config and builds its profile from these prompts).

## Goal

Add the pure parts of the 3D delegate:

- its stored settings under the 3D helper (the model, the round cap, the dollar
  cap);
- the delegate's system prompt and first message;
- the code-side final check that decides whether a call is done.

Nothing user-visible ships here. Phase 05 adds the Settings UI and the tool.

## Files touched

- `src/lib/helpers/three/delegateConfig.ts` (new):
  - `Delegate3dConfig` type;
  - `parseDelegate3dConfig(raw)`;
  - `delegate3dConfig()`, which reads `codeHelperConfig['3d']`;
  - `DELEGATE_3D_DEFAULTS`.
- `src/lib/helpers/three/delegatePrompt.ts` (new):
  - `delegate3dSystemPrompt()`;
  - `delegate3dFirstMessage({ path, anim, glb, task, existing, imagePaths })`;
  - `delegate3dFinalReport(why)`;
  - `delegate3dFiles(path)`.
- `src/lib/helpers/three/delegateCheck.ts` (new): `finalCheck3d(paths, host)`,
  which returns `{ ok, text, png }` and runs the same build and check as
  `check_3d`.
- `src/lib/helpers/three/call.ts` — `runCheck3d`'s reply gains `ok: boolean`
  (true when the report has no error lines), so `finalCheck3d` and tests can
  read it.
- `src/lib/agent/jobs/types/model-generation/prompts.ts` — move the shared
  build-module guidance (`RIG_RULE` and the module rules that
  `createSystemPrompt` and `animateSystemPrompt` both state) into exported
  constants. `delegatePrompt.ts` imports them, so the job and the delegate
  say the same thing.
- Tests: `delegateConfig.test.ts`, `delegatePrompt.test.ts`,
  `delegateCheck.test.ts`, and an updated `call.test.ts`.

## Steps

1. `Delegate3dConfig`:
   - `backend: BackendOverride | null`. Null means no delegate, so
     `delegate_3d` is not offered.
   - `maxRounds: number`: default 80, a whole number clamped to 5–500.
   - `maxCostUsd: number | null`: default null (unlimited); a positive number,
     otherwise null.

   `parseDelegate3dConfig` cleans an absent, old or hand-edited value into
   this shape. A backend must have a non-empty `baseUrl` and `modelId`, or it
   becomes null.
2. `delegate3dFiles(path)`:
   - `path` must end in `.glb`.
   - It returns `{ module: <stem>.js, anim: <stem>.anim.js, glb: path }`.
   - These three are the writable paths.
3. System prompt. It states, in this order:
   - its job: make the one 3D asset the task describes, as a Three.js build
     module checked with `check_3d`;
   - its tools;
   - that it may write only its module, its anim module and the GLB (named in
     the first message);
   - the shared module rules from `prompts.ts`;
   - "keep clips in the anim module";
   - "run `check_3d` after every change, and look at the sheet";
   - "you are done when `check_3d` reports no errors";
   - "nobody will answer questions; decide, and say what you assumed";
   - the report's shape: files written, size, named parts, clips, problems
     left, assumptions. At most 4,000 characters.
4. First message: the task text, then a "Files" block naming the module, anim
   module and GLB. If the module already exists, add "This module exists: read
   it and change it rather than starting again." If the anim module exists,
   add the same for it. If reference images are attached, list them.
5. `delegate3dFinalReport('rounds' | 'cost')`: "You've reached this call's
   <round|cost> limit. Stop working and give your report now: what is built,
   what the last check said, and what is left."
6. `finalCheck3d(paths, host: Check3dHost)` (`Check3dHost` is the existing
   type in `helpers/three/call.ts`):
   - It calls `runCheck3d` with `{ path: module, anim: <anim if the file
     exists>, out: glb }` on the host it is given. The caller builds that
     host so it writes only the GLB; phase 05 does this with `check3dHost`
     from phase 02. Tests pass a fake host.
   - It returns `ok`, the report text and the sheet PNG.
   - A missing module returns `ok: false` with "The module was never written."

## Build gate

```bash
npm run check
npm run lint
npm run format:check
npm run test
```

## Test plan

- Config: absent → defaults. `maxRounds: 3` → 5. `maxRounds: 1000` → 500.
  `maxCostUsd: 0`, `-1` or `'x'` → null. `maxCostUsd: 2.5` is kept. A backend
  without `modelId` → null.
- `delegate3dFiles('assets/goblin.glb')` → `assets/goblin.js`,
  `assets/goblin.anim.js`, `assets/goblin.glb`. `assets/goblin.png` is
  refused.
- Prompt snapshot tests for the system prompt and for first messages with and
  without an existing module and images.
- The model-generation job's prompt tests still pass after the constants move.
- `finalCheck3d` against the existing `helpers/three` fixtures: a clean module
  → `ok: true`. A module that throws → `ok: false` with its line. No module →
  the "never written" text.

## Commit

`feat(3d): delegate config, prompts and final check for the 3D delegate`

## Rollback

Revert the commit. Nothing reads the config or the prompts until phase 05.
The `prompts.ts` refactor moves constants only, so the 3D models job's prompts
come out the same.
