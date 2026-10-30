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
| `write-song` | Chat and the Code tab | a music backend (Settings → Music) |
| `cut-video` | Chat and the Code tab, with a working folder | the video tools (Settings → Video editing) |
| `narrate` | Chat and the Code tab | nothing (see the `speech` page) |

Until that is set up, the skill is greyed out in Settings → Skills, with what it needs, and isn't offered. Once it is, the model can load the skill when a request matches, and a skill also loads by itself the first time the model reaches for one of its tools, such as editing a picture. That depends on Settings → Skills → When the model uses skills: by default, remote and OpenRouter models load skills and the local model doesn't. On any model you can run one yourself by typing `/` and its name, followed by what you want.

## Change a picture you already have: fix-picture

`fix-picture` works in Chat, on a picture you attached, one drawn earlier in the chat, or a file in the working folder. It picks the tool from what you ask for:

- **The whole picture** ("make it night", "remove the car", "as a watercolour"): a plain edit.
- **One part** ("only the sky", "just his shirt"): an edit marked to that part. Nothing outside it changes.
- **More room** ("make it wider", "room for a title on the right", "make it 16:9"): it extends the picture past its edges. It describes the whole scene and its light, so the new part matches.
- **Bigger or sharper** ("for printing"): it upscales, two or four times.
- **Several pictures together** ("put the cat from the second picture on the sofa"): one edit that combines them.

Several changes go in that order, upscaling last, each on the last result. A change that didn't take is tried once more, then reported.

It knows what the image backend can do, so for something it can't (extending on Lemonade, editing with Ming-Image) it says where to set it up rather than trying. See the `image-editing` page.

## Make art for a game: game-assets

`game-assets` makes a few assets for the project in the Code tab: sprites, icons, tiling textures and the edge tiles where two textures meet. Ask for something like "a goblin, a rat and a dungeon floor for this game".

- It reads the project first: the tile size the code draws, the folder it loads images from, and any art already there to match.
- It uses one style line for every asset, makes the sprites first, shows you the first, and draws the rest in its colours.
- It draws the ground to stand apart from the sprites: each texture is measured against them, and redrawn lighter or darker if they would be hard to see on it (see the `textures` page).
- It doesn't replace a file that exists unless you ask.

For more than about eight assets it suggests an Asset generation job (see the `jobs` page).

## Make a song: write-song

`write-song` writes the style and the words before making anything, since a song takes a minute or more. The style is a few tags (genre, mood, instruments, tempo, voice): it keeps to what you named, and says what it chose for the rest. Lyrics get section tags such as `[verse]` and `[chorus]`, and as many lines as fit the length. Every lyric line is sung, so "guitar solo" goes in the style. An instrumental gets none.

- **Music for a game or a video:** an instrumental loop with no intro or outro, 30 to 60 seconds. In the Code tab it's saved where the code loads its music.
- **Changing a song:** it changes the part you name rather than making the whole song again. It can redo a stretch, restyle the song, extend it, or add or pull out an instrument (see the `music` page). For "the same but faster" it remakes a song it made from the same seed; one it has already changed can't be remade that way, and it says so.
- **Afterwards:** it says what it made, with the length and the seed. It doesn't claim how the song sounds, since it can't hear it.

## Finish a video: cut-video

`cut-video` takes an episode from raw clips to a finished video, in order, and stops where you need to decide:

1. It lists the clips, saying which are mixed formats or have no sound, and transcribes them.
2. It makes the cut, then **stops** for you to look. Close the project in Kdenlive before it goes on.
3. It cuts out silences, and lists the retakes it finds in the transcript. It **asks** which to cut, and cuts only those.
4. It writes chapters for a longer video, renders in the background, and checks the render's loudness, length and sound.
5. It writes captions next to the render, and offers moments for a thumbnail.

It never uploads. See the `video-editing`, `video-speech` and `video-render` pages for each step.

## What they don't do

- `fix-picture` doesn't draw a new picture; just ask for one (see the `images` page).
- The skills don't run in jobs or subtasks.

## What has been tested

Each skill was run with Qwen3.8-Flash and loaded itself: `fix-picture` on Lemonade and ComfyUI, `game-assets` on a small pygame game, `cut-video` on three clips with a retake, `write-song` with ACE-Step 1.5 XL, and `narrate` on a voiceover and three game lines.
