---
name: cut-video
description: Turn an episode's raw footage into a finished video, from clips to a cut, silences and retakes out, chapters, a render, captions and a thumbnail, stopping for the user at each decision. Use when the user wants a video made, cut or finished from clips in the working folder.
metadata:
  haruspex-needs: video
  haruspex-tools: video_cut video_render
---

# Cutting a video

The video tools each do one step. These instructions put them in order and
say where to stop and ask. The user can open the Kdenlive project and change
it at any point, so read it again (`video_project_read`) before every change
after the first.

## 1. Look at the clips

Run `video_probe` on the episode. Tell the user what's there:

- how many clips, how long each is, and the total;
- clips that differ in size, frame rate or codec (they still cut together,
  but say so);
- clips with no sound.

If the episode, the clips or their order are unclear, ask. Don't guess which
take is the real one.

## 2. Transcribe

Run `video_transcribe` for any episode with speech. It's needed for
retakes, chapters and captions, and it's kept, so asking again later costs
nothing.

## 3. Make the cut

Run `video_cut` with the clips in order, with the intro and outro only if
the user asks for them. Add `crossfade_secs` only if the user asks for
crossfades, and never on the first clip. Loudness is evened out on its own.

Then **stop**. Show the cut (`video_project_read`): the clips, their trims
and the total length. Ask the user to look before going on. Tell them to
close the project in Kdenlive before you make the next change, or Kdenlive
will save over it.

## 4. Take out silences and retakes

- **Silences:** `video_edit` with `op: "remove_silences"`. The default cuts
  quiet longer than 1.5 s and keeps 0.25 s each side. Use the user's numbers
  if they gave some.
- **Retakes:** read the transcript for a line said twice, a false start, or
  "let me say that again". List each one you find, with its clip and times
  and the words, then **stop and ask** which to cut. Cut only the ones the
  user picks, with `op: "remove_ranges"`. Keep the last, complete take.

Read the project again after each change. Clip numbers move when a clip is
split or removed.

## 5. Chapters

For a video longer than a few minutes, or when asked, run
`video_project_read` with `transcript: true`. Pick where each topic starts,
in the video's time. Then call `video_chapters`. YouTube needs the first
chapter at 0:00, at least three chapters, and each 10 s or longer.

## 6. Render

Run `video_render`. It runs in the background, and a message comes when it
finishes. When it does, read the render's check:

- If the loudness is off, run `video_normalize` and render again, unless
  the note says every gain is already at its limit.
- If the length differs from the project's, or there is no sound, tell the
  user. Don't render again on a guess.

## 7. Captions and a thumbnail

- Run `video_captions` after the render, so the file lands next to it.
- For a thumbnail, look at the cut with `video_frames` and offer two or
  three moments, or a drawn one if the user wants it. Make it with
  `video_thumbnail`. Haruspex adds no text to it.

## Throughout

- Say what each step did in a line, with the file it wrote.
- Never upload anything.
- If a tool refuses (Kdenlive's own crossfade joins two clips, or a project
  saved by an older Kdenlive), pass its words on to the user, with what they
  can do in Kdenlive.
