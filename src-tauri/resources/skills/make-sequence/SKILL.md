---
name: make-sequence
description: Turn an idea for a long generated video into a Video sequence job, asking the few questions its brief needs (length, look, sections, joins, music, narration, speakers) and opening the job in the Jobs tab for the user to run. Use when the user wants a generated video longer than one clip, a short film, an animated sequence, or a video made from a brief.
metadata:
  haruspex-needs: video
---

# Making a video sequence

One `generate_video` clip is a few seconds. A longer video is a Video
sequence job: it writes a spec, makes stills, chains clips, adds music and
narration, and cuts it all into a Shotcut or Kdenlive project. It runs for
hours, so it's a job, not a chat. Your part is the brief.

For a single clip of a few seconds, use `generate_video` instead, and don't
use this skill.

## 1. Ask what the brief needs

Ask one question at a time, and only what the user hasn't said. Offer a
choice where you can. Stop asking when you have:

- **Length:** the whole video, in seconds or minutes.
- **What happens:** the sections in order, each one or two sentences of
  what is seen. A subject that appears in several sections is described
  the same way each time.
- **The look:** one style line for the whole video (live action, 3D
  animation, watercolour, …), and the light and colour.
- **Joins:** a cut, a crossfade, or a generated transition between
  sections. Default: crossfades.
- **Existing clips or pictures:** any in the working folder to use as a
  section or a start picture, by file name.
- **Music:** a style and mood, or none. It needs Settings → Music.
- **Narration:** the words, or none. Write them for the ear: about 2.5
  words a second of video.
- **Someone speaking:** a person on screen saying lines, with a picture
  of them in the folder or one to draw, and a saved voice for them (see the
  `save-my-voice` skill). It needs a speaking model, picked in the job.

Don't ask about models, sizes or frame rates: the job takes them from the
video model the user picks.

## 2. Check the size of it

Say roughly how long it will run: about 12 clips a minute of video, and
several minutes a clip, so a two-minute video is often two to four hours.
A section with someone speaking is slower: a clip of about 5 s of speech
takes several minutes. If the user wanted it sooner, offer a shorter
video.

## 3. Open the job

Call `propose_job` with:

- `job_type`: `video_sequence`;
- `name`: a short title;
- `brief`: everything settled above, in plain sentences, section by
  section, with lengths, joins, music, narration and speakers, so the job
  doesn't ask again;
- `settings`: `episode_dir` when the video goes in a folder of its own
  inside the working folder (the run makes it if it doesn't exist), and `run_mode: "unattended"` only if the user
  doesn't want to check the spec and the stills first.

Leave `spec` out: the job writes it from the brief and checks it.

If the tool says what's wrong, fix it and call it again. If it says video
sequence jobs aren't available, tell the user to set up Settings → Video
generation and turn on Settings → Video editing → Let the assistant edit
videos.

## 4. Hand over

Tell the user the job is open in the Jobs tab, not saved and not running.
Say what to check there before pressing Run: the video model, the
speaking model if there are speakers, and the run mode. An attended run
stops to show the spec, the stills and each section's first clip.
