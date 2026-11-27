# Phase 04 — Clip checks in the report, and `clip` in `checkGlb`

**Depends on:** 01, 02, 03 · **Enables:** `check_3d`'s `clip` (05)

## Goal

Every `checkGlb` result carries the clip checks: the GLB specialist and
`check_3d` both get one line per clip. With `clip`, `checkGlb` returns that
clip's detail and its motion sheet instead of the still sheet.

## Files touched

- `src/lib/glb/check.ts` — `CheckOptions.clip`; run `inspectMotion`; choose
  the sheet; compose the text.
- `src/lib/glb/check.test.ts` — cases below.
- `src/lib/glb/format.ts` — `formatReport` takes `clipLines` and `clipDetail`
  and cuts clip lines first when over `MAX_REPORT_CHARS`.
- `src/lib/glb/format.test.ts` — cases below.
- `src/lib/specialists/kinds/glb.ts` — nothing to change in code (it calls
  `checkGlb` without `clip`); its test gains the clip summary in a fixture.
- `src/lib/specialists/kinds/glb.test.ts` — the clip lines reach the
  specialist's report.

## Steps

1. `CheckOptions` gains `clip?: string`.
2. In `checkGlb`, after the report (and after normalising, on the reloaded
   scene, since normalising may have moved the floor):
   - `clips = inspectMotion(THREE, gltf)` (`[]` when the GLB has none).
   - If `opts.clip` is set and no clip has that exact name, return
     `{ problems: ["No clip named X. Clips: A, B, C."] }` or
     `"… The GLB has no clips."`.
   - With a matching clip, `motion = clips.find((c) => c.name ===
     opts.clip)`, `png = renderMotionSheet(THREE, scene, clip,
     motion.fastest)` and `clipDetail = formatClip(motion, png !== null)`.
     Otherwise `png = renderSheet(…)` as today and no detail.
   - `text = formatReport(report, { normalisedFrom, clipLines:
     formatClipLines(clips), clipDetail })`.
   - `GlbCheck` gains `clip?: string`, the clip the sheet shows, so callers
     can word their note.
3. `formatReport`: the existing `Animations: …` line is replaced by the clip
   lines when there are clips (they carry the same names, lengths and track
   counts), and `clipDetail` follows them. When the text is over
   `MAX_REPORT_CHARS` after the existing list limits, drop clip lines from
   the end, keeping the clip named by `clip`, and add `- and N more clips
   (pass clip to check one).`. If it is still over with every other clip
   line dropped, the text is cut at `MAX_REPORT_CHARS` as today; the detail
   comes last, so it is what gets cut.

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npx vitest run src/lib/glb src/lib/specialists`

## Test plan

- `check.test.ts` (real three, WebGL mocked as today): a GLB with two clips
  and no `clip` returns the still sheet and two clip lines; with `clip:
  'B'` it returns the motion sheet's PNG and B's detail; with `clip: 'Z'`
  it returns the problem listing A and B; a GLB with no clips and `clip`
  set says it has none; normalising plus `clip` measures the normalised
  scene.
- `format.test.ts`: the clip lines replace `Animations:`; a report with 40
  clips stays under the limit, keeps the named clip, and ends with the
  "and N more clips" line.
- `glb.test.ts`: the specialist's report includes the clip lines and never
  a motion sheet.

## Commit

`feat(glb): clip checks in every GLB report, and one clip's motion sheet on request`

## Rollback

Revert the commit; the specialist and `check_3d` return to the still sheet
and the `Animations:` line.
