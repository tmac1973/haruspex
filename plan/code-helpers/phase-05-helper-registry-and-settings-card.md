# Phase 05 — Helper registry, setting and Helpers card

**Depends on:** nothing · **Enables:** `check_3d` being offered only when its
helper is on (06), and later helpers

## Goal

A small registry where a helper declares an id, a label, a one-line summary,
a tooltip and the names of the tools it owns; a `codeHelpers` setting holding
which helpers are on (all off by default); a **Helpers** card in Settings →
Code with one switch per registered helper; and the tool filter offering a
helper's tools in the Code tab only while that helper is on. This phase
registers no helper, so the card shows "No helpers yet." until 06.

## Files touched

- `src/lib/helpers/registry.ts` — new: `HelperDef { id, label, summary,
  tooltip, tools: string[], writes: boolean }`, `registerHelper`, `helpers()`,
  `helperForTool(name)`, `helperOn(id)` (reads `getSettings().codeHelpers`).
- `src/lib/helpers/index.ts` — new: imports each helper module (empty list in
  this phase), imported by the card and by `agent/tools/index.ts`.
- `src/lib/helpers/registry.test.ts` — new.
- `src/lib/stores/settings.ts` — `codeHelpers: Record<string, boolean>` on
  `AppSettings`, default `{}`, loaded with a guard (non-object → `{}`, keep
  only boolean values); `setCodeHelper(id, on)` setter.
- `src/lib/stores/settings.test.ts` — default and load-guard cases.
- `src/lib/components/settings/HelpersSection.svelte` — new: the card.
- `src/lib/components/settings/HelpersSection.test.ts` — new.
- `src/lib/components/settings/CodeSection.svelte` — render
  `<HelpersSection />` right after `<SpecialistsSection />`.
- `src/lib/agent/tools/registry.ts` — in `shouldIncludeCodeTool`, after the
  read-only check: `const helper = helperForTool(name); if (helper) return
  isCodeTab(opts) && helperOn(helper.id);`. In `subtaskExcludes`, add `||
  helperForTool(name) !== undefined`. `CODE_TAB_ONLY` is not changed.
- `src/lib/agent/tools/codeTabProfile.ts` — `isCodeWriteTool` also returns
  true when `helperForTool(name)?.writes === true`, importing
  `#lib/helpers/registry.ts` (which imports only `stores/settings.ts`, so no
  cycle); the module comment changes from "only constants" to "constants and
  the helper registry lookup".
- `src/lib/agent/tools/codeTabProfile.test.ts` — expectations account for
  helper tools being absent while their helper is off.

## Steps

1. Write the registry. `registerHelper` throws on a duplicate id or a tool
   name already owned by another helper.
2. Add the setting. `setCodeHelper` commits `{ ...settings, codeHelpers: {
   ...settings.codeHelpers, [id]: on } }` (plain JSON, no `$state` proxy).
3. Build the card, matching `.settings-section` (card) and `.toggle-row`
   (switch) conventions: heading **Helpers**; one sentence, "Tools the agent
   runs without a model, such as rendering a 3D model to check it."; one
   `.toggle-row` per helper with its label and `summary`, the `tooltip` as the
   row's `title`; "No helpers yet." when the registry is empty.
4. Gate the tools in `registry.ts` as above. A helper tool must not be
   offered in Shell Code mode, Chat, jobs or subtasks: `isCodeTab(opts)` plus
   the `subtaskExcludes` change above.
5. Run `./scripts/export-ipc-types.sh` only if a `#[ts(export)]` type changed
   (none should).

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npx vitest run src/lib/helpers src/lib/stores src/lib/components/settings src/lib/agent/tools`

## Test plan

- Registry: duplicate id and duplicate tool throw; `helperForTool` finds the
  owner; `helperOn` is false for an unknown id and for `{}`.
- Settings: default `codeHelpers` is `{}`; loading `{ codeHelpers: 'x' }`
  gives `{}`; `{ codeHelpers: { '3d': true, bad: 1 } }` keeps only `'3d'`.
- Card: with a test helper registered, the switch reflects the setting and
  toggling calls `setCodeHelper`; empty registry shows "No helpers yet.".
- Tool filter: a test helper with tool `t_tool` is absent when off, present
  in the Code tab when on, absent in Shell Code mode, Chat and a subtask even
  when on, absent in a read-only session when `writes: true`.

## Commit

`feat(code): helper registry and Settings → Code → Helpers card`

## Rollback

Revert the commit. The `codeHelpers` key left in a user's settings is ignored
by older code (settings are plain JSON and unknown keys are harmless). No
helper exists yet, so no tool disappears.
