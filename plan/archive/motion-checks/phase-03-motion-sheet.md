# Phase 03 — The motion sheet

**Depends on:** 01 · **Enables:** the report's `clip` (04)

## Goal

Draw one clip as a single 1200 × 800 image a model can judge motion by: two
strips of 8 frames (right side, front) and two overlays of every frame with
trails of the fastest parts. Same size as the still sheet, so a call costs
the same.

## Files touched

- `src/lib/glb/motionSheet.ts` — new: `motionSheetLayout(box, floorY)`,
  `renderMotionSheet`.
- `src/lib/glb/motionSheet.test.ts` — new: the pure layout.
- `src/routes/dev/glb-runner/+page.svelte` — a clip menu: with a clip
  picked, show its motion sheet and detail instead of the still sheet.

## Steps

1. `motionSheetLayout(box, floorY)`: pure. Cells: row 1, eight 150 × 200 cells from
   the right (camera on +x looking −x); row 2, the same from the front
   (camera on +z); row 3, two 600 × 400 cells, right overlay and front
   overlay. Each cell gets an orthographic camera framing `box` (the union
   of every sampled pose's box, extended down to the rest floor, the rest
   pose's lowest y, `floorY`) at 1.1× its size, keeping the cell's aspect.
2. `renderMotionSheet(THREE, root, clip, fastest)` returns a PNG data URL or
   null, like `renderSheet`. `fastest` is the part names from
   `ClipMotion.fastest`; it finds those parts with `partsOf(THREE, root)`
   (01):
   - First, at rest, `floorY = posedBox(…).min.y`. Then pose with `poser`
     (01) at 8 even times over `[0, duration]`, union each pose's `posedBox`,
     and build the layout.
   - Scene as the still sheet: grey background, hemisphere light, key light,
     a `GridHelper` floor at the rest floor's y with 0.1 m lines.
   - Strips: one render per cell at that cell's time.
   - Overlays: clear the cell once, then render the 8 poses in order into it
     with every material set `transparent`, opacity rising from 0.12 to 0.62
     and `depthWrite` off; the last pose opaque with `depthWrite` on.
     Materials are restored afterwards, also on error.
   - Trails: for each part in `fastest`, its centre (`partCentre`, 01) at 24
     even times,
     projected through the overlay's camera and drawn on the 2D canvas as a
     2.5 px line in a fixed palette (`#ff5a5a`, `#ffd34d`, `#4dd2ff`,
     `#7dff6a`, `#ff7de9`) with a 5 px dot at the first point, and a legend
     of part names in the overlay's lower left.
   - Labels as the still sheet's: `Right 0.00 s` on the first cell of the
     right row and `Front 0.00 s` on the first of the front row, the time
     alone on the others, `Right, all frames + trails` and
     `Front, all frames + trails` on the overlays; thin white cell borders.
   - `poser.stop()` at the end, so the scene is back at rest.
3. Dev runner: when the loaded GLB has clips, a `<select>` of clip names
   (default: none, the still sheet). Picking one calls
   `inspectMotion` and `renderMotionSheet` and shows `formatClip`.

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npx vitest run src/lib/glb`

## Test plan

- `motionSheet.test.ts`: `motionSheetLayout(box, floorY)` gives 18 cells at
  the stated sizes covering 1200 × 800 with no overlap; a floor below the box
  extends the framing down to it; a tall box gives cameras whose frustum height fits its
  height; a wide box fits its width.
- By hand in the dev runner (`/dev/glb-runner`), with the spike's imp GLB
  (`/home/tim/projects/spike3d/anim/b-motion/assets/imp_base.glb`): pick
  Attack; the sheet shows the wind-up, strike and recovery, trails on the
  right hand and claws, and the scene's still sheet is unchanged afterwards
  when you pick none.

## Commit

`feat(glb): motion sheet of one clip, with frame strips, an overlay and trails`

## Rollback

Revert the commit; nothing outside the dev runner calls it until phase 04.
