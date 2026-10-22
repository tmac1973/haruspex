# Phase 05 — live check of the new layers (2026-10-21)

Model: `tcclaviger/ThinkingCap-3.8-27B-PARO5` on `http://compute:3000`, through
`scripts/drive.mjs` on an e2e build of this branch, using `make_asset` in the
Code tab. No image backend was needed.

| Ask | Layer used | Time | Reads as |
| --- | --- | --- | --- |
| 32 px oak plank floor | `planks` | 6.4 s | yes: staggered ends, grain, relief |
| 32 px cobblestone street | `stones` | 3.9 s | yes: rounded raised stones, dark mortar |
| 32 px hexagonal stone paving | `hex` | 6.0 s | yes. The model redrew once, unprompted, after looking at the preview |
| 32 px herringbone brick path | `herringbone` | 3.9 s | yes |
| 32 px short meadow grass | `tufts` (×2) | 3.5 s | yes. Clumps repeat per copy, as any one tile does; variants mix them |

Every recipe passed Rust's check first time. `make_asset-3x3.png` shows the
five laid 3×3. Before this phase, the job's wooden floor was `bricks` with
every board ending on the same column (phase 01).
