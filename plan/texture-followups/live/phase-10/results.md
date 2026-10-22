# Phase 10 — live run of transition sets (2026-10-21)

Model: `tcclaviger/ThinkingCap-3.8-27B-PARO5` on `http://compute:3000`, through
`scripts/drive.mjs` on an e2e build of the transitions branch, which also
holds PRs 1 and 2. Images came from ComfyUI on asmodean, running Ming-Image
0.1 Design. Each `*-map.png` is the set laid out by `live_map_from_sheet`
(`transition.rs`); that test also checks the set's all-A tile against the
material's own file.

## make_asset (Code tab) — `make_asset/`

| Case | Result |
| --- | --- |
| top-set: grass, dirt path, then the set between them | All three written, plus `grass_dirt.json`, in 13.5 s. The model passed `seed_from` and `seed_from_b`. Tile 15 **matches** `grass.png`. |
| side-set: soil, turf, then the platform with the turf on top | Written in 9.2 s, `view: "side"` with a cap and `seed_from`. Tile 15 **matches** `soil.png`. |

## Asset generation, top-down farm — `job-top/`

*What to make:* "a top-down farm: grass, tilled soil, a dirt path, a pond;
a farmhouse, a fence, a scarecrow". The spec stage listed **5 top sets**:
grass meets tilled soil, the dirt path and the pond; tilled soil meets the
path; the path meets the pond. All five were drawn, judged and passed
first time, and each one's tile 15 matches its material.

On the way, the pond texture passed after 2 recipe revisions (phase 03).
Tilled soil used `stripes` for its furrows, which is the "lined all over"
use the prompt now describes.

## Asset generation, side-view platformer — `job-side/`

*What to make:* "a side-view platformer: dirt ground with a grass top,
stone ledges, a wooden bridge; a player, a slime, a coin". The spec
stage listed **2 side sets**: dirt with a grass cap, and stone ledges with
no cap. Both passed, and tile 15 matches.

**Defect found and fixed.** The model wrote `grass_top` as green tufts
over dark soil, a fair standalone texture. As a cap it read as dirt with
a few blades (`job-side/before-fix/`). The recipe prompt now says when a
texture is a set's cap, and asks for the surface itself filling the tile.
I reran with only that recipe, its tiles and the set removed, and the
model wrote a solid green turf. The cap now reads as grass
(`job-side/dirt_with_grass_cap-map.png`). Commit: "fix(assets): ask for a
cap texture as the surface itself, not tufts over soil", with a test.

## Seen, not fixed

- **Specks near the border.** A few 2–3 pixel islands of one material sit
  in the other near the border, in the grass–pond map for example. The
  cleanup only removes lone single pixels.
- **The rim colour is the model's choice.** On the platform it picked a
  dark green, so cliff sides and undersides are outlined in green, which
  reads a little like moss.
- **The side preview layout is a scatter.** Its corner grid was chosen to
  use all 16 tiles, not to look like a level, so the judge sees ragged
  shapes rather than a platform run.
- **ComfyUI time.** Each 1024 sheet took about 198 s on asmodean, even with
  ComfyUI warm (the bridge and coin sheet in the second job). sd-server
  measured 26–39 s for the same work (`measurements-phase-24-gguf.md`).
