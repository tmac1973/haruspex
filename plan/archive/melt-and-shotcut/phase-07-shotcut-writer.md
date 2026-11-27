# Phase 07 — Write Shotcut projects

**Depends on:** 05, 06 · **Enables:** 08

## Goal

`ProjectDoc::Shotcut` can make a new project and apply a wanted main track to
an existing one. That covers new clips, trims, order, pieces, crossfades, and
gain plus limiter, while everything else in the file (the user's filters,
other tracks, markers, bins, notes) is left byte for byte. Every save is
checked by loading it in melt first, the way `kdenlive::save` does.

## Files touched

- `src-tauri/src/video/shotcut/template.rs` (new) → `template_text(preset,
  root)`: a minimal Shotcut project for each Settings → Video preset, built
  from `fixtures/empty-<v>.mlt` with its `<profile>` replaced through the
  same preset table `kdenlive::profile` uses (moved to `video/mlt/profile.rs`
  so both formats share it).
- `src-tauri/src/video/shotcut/edit.rs` → add `apply(doc, wanted) ->
  Result<Edited, String>` beside phase 06's `current`.
- `src-tauri/src/video/shotcut/mod.rs` → `save(project, text, melt)`, which
  shares `melt_loads` with Kdenlive (moved to `video/mlt/mod.rs`).
- `src-tauri/src/video/mlt/profile.rs` (new) ← `Profile` and `profile(preset)`
  from `kdenlive/mod.rs`. Kdenlive imports it from there.
- `src-tauri/src/video/format.rs` → the Shotcut arms of `template`,
  `set_profile`, `apply` and `save` call the new code instead of returning
  `Err`.
- `src-tauri/src/video/shotcut/tests.rs` → writer tests.

## Steps

1. Rewrite V1's `<playlist>` with `mlt::xml::Splices`, the way
   `kdenlive/edit.rs` does: only the V1 playlist, the producers/chains it
   adds, and the transition tractors on V1 change. Nothing else is touched.
2. New media becomes a `<chain>` with `mlt_service=avformat-novalidate`,
   `resource`, `shotcut:hash`, `shotcut:caption` (the file name), and
   `video_index`/`audio_index`. Ids are `chain<N>` above the highest
   existing number.
3. Every timeline entry gets a chain of its own, as Shotcut does, since a
   clip's filters live on its chain. A `Piece` copies the original's chain
   and all its filters under new ids (`chain<N>`, with filter ids made unique
   the same way). The reader from phase 06 accepts entries whether they
   share a chain or not, so files Shotcut saves either way stay editable.
4. Crossfade of N frames between clips A and B, in Shotcut's own shape: A's
   entry is shortened by N, B's in point moves forward by N, and an entry
   between them points at a new `<tractor id="transition<N>"
   shotcut:transition="lumaMix">`. That tractor has two tracks (A's tail and
   B's head, both N frames), a `luma` transition and a `mix` transition with
   `start=-1 accepts_blanks=1`, and `OURS="1"` on the tractor. A
   transition the user made (without the marker) is kept when its two
   neighbours stay adjacent, and dropped with a note when they don't. That's
   the same rule the Kdenlive writer applies to user mixes.
5. Gain: a `volume` filter on the entry's chain with
   `shotcut:filter="audioGain"`, `level=<dB>`, and `OURS="1"`, so it
   shows in Shotcut as Gain / Volume. Limiter: `avfilter.alimiter` with the
   same `limit`, `attack` and `release` values the Kdenlive writer uses, plus
   `OURS="1"`. `gain_db == Some(0.0)` removes both of ours.
6. Clamp trims to the media length and return notes exactly as
   `kdenlive::edit::apply` does, with the same strings, so `report.ts` needs
   no Shotcut-only wording for them.
7. `save` writes to `<name>.mlt.tmp`, runs `melt_loads`, then renames it over
   the file, as `kdenlive::save` does.
8. Tests:
   - Round trip: for each fixture, `apply(doc, current(doc))` returns the
     input unchanged.
   - Cut from empty: three clips with trims and two crossfades. Re-reading
     gives the same `Placement`s.
   - On `edited-<v>.mlt`, remove clip 2: the text filter, the V2 track and
     the marker are still there, byte for byte.
   - Gain then remove gain: back to the original text.
   - `melt_loads` accepts every written file (needs melt; skipped with a
     message when none is found, like the existing Kdenlive tests).

## Build gate

- `cargo fmt -- --check`, `cargo clippy -- -D warnings`, `cargo test`.

## Test plan

- `cargo test video::shotcut` passes with whichever melt `binaries.rs`
  finds (Kdenlive's on Tim's machine until phase 03 lands).
- Open each test-written project in Shotcut (by hand, once): no "repaired" or
  "converted" prompt, the crossfades show as transitions, and Gain / Volume
  shows on the clips with the dB the test set.

## Commit

`feat(video): write shotcut projects`

## Rollback

Revert the commit. `.mlt` projects still aren't reachable from the tools
until phase 08, so it's safe to revert on its own.
