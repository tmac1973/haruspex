---
name: clean-up-talk
description: Tighten talking-head footage in an episode's Shotcut or Kdenlive project by cutting filler words, false starts, repeated words and retakes on the word times, after the user agrees to the list of cuts. Use when the user asks to remove ums and ahs, filler, stumbles or retakes, or to tighten up talking in a video.
metadata:
  haruspex-needs: video
---

# Cleaning up talk

This works on an episode that already has a project with the talking clips
on its main track (the `cut-video` skill makes one). It cuts small
stretches, each on word times, so no word is cut in half. Nothing is cut
until the user agrees to the list.

## 1. Read the project and the speech

Run `video_project_read`. Note each clip's number, its file, and its trim
(the part of the file it uses). Run `video_transcribe` on the episode if
it has no transcript yet.

The user can change the project in its editor, so read it again before
every change.

## 2. Find what to cut

Read each clip's transcript, inside its trim, for:

- **Filler:** "um", "uh", "er", and "you know", "I mean", "sort of" or
  "like" when they carry no meaning. Whisper often leaves "um" and "uh"
  out of the text, so a gap of more than about 0.4 s between two words in
  the middle of a sentence may be one. List those as "possible filler".
- **False starts:** a sentence begun and dropped ("So the — the thing is").
- **Repeated words:** "the the", "I I".
- **Retakes:** the same sentence said twice, or "let me say that again".
  Keep the last, complete take.

Leave anything the user asked to keep, and don't cut a joke's pause or a
word said twice on purpose.

For each find, run `video_transcribe` with `paths` (its clip) and `words`
around it, a few seconds either side. Set the cut:

- `from`: the end of the last word you keep before it, plus 0.05 s;
- `to`: the start of the first word you keep after it, minus 0.05 s.

That takes the filler and its pause out, and leaves a short breath.

## 3. Show the list, then stop

Show a numbered list: clip number, the times, the words cut (or "pause"),
and the words either side, like "…and then **um** we went…". Give the
total time saved. Ask which to cut: all, none, or by number. **Stop** until
the user answers.

Tell them to close the project in its editor first, or it saves over the
change.

## 4. Cut

For each clip, make one `video_edit` call with `op: "remove_ranges"`, its
`index`, and all its agreed cuts in `ranges`, in the clip's own time.

Start from the last clip and work back. A cut splits its clip into pieces,
which renumbers every clip after it, so working back keeps the numbers you
read right. Read the project again before any other change.

## 5. Report

Say how many cuts were made in each clip, and how much shorter the video
is. Suggest rendering it (`video_render`) and watching the cut places: a
jump in the picture at a cut is normal for talking heads. To hide it, a
cutaway or a slight zoom can go over the cut in the editor.

## What it doesn't do

It doesn't change the sound of the words left in, and it doesn't cut on
the picture. Very fast speech can leave less than 0.1 s between words;
then cut from the end of one word to the start of the next with no extra.
