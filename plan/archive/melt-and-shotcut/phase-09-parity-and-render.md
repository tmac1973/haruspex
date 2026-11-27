# Phase 09 — Full parity checks and bundled rendering on every target

**Depends on:** 02, 03, 08 · **Enables:** the success criteria in the
overview

## Goal

Show that every video tool works the same on a Shotcut project as on a
Kdenlive one, and that the bundled melt renders projects saved by either
editor, `qtblend` included, on all five targets with no editor installed.
Fix whatever this turns up. This phase is mostly tests: by now every feature
should already be built.

## Files touched

- `src-tauri/src/runtimes.rs`, `src-tauri/src/media_env.rs` → the
  test-only `HARUSPEX_BINARIES_DIR` override described below.
- `src-tauri/src/video/tasks.rs` → the real render test runs for a Kdenlive
  and a Shotcut project, each with a V2 track composited by `qtblend`. It
  checks the output with `video::check`: duration, an audio stream, and
  loudness within ±1 LU of -14 when `normalize` is on.
- `src-tauri/src/video/project.rs` tests → every `ProjectOp` (`Remove`,
  `Move`, `RemoveRanges`, `Normalize`, trim, gain) on the Shotcut fixtures,
  checked against the Kdenlive results for the same media: same spans and
  same notes.
- `src-tauri/src/video/transcribe.rs`, `subtitles.rs`, `silence.rs` tests →
  the timeline transcript, SRT captions, chapters and `remove_silences` on
  `cut-<v>.mlt`, with the same timings as on `mix-26.08.kdenlive` built from
  the same clips.
- `src-tauri/src/video/commands.rs` tests → the frame/thumbnail-at-cut-time
  paths (`source_at` callers at lines ~493 and ~638) on a Shotcut project.
- `src-tauri/src/video/kdenlive/fixtures/qtblend-two-track-26.08.kdenlive`
  and `src-tauri/src/video/shotcut/fixtures/qtblend-two-track-<v>.mlt`
  (new) → saved by each editor: V1 clip, V2 image at half opacity.
- `src-tauri/src/video/shotcut/edit.rs`, `shotcut/timeline_map.rs` → fixes
  for any parity test that fails. The Kdenlive side is the reference and is
  not changed in this phase.
- `.github/workflows/release.yml` (the release-build workflow) → after
  packaging, a step on each native runner unpacks the built app and runs
  `cargo test video::tasks` against the packaged `binaries/`, pointed there by
  a new `HARUSPEX_BINARIES_DIR` env var that `runtimes::resolve_binary` and
  `media_env::media_dir` read first, in tests only (`#[cfg(test)]`).
- `.claude/skills/release-test/SKILL.md` → a
  video step: render the two-track fixtures on mactest and wintest with no
  editor installed.

## Steps

1. Save the two `qtblend` fixtures in Kdenlive 26.08 and in Shotcut.
2. Write the parity tests op by op. A difference in notes or timings is a
   Shotcut bug, fixed in the two files above until they match.
3. Add the packaged-binaries render step to the release workflow.
4. Do the clean-VM pass for each target, as in the overview's success
   criteria: Fedora with no `mlt`, `ffmpeg` or `kdenlive` packages, the
   aarch64 Linux runner, mactest, an x86_64 macOS runner, and wintest. On
   each: Settings → Video editing shows three bundled tools, and both
   `qtblend` fixtures render with V2 visible.
5. Record installer sizes before and after for each target in the commit
   message. The 45 MB limit is already enforced by phase 01's CI gate, so
   this is a record, not a gate.
6. Hand tests the agent can't drive go in one GitHub issue with a checklist
   (opening written projects in Shotcut and Kdenlive on macOS and Windows),
   per CLAUDE.md's Outstanding work rule.

## Build gate

- `cargo fmt -- --check`, `cargo clippy -- -D warnings`, `cargo test`.
- `npm run check`, `npm run lint`, `npm run test`.
- A `workflow_dispatch` run of `release.yml` passes on all five targets with the new
  render step.

## Test plan

- Every Kdenlive video test has a Shotcut twin, and both pass.
- Clean-VM renders from step 4, with a screenshot of a frame from each
  showing V2 composited over V1.
- `ffprobe` on each render: the expected duration and an AAC stream.
  Loudness checked with `video::loudness`.
- Live pass via the `release-test` skill: in Chat on the real model, "cut
  ep01 from these clips with crossfades and render it", then open the result
  in Shotcut on each of the three desktop OSes.

## Commit

`test(video): shotcut parity and bundled qtblend renders on every target`

## Rollback

Revert the commit. That removes tests, fixtures, the CI step, the
test-only env var, and the Shotcut fixes. The fixes only touch Shotcut code,
so Kdenlive users are unaffected either way.
