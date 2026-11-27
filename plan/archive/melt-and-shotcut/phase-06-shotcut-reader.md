# Phase 06 — Read Shotcut projects

**Depends on:** 05 · **Enables:** 07 (the writer edits what this reads), 08

## Goal

`ProjectDoc::Shotcut` opens a `.mlt` that Shotcut saved and gives back
everything the tools read from a Kdenlive project: the main track's items as
`Placement`s, spans for transcripts, captions and chapters, the summary, and
whether it can be edited. Nothing is written yet, so this phase is read-only
and safe.

## Files touched

- `src-tauri/src/video/shotcut/mod.rs` (new) → `open(path)`, `summary(...)`,
  `editable(...)`.
- `src-tauri/src/video/shotcut/doc.rs` (new) → `Doc`: the `mlt::xml::Tree`,
  `fps` (from `<profile>`), `root_dir` (the `<mlt root=…>` attribute), tracks
  read from the main `<tractor>` (the one with `shotcut="1"`), the main track,
  items, transitions, and our filters.
- `src-tauri/src/video/shotcut/timeline_map.rs` (new) → `spans(doc)`.
- `src-tauri/src/video/shotcut/edit.rs` (new) → `current(doc) ->
  Vec<Placement>` (reading only; phase 07 adds `apply` to this file).
- `src-tauri/src/video/shotcut/doc.rs` → `pub const OURS: &str =
  "haruspex:ours"`, the property that marks a filter or transition as
  Haruspex's.
- `src-tauri/src/video/shotcut/fixtures/` (new) → projects saved by Shotcut
  itself, named with its version like the Kdenlive ones
  (`<name>-<shotcut version>.mlt`):
  - `empty-<v>.mlt`: a new 1080p30 project, saved untouched.
  - `cut-<v>.mlt`: three clips on V1 with trims and one crossfade.
  - `edited-<v>.mlt`: `cut` plus a Text: Simple filter, a clip moved, a V2
    track with an image, and a marker.
  - `gpu-<v>.mlt`: a project saved with Settings → Processing Mode → GPU
    (Movit).
  - `ours-<v>.mlt`: `cut-<v>.mlt` edited by hand. It adds a `volume` filter
    with `shotcut:filter="audioGain"`, `level=-3` and `haruspex:ours="1"`,
    plus an `avfilter.alimiter` with `haruspex:ours="1"`, to clip 1. It's
    then opened and re-saved in Shotcut to show Shotcut keeps the marker.
  The test media is the short clips the Kdenlive fixtures already use.
- `src-tauri/src/video/shotcut/tests.rs` (new).
- `src-tauri/src/video/format.rs` → `Format::Shotcut` (extension `mlt`) and
  `ProjectDoc::Shotcut(shotcut::doc::Doc)`. `open`, `current`, `spans`,
  `summary`, `fps` and `editable` work. For a Shotcut doc, `apply`, `save`,
  `set_profile` and `template` return `Err("Writing Shotcut projects isn't
  supported yet.")`. Nothing reaches those calls before phase 08 wires
  `.mlt` in.
- `src/lib/ipc/gen/Format.ts` → regenerated.

## Steps

1. Install the newest Shotcut release from Flathub (`org.shotcut.Shotcut`)
   on Tim's machine and save the fixtures with it. That version is the one
   supported. It goes in each fixture's name and in a `pub const
   SHOTCUT_FIXTURE_VERSION` in `shotcut/mod.rs`, the way `empty-26.08` pins
   Kdenlive. A later Shotcut that saves a different shape is new fixtures
   and a new commit, not part of this plan.
2. Main track: in the main tractor, the first `<track>` whose playlist has
   `shotcut:video="1"` and isn't `background` (V1, the bottom video track).
   In Shotcut a clip's picture and sound sit together on V1. `Placement`s
   come from V1 alone, and `Source::Piece` is a later entry whose chain is the same
   chain *or* a different chain with the same `resource` and
   `shotcut:hash`. Shotcut writes the second shape, and so does phase 07.
   Test both shapes, using a hand-made variant of `cut-<v>.mlt`.
3. Entries: a playlist `<entry producer=… in=… out=…>`, or `<blank
   length=…>`. A transition is an entry whose producer is a `<tractor>` with
   `shotcut:transition` set. It becomes `mix_in` on the following
   `Placement`, with its length in frames. The two clips' in and out points
   are read back through the transition tractor's two tracks, so the clips'
   own trims come out the way Shotcut shows them.
4. Producers: `<chain>` or `<producer>` with `mlt_service`
   `avformat`/`avformat-novalidate`. `resource` is relative to `root` or
   absolute. `shotcut:hash` gives the hash, and `shotcut:caption` the display
   name.
5. Our filters: any filter with `OURS` set to `1`: a `volume` with `shotcut:filter="audioGain"` is our gain, and
   `avfilter.alimiter` is our limiter. Filters without the marker are the
   user's: counted in the summary, never touched.
6. Summary: `editor: Format::Shotcut`, `editor_version` from the `<mlt
   title="Shotcut version X">` attribute, width, height and fps from
   `<profile>`, items, other clips (anything on tracks other than V1), mixes
   (transitions on V1), guides (entries in `shotcut:markers`), and total
   seconds.
7. `editable` refuses with a reason when the `shotcut:processingMode` value
   contains `Gpu`, or when any `mlt_service` starts with `movit.` ("This project uses Shotcut's GPU
   processing, which Haruspex can't render. Switch it to Native in Shotcut's
   Settings → Processing Mode and save."), or when V1 is locked
   (`shotcut:lock="1"`).
8. Tests: each fixture's `current()` placements (items, trims, `mix_in`),
   spans, and summary. `ours-<v>.mlt` gives `gain_db == Some(-3.0)` and
   `limiter == true` for clip 1 and `None` for the rest. Plus the GPU
   refusal.

## Build gate

- `cargo fmt -- --check`, `cargo clippy -- -D warnings`, `cargo test`.
- `./scripts/export-ipc-types.sh` with no diff afterwards.
- `npm run check`.

## Test plan

- `cargo test video::shotcut` covers every fixture.
- `spans` on `cut-<v>.mlt`: the source times at 1 s, at the middle of the
  crossfade, and 1 s before the end match what Shotcut's player shows at
  those positions (checked by hand once and written into the test).

## Commit

`feat(video): read shotcut projects`

## Rollback

Revert the commit. Nothing writes Shotcut files or finds `.mlt` projects yet,
so it's safe to revert on its own.
