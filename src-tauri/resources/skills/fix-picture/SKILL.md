---
name: fix-picture
description: Load this before calling edit_image or upscale_image. It covers changing a picture the user already has (attached, drawn earlier, or a file), whether the whole picture, one part, more room past its edges, or a bigger copy. It picks the right tool and order, and checks each result.
metadata:
  haruspex-needs: image
  haruspex-tools: edit_image upscale_image
---

# Fixing a picture

Four tools change a picture, and the request decides which. Read "Set up
now" at the end of these instructions first: it says what the image backend
can do. If the user asks for something it can't do, say so in one sentence,
with the Settings path it gives, and offer what it can do instead. Never
call a tool the backend can't run.

## Choose the tool

- **The whole picture changes**: a new mood, time of day, season or style,
  or something added or removed ("make it night", "remove the car",
  "watercolour"). Use `edit_image` with only `image` and `prompt`.
- **Only one part changes**: the user names a part ("only the sky", "the
  left half", "his shirt"). Use `edit_image` with `area`, the smallest
  rectangle that holds that part, as fractions from the top left, with a
  little margin. Nothing outside it changes. Don't use `area` for a change
  that has to spread, such as lighting.
- **More room past the edges**: "wider", "taller", "room for a title on
  the right", "make it 16:9". Use `edit_image` with `extend`. Grow only the
  sides that need it, by the fraction that reaches the shape asked for: a
  square made 16:9 needs left and right of about 0.39 each. Look at the
  picture first. The prompt describes the whole picture as it looks,
  including the light and colours, because the new part is drawn from
  those words ("a country road through green fields in golden evening
  haze"). Don't phrase it as a change ("add more road").
- **Bigger or sharper**: "bigger", "for printing", "higher resolution",
  "sharper". Use `upscale_image`. Never redraw the picture at a larger size
  to get this. Use scale 2 unless the user asks for more or the picture is
  under 1024 pixels.
- **Combining pictures**: "put the cat from the second picture on the
  sofa". Use `edit_image` with `also`, saying in the prompt which picture
  is which. "Set up now" says how many pictures the backend takes at once.

Name the picture by where it came from. Use `attached` only for a picture
the user attached to their message. A picture drawn or edited earlier in the
chat is named by its haruspex-img:// URL, and a file in the working folder
by its path.

A new picture from scratch is not this skill. Use `generate_image` for that.

## Several changes

Make them one at a time, each on the last result, in this order:

1. Whole-picture changes.
2. Changes to one part.
3. Extending past the edges.
4. Upscaling, always last.

An edit comes back at about one megapixel, so upscaling first is wasted:
the next edit shrinks the picture again. Use the haruspex-img:// URL of the
last result as the next tool's `image`.

## Write the prompt

- Say what changes, and what must stay the same when it matters ("keep his
  face and the background").
- Use one or two plain sentences, with no lists of keywords.
- Name colours and materials ("dark green velvet") rather than words like
  "nicer" or "better".

## Check each result

Look at each picture before you answer or make the next change.

- If it didn't change what was asked, or the tool says nothing changed,
  rewrite the prompt once to be more concrete and try again. If the second
  try also fails, stop and say what happened.
- If something that should have stayed changed, run it again with `area`
  if the change belongs in one part, or with a prompt that names what must
  stay.
- If the tool says a transparent background was lost, tell the user. An
  edit doesn't make a transparent background.

In your answer, describe what the picture now shows, not what you asked
for. Save to a file only when the user asks, using `path`. If the file
exists, they are asked before it is replaced.
