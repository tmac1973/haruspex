---
title: Skills for pictures, music and video
description: The skills that ship for working with pictures, songs and video, what each one does, when they are offered, and how to run one yourself.
---

# Skills for pictures, music and video

Haruspex ships skills that chain the picture, music and video tools into whole tasks. A tool does one thing, such as edit a picture or make a song. A skill says which tool fits the request, in what order to use them, and what to check before answering. They are ordinary skills in your skills folder: see the `skills` page to edit, switch off or restore one.

## When they are offered

Each one needs something set up first:

| Skill | Needs |
|---|---|
| `fix-picture` | an image backend (Settings → Image) |

Until that is set up, the skill is greyed out in Settings → Skills, with what it needs, and isn't offered. Once it is, the model can load the skill when a request matches. That depends on Settings → Skills → When the model uses skills: by default, remote and OpenRouter models load skills and the local model doesn't. On any model you can run one yourself by typing `/` and its name, followed by what you want.

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

## What they don't do

- `fix-picture` doesn't draw a new picture; just ask for one (see the `images` page).
- The skills don't run in jobs or subtasks.
