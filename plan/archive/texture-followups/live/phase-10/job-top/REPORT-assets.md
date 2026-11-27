# Asset report

Spec: `assets/haruspex-assets.json` — 7 asset(s), 306.3s total.

**7 generated**, 0 already present, 0 unresolved, 0 failed.

## Contact sheet

The set, side by side. Incoherence is only visible this way — one asset
at a time always looks fine.

![Contact sheet](assets/contact-sheet.png)

## Style anchor

Generated in 1 attempt(s) → `assets/haruspex-anchor.png`, accepted automatically — nobody saw it. Palette: 32 colour(s). Recipe: `assets/haruspex-anchor.json`.

## Sheets

**2 of 2 sheet generation(s) cut exactly.** 1 were retries of subjects an earlier sheet did not deliver.

| Sheet | Round | Subjects | Exact | Missing | Touching | Rejected | Keyed | Seed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `farm` | 1 | 3 | yes | 0 | 0 | 1 | — | 1916851717 |
| `farm` | 2 | 1 | yes | 0 | 0 | 0 | — | 1165925670 |

## Assets

| Asset | Kind | Outcome | Attempts | Seed | Time | Degraded |
| --- | --- | --- | --- | --- | --- | --- |
| `grass` | texture | done | 1 | 2993663101 | 3.3s | — |
| `tilled_soil` | texture | done | 1 | 3981396935 | 3.4s | — |
| `dirt_path` | texture | done | 1 | 2992608302 | 9.0s | — |
| `pond` | texture | done | 3 | 2077956170 | 42.1s | — |
| `farmhouse` | sprite | done | 2 | 1165925670 | 19.7s | — |
| `fence` | sprite | done | 1 | 1916851717 | 5.2s | — |
| `scarecrow` | sprite | done | 1 | 1916851717 | 7.0s | — |

## Textures drawn in code

Drawn from a recipe rather than by the image model, so each tiles and is seen from above. The tiles of one texture are interchangeable.

| Texture | Layers | Tiles | Verdict |
| --- | --- | --- | --- |
| `grass` | tufts, speckle | 4 | passed |
| `tilled_soil` | stripes, stripes, speckle | 4 | passed |
| `dirt_path` | blotches, speckle | 4 | passed |
| `pond` | waves, waves, speckle | 4 | passed after 2 revision(s) |

## Transition sets

The 16 edge tiles where two textures meet, or platform ground against air, drawn from the textures' recipes: a 4×4 sheet, with a JSON file beside it naming each tile's corners.

| Set | View | Materials | Sheet | Verdict |
| --- | --- | --- | --- | --- |
| `grass_to_tilled_soil` | top | `grass` meets `tilled_soil` | `assets/generated/transition/grass_to_tilled_soil.png` | passed |
| `grass_to_dirt_path` | top | `grass` meets `dirt_path` | `assets/generated/transition/grass_to_dirt_path.png` | passed |
| `grass_to_pond` | top | `grass` meets `pond` | `assets/generated/transition/grass_to_pond.png` | passed |
| `tilled_soil_to_dirt_path` | top | `tilled_soil` meets `dirt_path` | `assets/generated/transition/tilled_soil_to_dirt_path.png` | passed |
| `dirt_path_to_pond` | top | `dirt_path` meets `pond` | `assets/generated/transition/dirt_path_to_pond.png` | passed |

## Licensing

Model: **ming_image_0.1_design_int8_convrot.safetensors** — licence unknown. Haruspex did not provide this checkpoint and cannot state what may be done with what it produces.

Generated images are generally not copyrightable in their own right. Some storefronts
require AI-generated content to be disclosed.
