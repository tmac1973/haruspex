# Asset report

Spec: `assets/haruspex-assets.json` — 7 asset(s), 12.1s total.

**1 generated**, 6 already present, 0 unresolved, 0 failed.

## Contact sheet

The set, side by side. Incoherence is only visible this way — one asset
at a time always looks fine.

![Contact sheet](assets/contact-sheet.png)

## Style anchor

Reused the committed anchor at `assets/haruspex-anchor.png`, approved by a human. Palette: 30 colour(s). Recipe: `assets/haruspex-anchor.json`.

## Assets

| Asset | Kind | Outcome | Attempts | Seed | Time | Degraded |
| --- | --- | --- | --- | --- | --- | --- |
| `dirt_ground` | texture | skipped | 0 | — | 0.0s | — |
| `grass_top` | texture | done | 1 | 353086513 | 2.9s | — |
| `stone` | texture | skipped | 0 | — | 0.0s | — |
| `wooden_bridge` | sprite | skipped | 0 | — | 0.0s | — |
| `player` | sprite | skipped | 0 | — | 0.0s | — |
| `slime` | sprite | skipped | 0 | — | 0.0s | — |
| `coin` | sprite | skipped | 0 | — | 0.0s | — |

## Textures drawn in code

Drawn from a recipe rather than by the image model, so each tiles and is seen from above. The tiles of one texture are interchangeable.

| Texture | Layers | Tiles | Verdict |
| --- | --- | --- | --- |
| `grass_top` | speckle, speckle, speckle | 4 | passed |

## Transition sets

The 16 edge tiles where two textures meet, or platform ground against air, drawn from the textures' recipes: a 4×4 sheet, with a JSON file beside it naming each tile's corners.

| Set | View | Materials | Sheet | Verdict |
| --- | --- | --- | --- | --- |
| `dirt_with_grass_cap` | side | `dirt_ground` with `grass_top` on top | `assets/generated/transition/dirt_with_grass_cap.png` | passed |
| `stone_ledge` | side | `stone` | `assets/generated/transition/stone_ledge.png` | already present |

## Licensing

Model: **ming_image_0.1_design_int8_convrot.safetensors** — licence unknown. Haruspex did not provide this checkpoint and cannot state what may be done with what it produces.

Generated images are generally not copyrightable in their own right. Some storefronts
require AI-generated content to be disclosed.
