# Phase 07 — Existing-user notice and model-swap hint

**Depends on:** 01, 02, 03 (so "Turn on" hides the tabs as promised), 06 · **Enables:** nothing; final phase

## Goal

Two one-time nudges, so lean mode reaches the people it fits without ever
switching itself:

1. **Existing users** who never see the wizard get a dismissible notice after
   updating, but only when phase 06's rule recommends lean mode for their
   active model or hardware.
2. **Lean users who switch to a capable model** get a hint on the header badge
   suggesting they turn lean mode off. The hint shows once per model.

## Files touched

- `src/lib/stores/settings.ts`: add `leanHintedModels: string[]` (default
  `[]`). `leanNoticeShown` was added in phase 06.
- `src/lib/lean/nudges.ts` (new): `shouldOfferLean()` and
  `shouldHintFull(modelId, settings)`.
- `src/lib/lean/nudges.test.ts` (new).
- `src/lib/components/LeanModeNotice.svelte` (new): the existing-user notice.
- `src/routes/+layout.svelte`: mount the notice after startup.
- `src/lib/components/LeanModeBadge.svelte`: the hint state.
- `src/lib/components/settings/LeanModeSetting.svelte`: mark the model when
  lean mode is turned on or off.
- `src/lib/components/LeanModeNotice.svelte` "Turn on" and
  `src/lib/stores/setup.svelte.ts` `confirmMode()`: mark the model when they
  turn lean mode on.
- `docs/guide/settings.md`: one line each on the notice and the hint.

## Steps

1. **Setting.** Add `leanHintedModels: string[]` with default `[]`. Write it
   only through a helper, `markLeanHinted(id)`, which snapshots a new array
   (`[...current, id]`). Never store a `$state` proxy.
2. **shouldOfferLean()** (async), in `nudges.ts`:
   - Return false when `leanMode` is already on or `leanNoticeShown` is true.
   - Get `modelId = activeModelId()`. If `recommendLean({ modelId, hardware: null }).lean`
     is true, return true. No hardware probe is needed in that case.
   - Otherwise, in local mode only, call `invoke<HardwareInfo>('hardware_detect')`
     and return `recommendLean({ modelId, hardware }).lean`. In remote mode,
     return false. `hardware_detect` caches its Vulkan probe for the run, so
     this costs one probe at most, once.
3. **shouldHintFull(modelId, s)** (sync): true when `s.leanMode` is on, the
   model id is not null and not in `s.leanHintedModels`, and either:
   - `parseParamsB(modelId) > 9`, or
   - `parseParamsB(modelId) === null` and `s.inferenceBackend.mode === 'remote'`.
     Hardware is not checked: a bigger model that has loaded is already running.
4. **Tests** (`nudges.test.ts`, with `invoke` mocked):
   - The notice is offered for a 9B with no probe call.
   - For a 35B with `gpu_available: false`, it is offered after one probe call.
   - For a 35B on a good GPU, it is not offered.
   - It is never offered once `leanNoticeShown` is set, or when lean is
     already on.
   - The remote path never probes.
   - After marking the active model on turn-on, the hint is false for it.
   - The hint is true for a 35B, false for a 9B, true for a remote unknown,
     false for a local unknown (imported GGUF with no size in the name), and
     false once the model is hinted.
5. **Notice.** `LeanModeNotice.svelte` is a small non-blocking card,
   bottom-right, styled like `Toasts`. It does not use the modal
   `StartupNoticeDialog`. It contains:
   - Text: "Lean mode keeps Haruspex to chat and research, which suits this
     model."
   - A `title` tooltip: "Sends far fewer tools and hides the Code and Shell
     tabs. Change it any time in Settings → General → Lean mode."
   - Buttons "Turn on" (`setLeanMode(true)`) and "Not now".
     Both buttons, and closing the card, set `leanNoticeShown: true`. The busy
     guard from phase 02 applies to "Turn on": when a Code or Shell turn is
     running, the button is disabled with the same tooltip.
6. **Mount.** In `+layout.svelte`, after the startup pass that decides the app
   is set up (the `has_any_model` check, ~:369) and outside `/setup`, call
   `void shouldOfferLean().then((show) => (offerLean = show)).catch(console.warn)`
   once. Render `<LeanModeNotice>` while `offerLean` is true. It is never shown
   in the same session as the wizard, because the wizard set `leanNoticeShown`.
7. **Hint.** In `LeanModeBadge.svelte`, derive
   `hint = shouldHintFull(activeModelId(), getSettings())`. While it is true:
   - the pill shows a small dot;
   - its `title` becomes "This model can run the full app. Click to change.";
   - a click opens Settings at the lean mode anchor, as before, and calls
     `markLeanHinted(modelId)`. The hint then clears for that model.
     The hint is for a model the user switches to _after_ lean mode is on, so
     every place that turns lean mode on also marks the model active at that
     moment: `LeanModeSetting.svelte`'s switch, the notice's "Turn on", and the
     wizard's `confirmMode()` when `leanChoice` is true (add that call in
     `setup.svelte.ts`, using the model id `enterModeStep` used). A >9B model on
     weak hardware that was recommended lean therefore gets no hint until the
     user picks a different model.
     The switch in `LeanModeSetting.svelte` is the only control that turns lean
     mode off. Its change handler calls `markLeanHinted(activeModelId())` when
     the new value is `false`, so the hint does not come back for that model if
     lean mode is turned on again.
8. **Guide.** In the settings page's lean mode section, add two lines:
   - existing users on a small model or slow machine see a one-time offer;
   - the badge shows a dot when a newly chosen model can run the full app.

## Build gate

```bash
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- Unit: `nudges.test.ts`.
- Live:
  - With an existing setup on the 9B and `leanNoticeShown` removed from
    `webview-store.json`, start the app. The card appears.
  - Click "Not now" and restart. The card does not appear.
  - Remove the flag again and click "Turn on". Lean mode is on and two tabs
    show.
  - With lean on, switch the active model to the 35B (or a remote model with
    no size). The badge shows the dot.
  - Click the badge. Settings opens and the dot is gone. Switch away and back:
    no dot.

## Commit

`feat(ui): offer lean mode to existing users and hint when a model outgrows it`

PR body names `docs/guide/settings.md`.

## Rollback

Revert the commit. No notice and no hint. The leftover `leanHintedModels` and
`leanNoticeShown` keys are unused. Lean mode itself, the wizard step and the
badge are unaffected.
