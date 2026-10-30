---
name: write-song
description: Write and make a song, an instrumental or a game's music loop, or change one already made, by redoing a part, restyling it, extending it, adding an instrument, or pulling out the vocals or an instrument. Also makes a new song in the voice of an existing one. Use when the user asks for music or a song, wants a song changed, or gives a song to work from.
metadata:
  haruspex-needs: music
  haruspex-tools: generate_music edit_music
---

# Writing a song

`generate_music` makes a new song and `edit_music` changes one. A song
takes a minute or more to make, so get it right the first time: settle the
style, the length and the words before calling.

## The style: caption

The caption is comma-separated tags, not a sentence. Include:

- the genre, and a sub-genre if the user named one;
- the mood;
- two to four lead instruments;
- the tempo feel, such as slow, mid-tempo or driving;
- for a song with vocals, the voice: "male vocals", "female vocals" or
  "choir". Then give it more detail than the other tags: its register and
  texture, such as "deep gravelly baritone" or "breathy falsetto", and its
  phrasing, such as "sings behind the beat". A long genre description
  doesn't change the singer much. A description of the voice does.

For example: "lo-fi hip hop, mellow, rainy night, Rhodes piano, vinyl
crackle, soft drums, slow". Keep to whatever the user named: their genre,
their instruments, their kind of voice. Fill in only what they left open,
and say in your answer what you chose. Pass `bpm`, `key` or
`time_signature` only when the user names them.

## The words: lyrics

- **No lyrics** for an instrumental, a loop or background music. Omit them;
  don't pass empty tags.
- **Section tags** on their own lines: `[verse]`, `[chorus]`, `[bridge]`,
  and `[intro]` or `[outro]` for parts with no singing.
- **Every line under a tag is sung.** Follow a tag with words to sing, or
  with nothing. Never write a direction such as "slow guitar riff" or
  "drum solo" in the lyrics: `[intro]` followed by "slow guitar riff over a
  shuffle" gets sung. Leave the tag empty and put "guitar solo" or
  "instrumental break" in the caption.
- **Fit the length.** Allow about one short line per three or four seconds
  of singing. A 30-second song is one verse and a chorus. Two minutes is
  verse, chorus, verse, chorus, bridge, chorus.
- **Short lines** that are easy to sing, in the user's language. Pass
  `language` when it isn't English.
- **Use the user's words** if they gave lyrics, keeping their section tags or
  adding them, with no rewriting.

## Length

Use the length the user asked for, from 5 to 240 seconds. Without one, the
default from Settings → Music applies. A short song can come out a little
shorter than asked. If it does, say so.

## Music for a game or a video

- Make it instrumental with no lyrics, and add "seamless loop, steady
  tempo, no intro, no outro" to the caption.
- Make 30 to 60 seconds unless the user says otherwise.
- In the Code tab, find where the code loads its music and save there with
  `path`, ending `.mp3` (or `.wav` if asked). Don't replace an existing file
  unless the user asks.

## Changing a song already made

Use `edit_music` on the song's haruspex-audio:// URL, or on an audio file in
the working folder. A file the user dropped on the message box is an
"Attached audio:" line in their message; pass its URL as `source`. Never
make the whole song again to fix one part of it.

| The user wants | action |
| --- | --- |
| "Redo 0:30 to 0:45 with a guitar solo" | `redo` with `start_seconds`, `end_seconds` and a caption for the new part |
| "The same song as jazz" | `restyle` with the new caption. Pass the original lyrics to keep the singing. `strength` near 1 keeps its structure; about 0.2 is loose. |
| "Make it 30 seconds longer", "add an intro" | `extend` with `seconds`, and `at: "start"` for an intro |
| "Add drums" | `add_instrument` with `instrument` and a caption for what it plays |
| "Just the vocals", "extract the voice" | `extract_instrument` with `instrument: "vocals"`. This is stem separation; it works on any song, not only one made here. |
| "Fill in a band around it" | `complete` |
| "Only the first half", "just 0:10 to 0:40" | `trim` with `start_seconds` and `end_seconds`. It is cut in a moment, needs no particular model, and makes a WAV whose URL works as a `source` or `style_reference`. |

Each song's seed is reported with it. For "the same but faster", or any
small change to a whole song that `generate_music` made, make it again with
that song's `seed`, the same lyrics, and the changed caption or `bpm`. The
seed decides the singer more than the caption does: the same seed keeps the
same voice. If the user dislikes the voice, try a new seed before you
rewrite the caption. A
song that `edit_music` changed can't be remade that way: its seed doesn't
make the whole song. Say that remaking it from the original seed loses the
edit, and ask whether to remake the original and redo the edit after.

## A new song in another song's voice

When the user wants a new song sung like an existing one ("extract the
voice from this, then make a blues song"), do it in two calls:

1. `edit_music` with `action: "extract_instrument"`, `instrument:
   "vocals"` on the song. Wait for it to finish.
2. `generate_music` with the new caption and lyrics, and
   `style_reference` set to the vocals' URL from step 1.

The reference borrows the voice's timbre, not its words or melody, so
still write lyrics and describe the voice in the caption. If the vocals
have two voices, or the user wants only part of them, `trim` them to the
stretch they name first and use the trim's URL. You can't hear which
stretch has one voice, so ask when the user hasn't said. Passing the
whole song as `style_reference` skips step 1 but borrows the band's sound
too. Use that only when the user wants the overall sound.

If the tool says the model can't do a change (instrument changes need a
base model such as ACE-Step 1.5 XL base), tell the user. Don't try a
different action that only looks similar.

## After it's made

Put the player in your answer where it belongs. Say what you made: the
style, the length, whether it has vocals, and the seed. Don't describe how
it sounds beyond what you asked for, because you can't hear it.
