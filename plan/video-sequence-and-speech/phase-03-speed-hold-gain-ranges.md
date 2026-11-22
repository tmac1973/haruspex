# Phase 03 — Clip speed, hold frames and gain over a range

**Depends on:** 01 (still extraction), 02 (Placement fields and frame trims) ·
**Enables:** 09 (sections fitted to music, padded ends), 14 (fit/cut
replacement, muting the replaced words)

## Goal

Add the three remaining editing primitives as `Placement` / `AudioPlacement`
fields with matching ops: a speed factor on a main-track clip or an
audio-track clip, a hold frame (a still clip of a clip's first or last frame
for a set time), and gain or mute over a time range of a clip's sound with
short fades. They serve any skill: slow motion, fitting a voiceover, bleeping
a word, ducking, and the speech replacement in phase 14.

## Files touched

- `src-tauri/src/video/timeline.rs` — `Placement.speed: f64` (default 1.0),
  `Placement.gain_ranges: Vec<GainRange { from_frame, to_frame, gain_db }>`
  (`gain_db` ≤ −60 means mute), `AudioPlacement.speed: f64`;
  `Source::Still { png: PathBuf, frames: i64 }`.
- `src-tauri/src/video/shotcut/edit.rs`, `shotcut/audio.rs` — speed as a
  `timewarp` producer (`resource = <speed>:<file>`, `warp_pitch=1` for audio
  so speech keeps its pitch); `Still` as a `qimage` producer with `length`
  and `ttl=1`; gain ranges as one `volume` filter per range with `in`/`out`
  on the filter and a keyframed `level` giving 10 ms ramps at each edge.
- `src-tauri/src/video/kdenlive/edit.rs`, `kdenlive/audio.rs` — the same
  producers and filters in Kdenlive's form, read back in `current`/`clips`.
- `src-tauri/src/video/project.rs` — ops `Speed { index, factor }`,
  `Hold { index, end: "first"|"last", at_secs?, secs }`, `GainRange { index, from_secs,
  to_secs, gain_db }`, `ClearGainRanges { index }`; `CutItemSpec.speed`,
  `CutItemSpec.hold_after_secs`, `CutItemSpec.gain_ranges: Vec<{ from_secs,
  to_secs, gain_db }>` (clip source time); `CutAudioSpec.speed`. `follow()` keeps an
  audio clip in time when a clip before it changes speed or gains a hold.
- `src-tauri/src/video/silence.rs` — `cut_ranges` maps gain ranges onto the
  pieces of a split clip.
- `scripts/build-media.sh` — only if step 1 finds `qimage` or `timewarp`
  missing from the bundled melt: add the module and bump
  `scripts/media-versions.sh` so the `Build media tools` workflow rebuilds.
- `src/lib/video/args.ts`, `src/lib/agent/tools/video.ts` — schemas for the
  new ops and fields; `video_project_read` shows speed, holds and gain ranges.
- Tests beside each file.
- `docs/guide/video-cut.md` — "Change a clip's speed", "Hold a frame",
  "Mute or lower part of a clip's sound" (move the "doesn't fade or duck"
  line to say what now works). If the page passes 6 KB, move these sections
  to a new `video-adjust.md` page and add it to `src/lib/guide/pages.test.ts`
  `PAGES`.

## Steps

1. Run `melt -query producers` and `melt -query filters` with the bundled
   melt. Confirm `timewarp`, `qimage` and `volume` are present. If one is
   missing, add it in `scripts/build-media.sh`, bump the media version, and
   run the `Build media tools` workflow before the rest of this phase.
2. Add the fields with serde defaults. `speed` is clamped to 0.25–4.
3. Speed: the writer replaces the clip's producer with a `timewarp` producer
   of the same file; `in_frame`/`out_frame` stay in source frames and the
   placed length is `(out − in + 1) / speed`. The reader maps a timewarp
   producer back to its file and speed.
4. Hold: `ProjectOp::Hold` calls phase 01's `extract_still` (first or last
   frame of the clip's current in/out) into `.haruspex/stills/`, then inserts
   a `Placement { source: Source::Still{..}, .. }` before or after the clip.
   With `at_secs` (a time in the clip's source), it splits the clip there
   (both pieces keep the clip's fields, as `RemoveRanges` pieces do), takes
   the frame at `at_secs`, and puts the still between the pieces.
   The still has no sound and its own fit copies the clip's.
5. Gain ranges: write one `volume` filter per range; the `level` keyframes are
   `0 dB` → `gain_db` over 10 ms at `from`, and back over 10 ms at `to`.
   Ranges are in the clip's source frames, so a trim does not move them.
6. `follow()`: recompute each audio placement's `at` from the clip it starts
   over, using the clip's placed length (speed and holds included).
7. Schemas, `args.ts`, export-ipc-types, guide.

## Build gate

`npm run check` · `npm run lint` · `npm run format:check` · `npm run test` ·
`cargo fmt -- --check` · `cargo clippy` · `cargo test` · export-ipc-types
leaves no diff.

## Test plan

- Rust round trips (both editors) for speed, hold and gain ranges; each file
  passes `melt_loads`.
- Render a 4 s fixture at speed 2: output length 2 s ± 1 frame.
- Hold last 1.5 s: length grows by 1.5 s; the held frame matches the
  `Last` still.
- Hold with `at_secs: 2.0` on a 4 s clip: two pieces (0–2 s, 2–4 s) with the
  still between them; both pieces keep the clip's gain and fit; round trip in
  both editors.
- Gain range −70 dB over 1.0–1.5 s: `ffmpeg volumedetect` on that stretch of
  the render reads silence; the rest keeps its level.
- A voiceover after a clip that gets speed 0.5 moves later by the clip's
  extra length.
- Hand: the three in Shotcut and Kdenlive (speed shows in clip properties,
  the still is an image clip, the volume filters show keyframes).

## Commit

`feat(video): clip speed, hold frames and gain over a range`

## Rollback

Revert the commit. Projects written with these features contain standard
MLT producers and filters, so they still open in the editors and render; the
previous Haruspex reads a timewarp or qimage producer as an unknown clip and
leaves it in place.
