# Phase 03 — Settings for helpers

**Depends on:** nothing · **Enables:** the Search row's endpoints (phases 05
and 08), and settings for any later helper

## Goal

Today a helper has only an on/off switch. This phase lets a helper declare its
own settings: stored as a plain-JSON blob per helper id, parsed by the helper,
and edited by a component the Helpers card shows under the helper's switch
while it is on. The 3D helper declares none, so nothing visible changes.

## Files touched

- `src/lib/stores/settings.ts` — `codeHelperConfig: Record<string, unknown>`
  (default `{}`), its load-time cleanup, and
  `setCodeHelperConfig(id, value)`.
- `src/lib/stores/settings.test.ts` — the new field's load and set.
- `src/lib/engine/settings.ts` — `mergePatch` accepts new keys under
  `codeHelpers` and `codeHelperConfig`.
- `src/lib/engine/settings.test.ts` — the open maps.
- `src/lib/helpers/registry.ts` — `HelperDef.settings?: HelperSettings<T>`
  and `helperConfig<T>(id)`.
- `src/lib/helpers/registry.test.ts` — the new functions.
- `src/lib/components/settings/HelpersSection.svelte` — render a helper's
  settings component under its switch while the switch is on.

## Steps

1. In `settings.ts`, add `codeHelperConfig: Record<string, unknown>` beside
   `codeHelpers`, default `{}`. On load, keep it only if it is a plain object,
   and keep only entries whose values are plain JSON (round-trip through
   `JSON.parse(JSON.stringify(…))` in a `try`; drop the entry on failure).
2. `setCodeHelperConfig(id: string, value: unknown)` commits
   `{ ...settings, codeHelperConfig: { ...settings.codeHelperConfig, [id]: value } }`
   like `setCodeHelper`; `commit` already snapshots through the file's
   `snapshot()`, so a `$state` proxy is never stored.
2a. Let the Remote control API set a helper it hasn't seen yet. Today
   `mergePatch` (`src/lib/engine/settings.ts`) refuses any key the current
   settings lack, so `settings.patch` with `{ codeHelpers: { search: true } }`
   fails while `codeHelpers` is `{}`. Add `const OPEN_MAPS = new
   Set(['codeHelpers', 'codeHelperConfig'])`: an entry directly under one of
   these top-level keys (a helper id) is replaced whole by the patch value,
   whether or not it existed, with no key-by-key merge below it (a secret key
   anywhere in the value is still refused). So `{ codeHelperConfig: { search:
   { rerank: null, embed: {…} } } }` sets the Search helper's whole config.
   Everything else keeps the strict rule.
3. In `registry.ts`:
   ```ts
   export interface HelperSettings<T> {
   	/** Cleans whatever is stored (absent, old or hand-edited) into a valid T. */
   	parse(raw: unknown): T;
   	/** The editor shown under the switch while the helper is on. */
   	component: () => Promise<{ default: Component<{ helperId: string }> }>;
   }
   ```
   `HelperDef` gets `settings?: HelperSettings<unknown>`. The component is a
   lazy import, so the registry (which the tool registry imports) still pulls
   in no Svelte component.
4. `helperConfig<T>(id: string): T | undefined` returns
   `def.settings.parse(getSettings().codeHelperConfig[id])`, or `undefined`
   when the helper has no settings.
5. In `HelpersSection.svelte`, for each helper with `settings` whose switch is
   on, `{#await}` the component and render it indented under the row, passing
   `helperId`. The component reads `helperConfig` and saves with
   `setCodeHelperConfig`.

## Build gate

`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.

## Test plan

- `settings.test.ts`: a missing `codeHelperConfig` loads as `{}`; a non-object
  loads as `{}`; an entry with a function or cycle is dropped; setting a
  `$state`-like proxy stores a plain clone.
- `registry.test.ts`: `helperConfig` returns the parsed value, and the parsed
  default when nothing is stored; `undefined` for a helper without settings.
- `engine/settings.test.ts`: `mergePatch` sets `codeHelpers.search` and
  `codeHelperConfig.search` when absent; replaces an existing
  `codeHelperConfig.search` whole (a new `embed` key is accepted, an omitted
  `rerank` is gone); refuses a secret key inside the value; and still refuses
  an unknown top-level key and an unknown key elsewhere.
- `HelpersSection.test.ts`: a fake helper with settings shows its
  component only while its switch is on.
- Manual: Settings → Code → Helpers looks exactly as before (the 3D helper has
  no settings).

## Commit

`feat(helpers): a helper can carry its own settings`

## Rollback

Revert the commit. A stored `codeHelperConfig` left in a user's settings file
is ignored by the old code, so a partial rollback is safe.
