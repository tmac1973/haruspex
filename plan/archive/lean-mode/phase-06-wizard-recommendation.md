# Phase 06 — Recommendation rule and setup wizard step

**Depends on:** 01, 02, 03, 04 (03 and 04 only so that lean mode is complete
before the app recommends it) · **Enables:** 07 (it reuses the rule)

## Goal

New users choose lean or full mode during setup. The choice is pre-selected by
one rule, kept in one module, and the user can pick either. The step comes
after the test query on both paths, local and remote. Lean mode is now
complete (tools, tabs, jobs, badge), so this is the point where the app starts
recommending it.

## Files touched

- `src/lib/lean/recommend.ts` (new): `recommendLean()` and `activeModelId()`.
- `src/lib/lean/recommend.test.ts` (new).
- `src/lib/components/settings/McpToolList.svelte`: use the shared
  `activeModelId()` instead of its local copy (:62-67).
- `src/lib/stores/settings.ts`: add `leanNoticeShown: boolean` (default
  `false`). Phase 07 reads it, and the wizard sets it so a new user is never
  also shown the existing-user notice.
- `src/lib/stores/setup.svelte.ts`: add `'mode'` to `SetupStep`, plus
  `leanChoice` state and `confirmMode()`.
- `src/routes/setup/+page.svelte`: the mode step, and the rerouted test and
  remote buttons.
- `docs/guide/getting-started.md`: the wizard section mentions the step.

## Steps

1. **Shared model id.** In `recommend.ts`, export `activeModelId(s = getSettings())`.
   It returns `s.activeLocalModelFilename || null` in local mode, or
   `s.inferenceBackend.remoteModelId || null` in remote mode. Move the logic
   out of `McpToolList.svelte` and import it there.
2. **Rule.** Export:
   ```ts
   export type LeanReason = 'small-model' | 'weak-hardware' | null;
   export function recommendLean(input: {
   	modelId: string | null;
   	hardware: Pick<HardwareInfo, 'gpu_available' | 'gpu_integrated_slow'> | null;
   }): { lean: boolean; reason: LeanReason };
   ```
   - `parseParamsB(modelId)` ≤ 9 → `{ lean: true, reason: 'small-model' }`.
   - Otherwise, `hardware` given and
     `(!hardware.gpu_available || hardware.gpu_integrated_slow)` →
     `{ lean: true, reason: 'weak-hardware' }`.
   - Otherwise → `{ lean: false, reason: null }`. That includes an unknown size
     with no hardware, which is the remote path.
     `HardwareInfo` is imported as a type from `setup.svelte.ts`.
3. **Tests** (`recommend.test.ts`):
   - `Qwen3.5-9B-IQ4_NL` → small-model.
   - `Qwen3.5-4B-IQ4_NL` → small-model.
   - `qwen/qwen3.6-35b-a3b` with a good GPU → full.
   - A 27B model with `gpu_available: false` → weak-hardware.
   - `gpt-oss` (unknown size) with no hardware → full.
   - An unknown size with a slow integrated GPU → weak-hardware.
4. **Wizard state.** In `setup.svelte.ts`:
   - Add `'mode'` to `SetupStep`.
   - Add `leanChoice = $state<boolean>(false)` and `leanReason = $state<LeanReason>(null)`.
   - Add `modeRemote = $state(false)`.
   - Add `enterModeStep(remote: boolean, remoteModelId: string | null = null)`.
     On the local path it uses the wizard's `selectedModel` (the catalog id the
     user picked, or the imported file's name) and `hardware`. On the remote
     path it uses `remoteModelId`, which the page passes from
     `remoteConfig.remoteModelId`, and `null` for hardware, because the model
     does not run on this machine. It sets `leanChoice` and `leanReason` from
     `recommendLean`, sets `modeRemote = remote`, and calls `setStep('mode')`.
   - Add `confirmMode()`, which calls
     `updateSettings({ leanMode: leanChoice, leanNoticeShown: true })`.
   - `resetSetup()` clears the new state.
5. **Rerouting.**
   - Local path: the test step's Continue and Skip buttons (`+page.svelte:422`,
     `:430`) call `enterModeStep(false)` instead of `setStep('done')`.
   - Remote path: the button that calls `finishRemoteSetup()` calls
     `enterModeStep(true, remoteConfig.remoteModelId || null)` instead. The
     mode step's Continue calls `confirmMode()`, then `finishRemoteSetup()`
     when `modeRemote` is true, or `setStep('done')` when it is false.
6. **Mode step UI.** In `+page.svelte`, add `{:else if step === 'mode'}`,
   matching the other `wizard-step` blocks:
   - `<h1>How much should Haruspex do?</h1>`
   - Two radio cards bound to `leanChoice`:
     - **Lean**: "Chat and research. Best for small models and slow
       machines."
     - **Full**: "Everything, including the Code and Shell tabs."
   - Below the cards, one line, only when `leanReason` is set: "Recommended
     for a model of 9B or smaller." for `small-model`, or "Recommended for a
     machine without a fast GPU." for `weak-hardware`. The recommended card
     shows a "(recommended)" suffix, the same wording as the model picker.
   - A note in a `title` tooltip on the step heading: "You can change this
     later in Settings → General → Lean mode."
   - Back (to the test or remote step) and Continue buttons.
7. **Guide.** In `getting-started.md` "First run: the setup wizard", add one
   sentence: the wizard ends by asking for Lean or Full, recommends Lean for a
   model of 9B or smaller or a machine without a fast GPU, and either can be
   changed in Settings → General → Lean mode.

## Build gate

```bash
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- Unit: `recommend.test.ts`, plus the existing suite (it covers
  `McpToolList`'s use of the moved helper through `npm run check`).
- Live, local path: run `resetSetup` (or clear settings) and pick the 9B. After
  the test query, the mode step shows Lean pre-selected with the 9B line. Pick
  Full: the app opens with all tabs and no badge. Repeat and keep Lean: two
  tabs and the badge.
- Live, remote path: connect to `compute:3000` with a model id that has no size.
  Full is pre-selected with no reason line. Continue finishes remote setup.
- After either path, `leanNoticeShown` is `true` in `webview-store.json`.

## Commit

`feat(setup): recommend lean or full mode at the end of the wizard`

PR body names `docs/guide/getting-started.md`.

## Rollback

Revert the commit. The wizard goes straight from test to done again, and
`McpToolList` keeps a working import if the revert is whole. A leftover
`leanNoticeShown` key is unused until phase 07. Users who already chose keep
their `leanMode` value.
