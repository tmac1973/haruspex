---
name: narrate
description: Write and record spoken audio, such as a voiceover for a video, narration, or a game's character lines, with a script written to be heard and checked with the user before it is recorded. Use when the user wants something read aloud into an audio file, or spoken lines made.
metadata:
  haruspex-tools: generate_speech
---

# Narrating

`generate_speech` turns text into a WAV in seconds. The words matter more
than the recording, so settle the script first.

## 1. Work out what it's for

- **A voiceover for a video:** how long the video or section is, and what
  it shows.
- **Game lines:** which characters, which lines, and where the code loads
  its sounds (Code tab).
- **Narration** of a text the user gave, or one you write.

If the user gave the exact words ("read this", "say: …"), use them as they
are and go to step 3.

## 2. Write the script, then stop

Write for the ear, not the page:

- Short sentences. One idea each. Full stops make the pauses.
- Numbers, dates, units and abbreviations as they are said: "twenty
  twenty-six", "five kilometres", "for example", not "2026", "5 km", "e.g.".
- No markdown, lists, brackets, emoji or URLs. Say a list as a sentence.
- A made-up name that could be misread gets spelt as it sounds ("Xyrith"
  as "Zeerith"). Tell the user you did.
- For a set length, write about 2.5 words per second of speech.

Show the script with the voice you'll use, then **stop and ask** the user
to approve or change it. Don't record until they do, unless they said to
go ahead without checking.

## 3. Pick the voice

Use the voice the user named. Otherwise, match their description:

- `af_` voices are American women: `af_heart` (warm, the default), `af_bella`,
  `af_nicole` (soft), `af_sarah`, `af_sky`, `af_nova`, `af_alloy`, `af_river`.
- `am_` voices are American men: `am_michael` (deep), `am_adam`, `am_eric`,
  `am_liam`, `am_echo`.
- `ef_dora` and `em_alex` have a Spanish accent.

Give each character one voice and keep it for all their lines. Use `speed`
for character: about 0.9 for slow and weighty, 1.1 for quick. Stay within
0.8 to 1.25, where it still sounds natural.

## 4. Record

- **One piece:** one call, with a short `title`.
- **Over 12,000 characters:** split at chapter or paragraph breaks into
  parts, titled "Part 1", "Part 2" and so on.
- **Game lines:** one call, and one file, per line. Name each file for what
  the code calls it (`innkeeper_greet.wav`), in the folder the code loads
  sounds from, with `path`. Don't replace an existing file unless the user
  asks.
- **A voiceover for a video:** save it next to the video with `path` if
  there's a working folder. Don't change a Kdenlive project yourself: tell
  the user to add it as an audio track.

## 5. Check the length

When a length was asked for, compare the length the tool reports with it.
If it's more than 10% off, record it again with `speed` multiplied by
(length made ÷ length wanted). If that would leave 0.8 to 1.25, cut or add
to the script instead, and show the user the change.

If the tool says the audio is far shorter than the text, stop and tell the
user. Don't retry.

## After

Put each player in your answer. Say what you made: the voice, the speed,
the length, and each file's path. For game lines, end with a table of
character, line and file. Don't describe how it sounds, because you can't
hear it.
