---
name: game-assets
description: Make a few game assets for this project (sprites, icons, tiling textures and the edge tiles between them) in one style, with ground the sprites show up on. Use when the user asks for art for the game here. A whole game's set of art is an Asset generation job instead.
metadata:
  haruspex-mode: code
  haruspex-tools: make_asset
---

# Making game assets

`make_asset` makes each file. These instructions are about making several
of them that belong to one game.

## Look first

Before making anything, read the project:

- **The engine and tile size.** Find where the code loads images and how big
  it draws a tile and a sprite. Make assets at that size. If nothing says,
  use 32 px tiles and 64 px sprites.
- **Where the art goes.** Use the folder the code already loads from, at the
  paths it expects. Make the folder first if it doesn't exist.
- **Art that's already there.** Match it: the same style, and `palette_from`
  one of the existing sprites when making a new sprite.

Never replace an existing file unless the user asked. Pass `overwrite` only
then.

If the user wants more than about eight assets, or the art for a whole
game, suggest an Asset generation job in the Jobs tab instead. It plans the
set, keeps it consistent and checks every asset. Make a few here only if
they still want that.

## One style for all of them

Write one `style` line and pass the same line to every call. It describes
the medium, the outlines and the level of detail ("16-bit pixel art, dark
outlines, flat shading"). Don't name colours in it: each subject has its
own, and the ground needs different ones from the sprites.

## Sprites and icons first

Make the sprites and icons before the ground, because the ground is chosen
against them.

- Use `kind: "sprite"` for anything that stands on the map: characters,
  items, doors, stairs, furniture, buildings. Use `kind: "icon"` for user
  interface symbols. They need an image backend (Settings → Image). If there
  is none, say so and make only the textures.
- Make the most important sprite first and show it to the user before the
  rest. Then pass it as `palette_from` for every later sprite, so the set
  shares its colours.
- Each `prompt` is the subject with its own colours: "a goblin with green
  skin and a rusty dagger".

## Ground and walls

- A floor, ground, road, water or wall top is `kind: "texture"`, drawn by
  code from a `recipe`. It needs no image backend.
- Pass the sprites that will stand on it as `sprites`. The result says
  whether they would be hard to see. If it says so, follow its numbers
  (lighter or darker, and the grey to aim for), redraw with `overwrite:
  true`, and check again.
- Never pass a sprite as `palette_from` for a texture. Ground drawn in the
  sprites' colours is ground they vanish into. To match another texture,
  pass that texture.
- Keep the ground less saturated and less busy than the sprites. They are
  what the player looks at.
- Make floors and walls easy to tell apart at a glance: give them different
  patterns (a floor of flagstones or planks, not the bricks of the wall), and
  make the walls darker or lighter than the floor.
- Where two textures meet on the map, make a `kind: "transition"` set from
  their two recipes. For a side-view platformer, use the `side` view with
  the ground and a `cap` such as grass.
- Ask for `variants` (2 to 4) for large areas of one ground, so the repeat
  is harder to see.

## Check each one

Look at each result before the next call. A sprite should be the subject
alone on a transparent background. A texture's 3×3 preview should show no
line or spot repeating in the same place in every copy. If a sprite came
out wrong, make it again with a clearer prompt, once. If that fails too,
tell the user rather than trying again.

Finish by listing the files written, each with its path and what it shows.
Say how the code should load anything it doesn't load yet.
