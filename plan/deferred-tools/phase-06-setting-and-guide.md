# Phase 06 — The setting, its default and the guide

**Depends on:** phase 04, and phase 05's result for the default · **Enables:**
release

## Goal

Show the setting in Settings → General, set its default from the model size,
and describe it in the user guide.

## Files touched

- `src/lib/stores/settings.ts`: default `deferTools: 'auto'`.
- `src/lib/components/settings/GeneralSection.svelte`: a three-way control.
- `src/lib/components/settings/GeneralSection.test.ts` (new).
- `docs/guide/settings.md` and `docs/guide/chat.md`: the setting and what the
  user sees when the model loads tools.
- `docs/guide/lean-mode.md`: one line saying lean mode never defers.

## Steps

1. **Control.** Under Settings → General: **Load tools when needed**, with
   Auto, On and Off. One sentence under it: "Sends fewer tools with each
   message." A `title` tooltip gives the detail: "Auto turns it on for models
   above 12B. The model loads a group of tools, such as video editing, when a
   request needs it." Disabled, with a tooltip, while lean mode is on.
2. **Default.** `'auto'`, with the boundary that phase 05 found. If phase 05
   shows the 9B loads reliably, `'auto'` can mean on for every size; then
   remove the size check and keep the Off choice.
3. **Chat display.** A `load_tools` step shows in the step list as "Loaded
   video tools" (`displayLabel`). No other UI.
4. **Guide.** In `settings.md`, the setting with its three values. In
   `chat.md`, one short paragraph: what "Loaded … tools" in the steps means,
   and that a first use of a group takes one more step. Keep each page under
   6 KB.

## Build gate

```bash
npm run check && npm run lint && npm run format:check && npm run test
node scripts/guide-check.mjs
```

## Commit

`feat(settings): load tool groups when needed, on by default for larger models`

The PR body names `docs/guide/settings.md` and `docs/guide/chat.md`.

## Rollback

Set the default back to `'off'`. Users who chose On keep it.
