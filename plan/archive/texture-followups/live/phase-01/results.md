# Phase 01 — live test of #613 (2026-10-21)

Model: `tcclaviger/ThinkingCap-3.8-27B-PARO5` on `http://compute:3000`
(vLLM, vision on). Image backend for the job and the backend cases: ComfyUI
at `asmodean.localdomain:8188`, Ming-Image 0.1 Design.

**Deviation from the plan.** I drove the app with the existing
`scripts/drive.mjs` (an isolated e2e build through tauri-driver), not a new
`run.mjs`. It already does sessions, turns, prompts and UI clicks, and
keeps its data apart from the installed app. It gained a `settings <json>`
command so a run can switch the image backend without a restart. Tim's
installed 0.2.8 AppImage kept running throughout, untouched.

## make_asset (Code tab), folder `~/haruspex-live/textures-01`

Previews: `make_asset-3x3.png` (gravel, road, moss, sand) and `wall-3x3.png`.
Transcripts: `make_asset/transcript-*.md`.

| Case | Result | Notes |
| --- | --- | --- |
| gravel-variants | pass, 9.4 s | `gravel.png` and `_1`–`_3` written. |
| asphalt-no-markings | pass, 3.4 s | No `stripes` layer; the model said markings would repeat every 32 px. |
| palette-from | pass, 4.9 s | Drawn in the gravel's greys, as asked. The model warned that this left no green for moss. |
| revise-after-look | pass, 10 s | The model saw its `wall_face` band repeat in the 3×3 preview, removed it, and redrew with `overwrite: true`. |
| gravel-no-backend (sand) | pass, 7.4 s | Image backend none; the texture was drawn and checked against the preview. |
| sprite-no-backend (coin) | pass, with a fix | Refused, naming Settings → Image. **Defect:** the refusal ended "A texture works without it", and the model offered to draw the coin as a texture. Fixed: the message now says a texture fills the tile and can't draw an object (`fix(assets): …`, with a test). |

## Asset generation job, folder `~/haruspex-live/textures-01-job`

*What to make:* "a top-down village: grass, dirt path, cobbled square,
wooden floor, pond water; a cottage and a well", Unattended. It succeeded
in 256 s. The spec has 5 textures and 2 sprites; all 7 were generated,
none unresolved. Files: `job/REPORT-assets.md`, `job/haruspex-assets.json`,
`job/contact-sheet.png`, and `job-3x3.png` (the five textures laid 3×3).

- Every texture was drawn from a recipe, and the judge saw each one as the
  480 px 3×3 preview with the new hint (checked in the run's debug log).
  All five passed first time.
- **Seen, not a code defect:** the dirt path's dark "footprint" blotches sit
  in the same spot in every copy, and the judge passed it anyway. This is
  judge leniency on a single verdict.
- **Seen, motivates phase 05:** the wooden floor is `bricks` with `w: 32`
  and no offset, so every board ends on the same column. The planks layer,
  with staggered ends, is what the model was reaching for. The cobbled
  square is likewise square bricks; `stones` will read better.

## Outcome

#613 works live through both entry points. The one defect found is fixed
in this PR.
