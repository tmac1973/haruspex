# Phase 03 — The models.json spec

**Depends on:** nothing · **Enables:** 04, 07, 08, 10, 12

## Goal
One file format that says what a 3D run makes: guided planning writes it, the
job reads it, the report and the checker judge against it. Types, parse,
validate, render and paths, with tests, and no UI.

## Files touched
- `src/lib/models3d/spec/types.ts` (new)
- `src/lib/models3d/spec/paths.ts` (new)
- `src/lib/models3d/spec/parse.ts` (new)
- `src/lib/models3d/spec/validate.ts` (new)
- `src/lib/models3d/spec/write.ts` (new)
- `src/lib/models3d/spec/spec.test.ts` (new)

## Steps
1. Types:
   ```ts
   export interface ModelClip { name: string; seconds: number; loop: boolean; action: string }
   export interface ModelEntry {
     id: string;            // slug, unique
     title: string;
     description: string;   // what it looks like, for the creation model
     height_m: number;      // 0.05–50
     parts: string[];       // pivot names the animator relies on; [] for a static prop
     clips: ModelClip[];    // [] = no animation stage for this entry
     dir: string;           // assets/generated/model/<id>/
   }
   export interface ModelSpec { version: 1; style: string; entries: ModelEntry[] }
   ```
   `style` is one shared line (palette, low-poly level) every creation prompt gets.
2. `paths.ts`: `DEFAULT_MODELS_SPEC_PATH = 'assets/haruspex-models.json'`; `modelDir(id) = \`assets/generated/model/\${id}/\``; `modelFiles(entry) => { build: dir+id+'.js', anim: dir+id+'.anim.js', glb: dir+id+'.glb', sheet: dir+'sheet.png', clipSheet: (clip) => dir+'clip-'+slug(clip)+'.png' }`; `REPORT_NAME = 'REPORT-models.md'` beside the spec. Reuse `slugify`/`uniqueId` from `#lib/assets/spec/paths.ts`.
3. `parse.ts`: `parseModelSpec(json: string): ModelSpec | { problems: string[] }`. Missing `dir` is filled from `modelDir(id)`; missing `parts`/`clips` default to `[]`; `loop` defaults to true for names matching `/idle|walk|run|fly|swim/i`, false otherwise.
4. `validate.ts`: `validateModelSpec(spec): string[]` — 1 to 24 entries; ids slug-shaped and unique; `height_m` in range; part names match `/^[A-Za-z][A-Za-z0-9_]*$/` and are unique per entry; clip names unique per entry, `seconds` 0.2–10; an entry with clips has at least one part; `dir` must be under `assets/` and must not contain `..`.
5. `write.ts`: `renderModelSpec(spec)` → pretty JSON (tab indent, matches `renderAssetSpec`).
6. Tests for each rule, round-trip parse→render→parse, and defaulting.

## Build gate
`npm run check`, `npm run lint`, `npm run test -- src/lib/models3d`, `npm run format:check`.

## Test plan
Unit tests above; nothing user-visible yet.

## Commit
`feat(models3d): models.json spec for 3D model runs`

## Rollback
Revert; nothing imports it yet.
