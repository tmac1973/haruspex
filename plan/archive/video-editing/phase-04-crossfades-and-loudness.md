# Phase 04 — Crossfades and loudness normalising

**Depends on:** 01 (ffmpeg, folder rules), 02 (the project writer, `is_owned`
and user-mix handling), 03 (the render and its loudness check) · **Enables:** the full first-version cut from the
overview; 05 reuses the per-range measurement cache

## Goal

The cut can have crossfades between clips, and its audio is normalised to
YouTube's -14 LUFS. Both are written into the Kdenlive project as ordinary
Kdenlive same-track mixes and Volume effects, so you can see and change them
in Kdenlive, and Kdenlive's own render gives the same result. The post-render
check from Phase 03 then confirms the loudness.

## Files touched

- `src-tauri/src/video/kdenlive/fixtures/mix-26.08.kdenlive` — new: four clips,
  with 1 s same-track mixes between clips 1–2 and 2–3, a hard cut between 3–4,
  and a Volume effect on clip 2. Made in Kdenlive
  26.08.2 by hand and saved, as the reference for the XML Haruspex writes.
- `src-tauri/src/video/kdenlive/mix.rs` — new: writes and removes same-track
  mixes (video dissolve + audio crossfade) on the main track.
- `src-tauri/src/video/kdenlive/gain.rs` — new: writes and updates the tagged
  Volume filter on each main-track audio item.
- `src-tauri/src/video/kdenlive/doc.rs` — widen `is_owned` to filters and
  transitions carrying `<property name="kdenlive:haruspex">1</property>`.
- `src-tauri/src/video/kdenlive/edit.rs` — the cut diff places an item on the
  playlist chosen by the placement rule in step 2, and calls
  `mix.rs`/`gain.rs`.
- `src-tauri/src/video/mod.rs` — declare `loudness`.
- `src-tauri/src/video/kdenlive/mod.rs` — declare `mix`, `gain`, and add each
  item's mix and gain to `summary`.
- `src-tauri/src/video/loudness.rs` — new: measures a source range with ffmpeg
  `ebur128`; cached in `<episode>/.haruspex/loudness.json`.
- `src-tauri/src/video/kdenlive/tests.rs` — extend.
- `src-tauri/src/video/commands.rs` — `video_project_cut` gains the crossfade
  and normalise fields, plus a `video_project_normalize` command.
- `src-tauri/src/lib.rs` — register `video_project_normalize`.
- `src-tauri/src/video/check.rs` — the loudness problem wording (step 7).
- `src/lib/ipc/gen/*` — regenerated (`CutItem.crossfade_secs`,
  `CutSpec.crossfade_secs`, `CutSpec.normalize`, `LoudnessReport`).
- `src/lib/agent/tools/video.ts` — `video_cut` schema fields, and the new
  `video_normalize` tool.
- `src/lib/agent/tools/video.test.ts` — extend.
- `docs/guide/video.md` — add "Crossfades" and "Even out the audio".

## Steps

1. **Reference fixture.** In Kdenlive 26.08.2, put four clips on V1/A1, add a
   1 s mix between clips 1–2 and 2–3 and a hard cut between 3–4 (Kdenlive's
   default same-track mix: a luma dissolve on video, `mix` on audio), add a
   Volume effect at +3 dB on clip 2's audio, and save as
   `mix-26.08.kdenlive`. Copy the element shapes, property
   names and order Haruspex writes from this file; record the Kdenlive
   version that saved the fixture (26.08.2) in a comment at the top of
   `mix.rs`.
2. **Mixes (`mix.rs`).**
   - A mix of `d` frames into item N starts item N `d` frames before item
     N-1 ends, in both main-track tractors. Item N goes on the playlist the
     placement rule below gives it.
   - It adds the two transitions inside each track tractor that the fixture
     shows (video: `luma`; audio: `mix`), with `in`/`out` over the overlap
     and the `kdenlive:mixcut` and mix properties from the fixture, all
     tagged `kdenlive:haruspex=1`.
   - Placement rule: an item with a mix into it goes on the opposite playlist
     from the item before it. An item with no mix into it goes on A. So in the
     fixture, clip 1 is on A, clip 2 on B, clip 3 on A, and clip 4 on A. A
     test checks this against the fixture.
   - A mix can't be longer than half of either neighbouring item. Longer
     requests are clamped, with a note.
   - The timeline gets shorter by the overlap, and `out` lengths and group
     positions are recomputed.
3. **Crossfade fields.** `CutSpec.crossfade_secs` (default 0) applies to every
   join. `CutItem.crossfade_secs` overrides it for the join into that item.
   Intro→first clip and last clip→outro count as joins too. `0` means a hard
   cut. Mixes Haruspex didn't tag stay user mixes under Phase 02's rule.
   Tagged mixes are Haruspex's own: the cut diff removes and rewrites them
   freely.
4. **Measurement (`loudness.rs`).**
   - For a source file and range: `ffmpeg -nostats -ss <in> -to <out> -i <file>
     -map 0:a:<audio_index> -af ebur128=peak=true -f null -`, parsed for
     integrated loudness and true peak.
   - Cached by `(path, size, mtime, in, out, audio_index)` in
     `<episode>/.haruspex/loudness.json`.
   - Measure up to 4 at a time, with `ctx.onProgress` updates ("Measuring
     audio 3 of 14").
   - Silent ranges (below -70 LUFS) get no gain.
5. **Gain (`gain.rs`).**
   - For each main-track audio item: `gain_db = -14 - measured_lufs`, clamped
     to [-20, +20]. It's then lowered so `true_peak + gain_db ≤ -1.0`.
   - Write it as Kdenlive's Volume effect (`volume` filter, `level` in dB as in
     the fixture), tagged `kdenlive:haruspex=1`, as the first filter on the
     item's audio chain.
   - Re-running updates the tagged filter in place. A Volume effect the user
     added is left alone and reported: "Clip 4 has your own Volume effect;
     Haruspex's gain is applied before it."
   - The intro and outro are normalised the same way.
6. **When normalising runs.** `CutSpec.normalize` defaults to `true`, so
   `video_cut` measures the new or changed items and writes their gains. Kept
   items keep their gain. `video_normalize { episode, project? }` re-measures every item
   and rewrites every tagged gain. The model uses it when the post-render check
   reports loudness outside -15…-13 LUFS.
7. **Check wording.** In `check.rs` (Phase 03), drop the "not normalised"
   wording and report "Loudness -16.1 LUFS, outside YouTube's -14 ±1. Run
   video_normalize." when outside the range.
8. **Tools.**
   - `video_cut` schema: add `crossfade_secs` (number, 0–3) at the top level and
     per item, and `normalize` (boolean, default true).
   - `video_normalize { episode, project? }` returns the per-item gains table and the
     predicted loudness.
   - The summary from `video_project_read` shows each item's mix and gain.

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
- `./scripts/export-ipc-types.sh` leaves no diff.
- `cargo test -- --ignored kdenlive_accepts` passes with the new goldens on
  Linux, mactest and wintest.
- `npm run test` and `cargo test` also pass on mactest and wintest
  (`ssh haruspex-mac`, `ssh haruspex-win`).

## Test plan

- Rust:
  - Writing the fixture's cut with a 1 s crossfade matches the fixture's mix
    elements, ignoring ids and UUIDs.
  - Mix clamping.
  - Alternation of A/B playlists over 5 items with mixed crossfades.
  - Timeline length with overlaps.
  - A user mix blocks a move.
  - The gain formula with peak limiting.
  - A re-run updates rather than duplicates the filter.
  - A user Volume effect is untouched.
  - The loudness cache hits and misses.
  - Parsing recorded `ebur128` output.
- Integration (ignored, needs ffmpeg/melt): render a golden made from two test
  tones at -30 and -8 LUFS. The output measures -14 ±1 LUFS and true peak
  ≤ -1 dBTP.
- Manual, Linux:
  - Make ep010 with a 1 s crossfade from the intro. Open it in Kdenlive: the
    mix shows as a normal mix and the Volume effect shows on the clip.
  - Render it in Haruspex, then from Kdenlive with its MP4 preset. Both
    measure the same loudness within 0.2 LU.
- Manual, mactest and wintest: open `mix-26.08.kdenlive`'s Haruspex-written
  golden in Kdenlive's window. No warning dialog appears, and the mixes and
  Volume effects show as on Linux.
- Manual, a mixed-source folder (phone mov + OBS mkv + quiet camera clip):
  the render's follow-up reports -14 ±1 LUFS and no length mismatch.
- Manual, Linux, one request: in a fresh conversation with the series folder
  picked, "make ep010 with the intro and outro, 1 s crossfades, and render it
  for YouTube". Without further prompting, the model probes, cuts, renders and
  reports the checked MP4 in the follow-up turn.
- Integration (ignored, needs Kdenlive, melt, ffmpeg): render a golden with
  crossfades and gains twice, once with Haruspex and once with
  `QT_QPA_PLATFORM=offscreen kdenlive <golden> out.mp4 --render`. Durations
  agree within one frame, loudness within 0.2 LU, and the PSNR of frames at
  10 %, 30 %, 50 %, 70 % and 90 % is above 35 dB. Run on Linux, mactest and
  wintest.

## Commit

`feat(video): crossfades and loudness normalising in the Kdenlive project`

## Rollback

Revert the commit. Projects already written keep their mixes and Volume effects
as ordinary Kdenlive items. With `is_owned` back to Phase 02's rule, tagged
filters and mixes count as user items and are kept, so nothing is lost. The loudness
cache can be deleted.
