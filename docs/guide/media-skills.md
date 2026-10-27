---
title: Skills for pictures, music and video
description: The skills that ship for working with pictures, songs and video, what each one does, when they are offered, and how to run one yourself.
---

# Skills for pictures, music and video

Haruspex ships skills that chain the picture, music and video tools into whole tasks. A tool does one thing, such as edit a picture or make a song. A skill says which tool fits the request, in what order to use them, and what to check before answering. They are ordinary skills in your skills folder: see the `skills` page to edit, switch off or restore one.

## When they are offered

Each works in certain tabs and needs something set up first:

| Skill | Where | Needs |
|---|---|---|
| `fix-picture` | Chat | an image backend (Settings → Image) |
| `game-assets` | the Code tab, or the Shell with Full access | nothing for textures; an image backend for sprites and icons |

Until that is set up, the skill is greyed out in Settings → Skills, with what it needs, and isn't offered. Once it is, the model can load the skill when a request matches, and a skill also loads by itself the first time the model reaches for one of its tools, such as editing a picture. That depends on Settings → Skills → When the model uses skills: by default, remote and OpenRouter models load skills and the local model doesn't. On any model you can run one yourself by typing `/` and its name, followed by what you want.

## Change a picture you already have: fix-picture

`fix-picture` works in Chat, on a picture you attached, one drawn earlier in the chat, or a file in the working folder. It picks the tool from what you ask for:

- **The whole picture** ("make it night", "remove the car", "as a watercolour"): a plain edit.
- **One part** ("only the sky", "just his shirt"): an edit marked to that part. Nothing outside it changes.
- **More room** ("make it wider", "room for a title on the right", "make it 16:9"): it extends the picture past its edges. It describes the whole scene and its light, so the new part matches.
- **Bigger or sharper** ("for printing"): it upscales, two or four times.
- **Several pictures together** ("put the cat from the second picture on the sofa"): one edit that combines them.

For several changes it works in that order, edits first and upscaling last, each on the last result. It looks at each result before going on. A change that didn't take is tried once more with a clearer prompt; if that also fails, it says so.

The skill is told what the image backend can do when it loads. If you ask for something the backend can't do, such as extending on Lemonade or editing with Ming-Image, it says what is missing and where to set it up, rather than trying. See the `image-editing` page for which backends and models do what.

To try it: `/fix-picture make it look like late evening, then make it big enough to print`.

## Make art for a game: game-assets

`game-assets` makes a few assets for the project in the Code tab: sprites, icons, tiling textures and the edge tiles where two textures meet. Ask for something like "a goblin, a rat and a dungeon floor for this game".

- It reads the project first: the tile size the code draws, the folder it loads images from, and any art already there to match.
- It writes one style line and uses it for every asset, so they look like one game.
- It makes the sprites first, shows you the first one, and draws the rest in its colours.
- It draws the ground to stand apart from the sprites: each texture is measured against them, and redrawn lighter or darker if they would be hard to see on it (see the `textures` page).
- It doesn't replace a file that exists unless you ask.

For more than about eight assets, or the art for a whole game, it suggests an Asset generation job in the Jobs tab, which plans the set and checks every asset (see the `jobs` page).

## What they don't do

- `fix-picture` doesn't draw a new picture; just ask for one (see the `images` page).
- The skills don't run in jobs or subtasks.

## What has been tested

`fix-picture` was tested by running `/fix-picture` with Qwen3.8-Flash. It made an area edit, and an edit then an upscale, upscaling last even when asked for it first. It extended a picture to 16:9 on ComfyUI with FLUX.2 klein. On Lemonade it said extending isn't possible there, and offered what is. Before a skill loaded with its first tool call, that model used the picture tools directly without loading the skill.
