---
title: Images
description: Draw pictures, change or extend ones you have, combine and upscale them, and make sprites, icons and tiling textures for a game.
---

## Draw a picture

Describe what you want and the assistant draws it. It takes 30 seconds to a few minutes, and you can ask for another shape or a transparent background.

Tab: Chat
Required settings: Settings → Image → Add model

Prompt:

> Draw a lighthouse on a rocky coast at dusk, in a wide shape.

Example output:

The picture appears in the answer and is kept with the conversation. Click it for full size, or hover for **Save as…**.

<!-- media: Chat answer with a generated lighthouse picture and the Save as… hover button -->

Read more: images, image-editing

## Change a picture

Attach a picture, or point at one drawn earlier, and say what to change. The original is kept and the edit appears as a new picture.

Tab: Chat
Required settings: Settings → Image → a model that can edit (for example FLUX.2 klein 4B on ComfyUI)

Prompt:

> Make this photo look like it was taken at night, but keep the house the same.

Example output:

The edited picture appears in the answer as a new one, the same shape as the original, with the house unchanged and a night sky.

<!-- media: before/after pair of a house photo turned to night -->

Read more: image-editing, media-skills

## Change only part of a picture

Name the part in words. Nothing outside it changes, and the edge is blended so the join doesn't show.

Tab: Chat
Required settings: Settings → Image → a model that can edit

Prompt:

> Change only the sky to a stormy one.

Example output:

A new picture appears with a stormy sky; the land and buildings are as they were, at the original's full size.

<!-- media: before/after with only the sky replaced -->

Read more: image-editing

## Extend a picture past its edges

Ask for a picture wider or taller. The new part is painted to continue the scene.

Tab: Chat
Required settings: Settings → Image → a bundled engine or ComfyUI model that can edit

Prompt:

> Extend it by half on the right, continuing the road into the hills.

Example output:

The picture comes back wider: the original is kept, and the road carries on into new hills on the right.

<!-- media: original picture and its extended version side by side -->

Read more: image-editing

## Combine pictures

Name several attached pictures in one request and they are merged in one edit.

Tab: Chat
Required settings: Settings → Image → a model that takes several pictures (FLUX.2 klein takes four)

Prompt:

> Put the cat from my second picture on the sofa in the first.

Example output:

A new picture appears: the living room from the first picture, with the cat from the second sitting on the sofa.

<!-- media: two input pictures and the combined result -->

Read more: image-editing

## Make a picture larger

Upscale two or four times. It sharpens as it enlarges, up to 4096 pixels on the longest side.

Tab: Chat
Required settings: Settings → Image → download or install the Upscaler

Prompt:

> Make it four times bigger for printing.

Example output:

The enlarged picture appears in the answer, four times the size and sharper. A 1024-pixel picture takes about 12 seconds.

<!-- media: zoomed crop comparing the original and the upscaled picture -->

Read more: image-editing, media-skills

## Make sprites and icons for a game

Ask for art in your project. The assistant reads the project, keeps one style, and writes PNGs at the size you ask for, with transparent backgrounds.

Tab: Code
Required settings: Settings → Image → Add model

Prompt:

> A goblin, a rat and a treasure chest for this game, 32 px, in assets/sprites/.

Example output:

It shows you the first sprite, then draws the rest in its colours:

- `assets/sprites/goblin.png`
- `assets/sprites/rat.png`
- `assets/sprites/chest.png`

<!-- media: the three sprites on a checkerboard background in the Code tab -->

Read more: media-skills, images, code

## Make a tiling texture

Ground, floor and wall tiles are drawn by code, so they always tile, take about a second and need no image backend. Ask for variants to hide the repeat.

Tab: Code
Required settings: None

Prompt:

> A 32 px oak plank floor in tiles/, with 4 variants.

Example output:

The assistant checks the tile laid 3×3 and redraws it if a spot repeats, then writes `tiles/oak.png` and `tiles/oak_1.png` to `tiles/oak_4.png`.

<!-- media: the oak tile laid 3×3 next to its variants -->

Read more: textures

## Make edge tiles where two textures meet

Ask for a transition set between two textures, for engines that match terrain by corners, such as Godot or Tiled.

Tab: Code
Required settings: None

Prompt:

> The edge tiles between tiles/grass.png and tiles/dirt.png.

Example output:

You get a sheet of 16 tiles, 4 across, covering every way grass and dirt meet at a tile's corners, and a JSON file beside it naming each tile's four corners.

<!-- media: the 16-tile grass/dirt transition sheet -->

Read more: textures
