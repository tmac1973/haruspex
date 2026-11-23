---
title: Skills for pictures, music and video
description: The skills that ship for working with pictures, songs and video, what each one does, when they are offered, and how to run one yourself.
---

# Skills for pictures, music and video

Haruspex ships skills that chain the picture, music and video tools into whole tasks. A tool does one thing, such as edit a picture; a skill says which tools fit the request, in what order, and what to check. They are ordinary skills in your skills folder: see the `skills` page to edit, switch off or restore one.

## When they are offered

Each works in certain tabs and needs something set up:

| Skill | Where | Needs |
|---|---|---|
| `fix-picture` | Chat | an image backend (Settings → Image) |
| `game-assets` | the Code tab, or the Shell with Full access | nothing for textures; an image backend for sprites and icons |
| `write-song` | Chat and the Code tab | a music backend (Settings → Music) |
| `cut-video` | Chat and the Code tab, with a working folder | the video tools (Settings → Video editing) |
| `narrate` | Chat and the Code tab | nothing (see the `speech` page) |
| `fix-speech` | Chat and the Code tab, with a working folder | the video tools, and a saved voice on a llama.cpp speech server |

Until then, the skill is greyed out in Settings → Skills, with what it needs, and isn't offered. Then the model can load the skill when a request matches, and the skill also loads by itself the first time the model uses one of its tools, such as editing a picture. That depends on Settings → Skills → When the model uses skills: by default, remote and OpenRouter models load skills and the local model doesn't. On any model you can run one yourself by typing `/` and its name, followed by what you want.

## Change a picture you already have: fix-picture

`fix-picture` works in Chat, on a picture you attached, one drawn earlier in the chat, or a file in the working folder. It picks the tool from what you ask for:

- **The whole picture** ("make it night", "as a watercolour"): a plain edit.
- **One part** ("only the sky"): an edit marked to that part; nothing outside it changes.
- **More room** ("make it 16:9"): it extends the picture past its edges, describing the whole scene so the new part matches.
- **Bigger or sharper** ("for printing"): it upscales, two or four times.
- **Several pictures together** ("put the cat from the second picture on the sofa"): one edit that combines them.

Several changes go in that order, upscaling last, each on the last result. A change that didn't take is tried once more, then reported.

For something the image model can't do (extending on Lemonade, editing with Ming-Image) it says where to set it up rather than trying. See the `image-editing` page.

## Make art for a game: game-assets

`game-assets` makes a few assets for the project in the Code tab: sprites, icons, tiling textures and the edge tiles where two textures meet. Ask for something like "a goblin, a rat and a dungeon floor for this game".

- It reads the project first: the tile size, the folder it loads images from, and any art to match.
- It uses one style line for every asset, shows you the first sprite, and draws the rest in its colours.
- It draws the ground to stand apart from the sprites, redrawing a texture lighter or darker when they would be hard to see on it (see the `textures` page).
- It doesn't replace a file that exists unless you ask.

For more than about eight it suggests an Asset generation job (see the `job-types` page).

## Make a song: write-song

`write-song` writes the style and the words before making anything, since a song takes a minute or more. The style is a few tags (genre, mood, instruments, tempo, voice): it keeps to what you named and says what it chose. Lyrics get section tags such as `[verse]`, and as many lines as fit the length; every line is sung, so "guitar solo" goes in the style.

- **Music for a game or a video:** an instrumental loop with no intro or outro, 30 to 60 seconds. In the Code tab it's saved where the code loads its music.
- **Changing a song:** it changes the part you name: redo a stretch, restyle, extend, or add or pull out an instrument, also on a file you drop on the message box (see the `music` page). For "the same but faster" it remakes a song it made from the same seed; not one it has already changed.
- **Afterwards:** it says what it made, with the length and seed. It can't hear the song, so it doesn't say how it sounds.

## Finish a video: cut-video

`cut-video` takes an episode from raw clips to a finished video, in order, and stops where you need to decide:

1. It lists the clips, saying which are mixed formats or have no sound, and transcribes them.
2. It makes the cut, then **stops** for you to look. Close the project in Shotcut or Kdenlive before it goes on.
3. It cuts out silences, and lists the retakes it finds in the transcript. It **asks** which to cut, and cuts only those.
4. It writes chapters for a longer video, renders in the background, and checks the render's loudness, length and sound.
5. It writes captions next to the render, and offers moments for a thumbnail.

It never uploads. See the `video-editing`, `video-speech` and `video-render` pages for each step.

## Fix what was said: fix-speech

`fix-speech` applies the edits you mark in the transcript viewer: it cuts the struck words, and speaks each retyped phrase in your saved voice, keeping the take that says the words. **Send to chat** in the viewer starts it. See the `speech-replacement` page.

## What they don't do

- `fix-picture` doesn't draw a new picture; just ask for one (see the `images` page).
- Skills don't run in jobs or subtasks.

## What has been tested

Each was run with Qwen3.8-Flash and loaded itself: `fix-picture` on Lemonade and ComfyUI, `game-assets` on a small pygame game, `cut-video` on three clips with a retake, `write-song` with ACE-Step 1.5 XL, and `narrate` on a voiceover and three game lines.
