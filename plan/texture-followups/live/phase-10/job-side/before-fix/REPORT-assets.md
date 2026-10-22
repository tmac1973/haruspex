# Asset report

Spec: `assets/haruspex-assets.json` — 7 asset(s), 650.1s total.

**7 generated**, 0 already present, 0 unresolved, 0 failed.

## Contact sheet

The set, side by side. Incoherence is only visible this way — one asset
at a time always looks fine.

![Contact sheet](assets/contact-sheet.png)

## Style anchor

Generated in 1 attempt(s) → `assets/haruspex-anchor.png`, accepted automatically — nobody saw it. Palette: 30 colour(s). Recipe: `assets/haruspex-anchor.json`.

## Sheets

**3 of 3 sheet generation(s) cut exactly.** 0 were retries of subjects an earlier sheet did not deliver.

| Sheet | Round | Subjects | Exact | Missing | Touching | Rejected | Keyed | Seed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `structures` | 1 | 1 | yes | 0 | 0 | 0 | — | 329071104 |
| `characters` | 1 | 2 | yes | 0 | 0 | 0 | — | 1324675307 |
| `items` | 1 | 1 | yes | 0 | 0 | 0 | — | 923614264 |

## Assets

| Asset | Kind | Outcome | Attempts | Seed | Time | Degraded |
| --- | --- | --- | --- | --- | --- | --- |
| `dirt_ground` | texture | done | 3 | 699584486 | 23.4s | — |
| `grass_top` | texture | done | 1 | 353086513 | 3.4s | — |
| `stone` | texture | done | 1 | 3357104378 | 3.7s | — |
| `wooden_bridge` | sprite | done | 1 | 329071104 | 197.9s | — |
| `player` | sprite | done | 1 | 1324675307 | 2.1s | — |
| `slime` | sprite | done | 1 | 1324675307 | 3.8s | — |
| `coin` | sprite | done | 1 | 923614264 | 198.2s | — |

## Textures drawn in code

Drawn from a recipe rather than by the image model, so each tiles and is seen from above. The tiles of one texture are interchangeable.

| Texture | Layers | Tiles | Verdict |
| --- | --- | --- | --- |
| `dirt_ground` | speckle, speckle, cracks | 4 | passed after 2 revision(s) |
| `grass_top` | tufts | 4 | passed |
| `stone` | bricks | 4 | passed |

## Transition sets

The 16 edge tiles where two textures meet, or platform ground against air, drawn from the textures' recipes: a 4×4 sheet, with a JSON file beside it naming each tile's corners.

| Set | View | Materials | Sheet | Verdict |
| --- | --- | --- | --- | --- |
| `dirt_with_grass_cap` | side | `dirt_ground` with `grass_top` on top | `assets/generated/transition/dirt_with_grass_cap.png` | passed |
| `stone_ledge` | side | `stone` | `assets/generated/transition/stone_ledge.png` | passed |

## Licensing

Model: **ming_image_0.1_design_int8_convrot.safetensors** — licence unknown. Haruspex did not provide this checkpoint and cannot state what may be done with what it produces.

Generated images are generally not copyrightable in their own right. Some storefronts
require AI-generated content to be disclosed.
