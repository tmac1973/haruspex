---
title: Tiling textures
description: Ground, floor and wall tiles drawn by code — what they can be made of, variants, the 3×3 check, and transition sets where two textures meet, top-down or side-view.
---

# Tiling textures

A tiling texture is a square tile a game repeats across a map: grass, a dirt path, a wooden floor, a brick wall. Haruspex draws these by code, not with the image model, so they always tile, take about a second, and need nothing set up in Settings → Image.

## Make a texture

In the Code tab, or the Shell assistant with Full access, ask for something like "a 32 px oak plank floor in tiles/". The assistant writes a recipe: a base colour with noise, then layers over it. Code draws the recipe into a PNG at the size you ask for, 8 to 256 pixels in steps of 4.

It can draw noise, cracks, stains, moss, bricks, wooden planks, cobbles, hex and herringbone paving, floor tiles, raised plates, grass, water ripples and painted lines. Bricks, stones, planks and patches can look raised, lit from the top left, and cracks can look cut in.

It draws flat surfaces only: no objects, signs or doors. Ask for those as sprites, which need an image backend; see the `images` page.

## Check it repeats well

The assistant is shown the tile laid 3×3, as a map lays it. A line or a spot at the same place in every copy shows up there, and the assistant redraws without it. Road markings and kerbs belong on their own tiles: in a fill tile they would repeat every tile.

## Get variants

Ask for variants, such as "with 4 variants", to get the same material with its details moved: `grass.png`, `grass_1.png` and so on. A map can pick one per cell so the repeat is harder to see.

## Make edge tiles where two textures meet

Ask for a transition set, such as "the edge tiles between tiles/grass.png and tiles/dirt.png". You get two files:

- a sheet of 16 tiles, 4 across, covering every way the two materials can meet at a tile's corners;
- a JSON file beside it naming each tile's four corners.

Engines that match terrain by corners can use them: Godot's "Match Corners" terrain mode, or a corner Wang set in Tiled. The plain tiles in the set match the two textures exactly, so they mix with them on a map.

For a side-view platformer, ask for platform ground, such as "dirt platforms with grass on top". The set is the ground against transparent air, with the grass only on faces that point up.

It doesn't make 47-tile ("blob") sets or isometric tiles. Each set has one sheet, without variants.

## In an asset generation job

The **Asset generation** job draws its textures the same way when **Draw textures in code** is on. Its reviewer looks at each tile laid 3×3, and a texture it rejects is redrawn up to twice.

Where two of the job's ground textures meet on the map, it also draws a transition set, or a platform set for a side-view game. The reviewer looks at each set laid out as a small map; one it rejects gets one new edge, then is kept and marked. In **Review assets** a set shows as its sheet, and **Make again** with a note draws it again. See the `jobs` page.
