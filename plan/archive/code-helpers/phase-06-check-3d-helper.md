# Phase 06 — The 3D helper and `check_3d`

**Depends on:** 01, 03, 04, 05 · **Enables:** the live rerun (07)

## Goal

Register the **3D** helper and its one tool, `check_3d`. On a build module it
runs the module (04), normalises if asked (01), writes the GLB and returns the
report and render sheet (01). On a `.glb`/`.gltf` it returns the same report
and sheet without writing, or writes a normalised copy to `out`. Document it
in a new `helpers` guide page.

## Files touched

- `src/lib/helpers/three/helper.ts` — new: `registerHelper({ id: '3d', label:
  '3D', summary: 'Builds and renders 3D models the agent writes.', tooltip:
  'Runs a Three.js build module or checks a .glb file, then shows the agent a
  six-view render and a size and parts report. Needs no model and no
  network.', tools: ['check_3d'], writes: true })`.
- `src/lib/agent/tools/check-3d.ts` — new: the tool's schema and `execute`.
- `src/lib/agent/tools/check-3d.test.ts` — new.
- `src/lib/agent/tools/index.ts` — `import '#lib/agent/tools/check-3d.ts';`.
- `src/lib/helpers/index.ts` — `import '#lib/helpers/three/helper.ts';`.
- `docs/guide/helpers.md` — new guide page.
- `docs/guide/code.md` — one line pointing at the `helpers` page.
- `docs/guide/settings.md` — the Code section lists Helpers.

## Steps

1. Schema. `check_3d`, category `fs`, parameters:
   - `path` (required): a `.js`/`.mjs` build module, or a `.glb`/`.gltf`.
   - `out`: where to write the GLB. Default for a module: the same path with
     `.glb`. Required for a `.glb`/`.gltf` input when `height` or `ground` is
     given; refused when it equals `path`.
   - `height`: metres; scales the result uniformly to this height.
   - `ground`: boolean; feet on y = 0, centred on x and z.
   - `max_triangles`: number; warn when over.
   Description (kept under ~1,200 characters):
   > Build a 3D model from a Three.js module you write, or check a .glb made
   > another way (Blender). Returns size, parts and problems, and a render
   > sheet (front, right, back, left, top, three-quarter, over a floor grid).
   > A module imports nothing; its default export gets THREE (the app's
   > three) and kit (mergeGeometries, mergeVertices, RoundedBoxGeometry,
   > ConvexGeometry, ParametricGeometry, createNoise(seed), random(seed)) and
   > returns an Object3D, or { object, animations } for clips:
   > ```js
   > export default function build(THREE, kit) {
   >   const asset = new THREE.Group();
   >   const glass = new THREE.MeshStandardMaterial({ color: 0x4aa8e0, transparent: true, opacity: 0.5 });
   >   const pts = [[0, 0], [0.12, 0.02], [0.15, 0.1], [0.05, 0.22], [0.04, 0.3]].map(([x, y]) => new THREE.Vector2(x, y));
   >   const flask = new THREE.Mesh(new THREE.LatheGeometry(pts, 10), glass);
   >   flask.name = 'Flask';
   >   asset.add(flask);
   >   return asset;
   > }
   > ```
   > Name every mesh. Units are metres, y is up, the front faces +z.
2. `execute`:
   1. If `ctx.codeReadOnly`, return `toolError(READ_ONLY_REFUSAL)` (from
      `codeTabProfile.ts`) before reading anything. Validate `path`'s extension and the params (`height` finite > 0;
      `max_triangles` integer > 0; `out` ends in `.glb`).
   2. Module: read the source via `assetIo(ctx)`; `runBuildModule`. On errors,
      return `The check failed.` + each error as `- line N: message` + `Fix
      <path> and call check_3d again.` and write nothing.
   3. GLB/glTF: read the bytes; a `.gltf` with external buffers or images
      (any `uri` that isn't a `data:` URI) is refused with "Export it as .glb,
      or embed its buffers and images."
   4. `loadGlb`; `inspectGlb` with `maxTriangles`. Problems fail as in 2.
   5. When `height`/`ground` is given: `normaliseGlb`, then `loadGlb` +
      `inspectGlb` again on the new bytes so the report and sheet describe
      what is written; keep the "before" bounds for the text.
   6. Write when there is something to write (a module's GLB, or a normalised
      copy) with `writeAsset(…, overwrite: true, …)` under the writer lease
      (`isCodeWriteTool` covers it through phase 05's `writes: true`). A
      `.glb` input with no normalisation writes nothing.
   7. `renderSheet`; push to `pendingImages` under the usual conditions.
   8. Result: `Wrote <out>.` or `Checked <path> (nothing written).`, then
      `formatReport(report, { normalised, maxTriangles })`, then, with the
      sheet attached, `The render sheet is attached: compare it with what you
      meant to make before you finish.` Thumbnail: the sheet.
   9. `disposeTree` both scenes.
3. Display label: `Check <basename of path>`. `check_3d` joins no family in
   `src/lib/agent/tools/families.ts`, so it is a core tool, never deferred; a
   test in `check-3d.test.ts` asserts no `TOOL_FAMILIES` entry `has` it.
4. Guide page `docs/guide/helpers.md` (frontmatter `title: Helpers`,
   `description: …`), sections: what helpers are; turn one on (Settings →
   Code → Helpers); the 3D helper (what it accepts, what the agent gets,
   height/ground/max_triangles in plain words, that it writes the `.glb`
   beside the module); what it doesn't do (no model, no animation preview,
   no scene projects, no repair, Code tab only). Under 6 KB, compact tables,
   no Prettier on the guide.

## Build gate

- `npm run build:three-kit`
- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npx vitest run src/lib/agent/tools src/lib/helpers src/lib/glb`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan

Unit, with `runBuildModule`, `assetIo` and `renderSheet` mocked:

- module that builds → writes `<name>.glb`, result has `Wrote`, `Size:`.
- module error on line 7 → `- line 7:` and nothing written.
- `.glb` input, no params → `nothing written`, report present.
- `.glb` input with `height` and no `out` → refused; with `out` equal to
  `path` → refused; with `out` → writes there, text says `Normalised from`.
- `.gltf` with an external `uri` → refused with the embed message.
- `height: 0` / `max_triangles: -1` → refused.
- read-only session → `execute` returns the read-only refusal and
  `runBuildModule` is never called (the filter test in 05 already hides it).
- helper off → `check_3d` not offered (filter); on → offered.

Manual in `npm run tauri dev`: turn on 3D, ask a Code session for "a small
wooden crate" and see the module written, `check_3d` called, the sheet on the
tool card and `crate.glb` open in the editor's 3D view.

## Commit

`feat(helpers): 3D helper with check_3d for build modules and GLB files`

## Rollback

Revert the commit: the helper and tool disappear, and the card goes back to
"No helpers yet.". A user's `codeHelpers: { '3d': true }` stays in settings
and is ignored. GLBs already written stay in their projects.
