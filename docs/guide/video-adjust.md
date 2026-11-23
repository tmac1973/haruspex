---
title: Adjusting clips in a cut
description: Changing a clip's speed, muting or lowering part of its sound, and holding its first, last or any frame, in a Shotcut or Kdenlive project the assistant cut.
---

# Adjusting clips in a cut

These change one clip in a project the assistant cut (see the `video-cut` page). Each one is something you can see and change in Shotcut or Kdenlive afterwards.

## Change a clip's speed

Ask "play clip 2 at half speed" or "speed clip 4 up to twice as fast". A speed goes from 0.25 (a quarter) to 4, and 1 puts a clip back to its own speed.

- It is the editor's own speed change (MLT's timewarp), so it shows in the clip's properties in Shotcut and Kdenlive and you can change it there.
- The clip's sound plays at the same speed and keeps its pitch.
- The clip's trim stays where it was in the clip: a clip showing 0:10–0:20 at half speed still shows 0:10–0:20, over 20 seconds of the video.
- Later clips move up or back, and sound on the audio tracks moves with the clip it starts over. Captions and the cut's transcript follow the new timing.
- A clip joined to the next by a crossfade you made in the editor can't change speed; remove the crossfade there first.

## Mute or lower part of a clip's sound

Ask "mute 0:12.4 to 0:13 of clip 2" or "lower clip 3 by 10 dB from 1:05 to 1:20". Times are in the clip's own time, as `video_transcribe` and the project summary give them, so trimming the clip later doesn't move the stretch.

- Each stretch is a Gain / Volume effect on the clip that covers only that stretch. Its level eases in and out over one frame at each edge, so the cut doesn't click.
- A gain goes from -70 dB (mute) to +20 dB. A new stretch that overlaps an old one replaces it.
- Ask to "clear the muted parts of clip 2" to take them all off. The clip's own gain, from evening out the sound, stays as it is.
- The project summary lists each stretch on its clip.

## Hold a frame

Ask "hold the last frame of clip 3 for 2 seconds", "hold the first frame of clip 1 for a second", or "freeze clip 2 at 0:04 for 1.5 seconds".

- The last frame goes after the clip and the first frame before it. A frame at a time splits the clip there and puts the hold between the two pieces.
- A hold is a new silent clip, made from the frame at the project's frame rate. It is saved in the episode's `.haruspex/stills/` folder, beside a PNG of the frame, and the project uses it like any other clip.
- It fills the frame the same way as its clip: letterbox, fill or crop.
- The video gets longer by the hold, and sound on the audio tracks after it moves with the clip it starts over.

## What it doesn't do

- It doesn't change speed over a clip (a ramp): the whole clip plays at one speed.
- It doesn't change the speed of sound on the audio tracks under the picture.
- It doesn't fade a stretch of sound in or out over more than a frame; for a slower fade, set the gain in the editor.
- It doesn't duck music under speech for you: set the music's level, or lower stretches of it.
- A hold has no sound. The clip's sound stops while the frame is held.
