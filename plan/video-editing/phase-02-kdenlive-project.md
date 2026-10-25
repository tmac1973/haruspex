# Phase 02 — Kdenlive project read/write and the cut tools

**Depends on:** 01 (binary resolver, folder rules, `video` category, `ClipInfo`
probe) · **Enables:** 03 (rendering a project), 04 (crossfades and gain filters
in the project), 05 (cuts from transcripts)

## Goal

Haruspex reads and writes stock Kdenlive 26.08 projects. The model can create a
project for an episode, lay out the main track (intro, clips with in/out
points, outro) with one declarative call, tweak it with small ops, and read
back a summary. That includes a project the user has since edited and saved in
Kdenlive. Everything Haruspex doesn't own is kept byte-for-byte. At the end of
this phase you can open the result in Kdenlive and render it there; Haruspex's
own render comes in Phase 03.

## Files touched

- `src-tauri/src/video/mod.rs` — declare `kdenlive`.
- `src-tauri/src/video/kdenlive/mod.rs` — new: public API (`open`, `summary`,
  `apply_cut`, `apply_op`, `save`).
- `src-tauri/src/video/kdenlive/spans.rs` — new: quick-xml event pass that
  indexes every element's byte span, attributes and `<property>` children
  without building a mutable DOM.
- `src-tauri/src/video/kdenlive/doc.rs` — new: the semantic view over spans:
  profile, bin clips (`main_bin` entries + chains), the main sequence tractor,
  its track tractors and their A/B playlists, groups JSON, and id counters.
- `src-tauri/src/video/kdenlive/edit.rs` — new: splice-based edits. Each edit
  replaces whole element spans or inserts new text at span boundaries, and
  serialises new elements in Kdenlive's own indentation and property order.
- `src-tauri/src/video/kdenlive/template.rs` — new: creates a project from the
  shipped template for a given preset and root folder.
- `src-tauri/resources/video/empty-26.08.kdenlive` — new: an empty project
  saved by Kdenlive 26.08.2 (1080p 60 fps profile, two video and two audio
  tracks, the Kdenlive default). Bundled with `include_str!`.
- `src-tauri/src/video/kdenlive/fixtures/` — new test fixtures:
  - `intro-plus-obs.kdenlive`: a copy of the user's `spronglehump_010`
    project, with resources renamed to `intro001/intro.mp4` and
    `ep010/raw/obs.mp4`.
  - `user-edited.kdenlive`: a project saved by Kdenlive after Haruspex wrote it,
    with a user-added effect, a guide, a clip on V2, and a 1 s same-track mix
    between main-track items 2 and 3 made by the user.
- `src-tauri/src/video/kdenlive/tests.rs` — new.
- `src-tauri/src/video/commands.rs` — add `video_project_summary`,
  `video_project_cut`, `video_project_op`.
- `src-tauri/src/lib.rs` — register the three commands.
- `src-tauri/Cargo.toml` — add `uuid` (v4).
- `src/lib/ipc/gen/*` — regenerated (`ProjectSummary`, `CutSpec`, `CutItem`,
  `ProjectOp`).
- `src/lib/agent/tools/video.ts` — add `video_project_read`, `video_cut`,
  `video_edit`.
- `src/lib/agent/tools/video.test.ts` — extend.
- `docs/guide/video.md` — add "Make a cut" and "Edit it in Kdenlive too".

## Steps

1. **Version gate.** `open(path)` reads `kdenliveversion` and
   `kdenlive:docproperties.version` from `main_bin`. It supports document
   version `1.1`, which Kdenlive 25.04 through 26.08 write. Any other version
   is refused with: "This project was saved by a Kdenlive version Haruspex
   can't edit yet (document version X). Opening it is fine; editing is not."
   The summary still works read-only.
2. **Span index (`spans.rs`).** Single pass with `quick_xml::Reader` over the
   original string, recording `(start, end)` byte offsets for every element
   along with its attributes and `<property name>` → (value, span). Don't
   re-serialise anything that isn't edited.
3. **Semantic view (`doc.rs`).**
   - The main sequence is the tractor whose id equals
     `kdenlive:docproperties.uuid`. Its `<track>` list is the black track, then
     one track tractor per Kdenlive track. `hide="video"` means an audio track.
   - Each track tractor holds two playlists, A and B. Clips joined by a
     same-track mix sit on alternate playlists, and the mix itself is a
     transition inside the track tractor.
   - The **main track** is the lowest video track plus the audio track linked
     to its first clip by an `AVSplit` group. When the track is empty, it's
     the audio track next to it in Kdenlive's order.
   - Timeline items are `<entry>`s on the main track's playlists; each points
     to a per-track `chain` whose `kdenlive:control_uuid` names its bin clip.
   - Parse `kdenlive:sequenceproperties.groups` with serde_json. Leaf `data` is
     `"<track index>:<position frames>:-1"`.
   - Times are `HH:MM:SS.mmm` against the profile frame rate. Convert to
     integer frames with the profile's `frame_rate_num/den` and back. Write the
     same `HH:MM:SS.mmm` form Kdenlive writes.
4. **Ownership rule.** Haruspex edits only the main track's two playlists, the
   chains those entries reference, `main_bin` entries and chains for clips it
   adds, the `AVSplit` groups for items it places, and the sequence/black-track
   `out` lengths. Same-track mixes on the main track, found by the
   transitions inside the main track tractors (whichever playlists their
   items are on), belong to the user in this phase: they are
   kept byte-for-byte, the two items they join stay adjacent and in order,
   and a cut, `remove` or `move` that would separate them is refused with
   "Clips 2 and 3 are joined by a crossfade you made in Kdenlive; remove it
   there first, or keep them together." Every other track,
   effect, guide, group, transition and property is left byte-identical. A
   main-track item keeps its user-added filters when `video_cut` keeps the
   item. Items are identified by index: a `video_cut` item that names an
   existing `index` is that item (its filters stay even when its in/out
   points change), and an item given by `path` is new. Pieces made by
   splitting an item copy that item's filters.
   Write the ownership check as one function, `is_owned(element)`, so a later
   phase can widen it in one place.
5. **Template (`template.rs`).** `create(project_path, preset, root)` loads
   `empty-26.08.kdenlive` and sets:
   - The `<profile>` attributes from the preset: 1080p30 is 1920×1080 at
     30/1, 1080p60 is 1920×1080 at 60/1, 1440p60 is 2560×1440 at 60/1,
     2160p30 is 3840×2160 at 30/1. Also the matching
     `kdenlive:docproperties.profile` description.
   - The preset is `videoPreset` from Settings → Video unless the tool call
     names another.
   - The `root` attribute to the working folder, and fresh UUIDs for the
     document and the sequence (add `uuid = { version = "1", features = ["v4"] }` to
     `src-tauri/Cargo.toml`).

   The default project path is `<episode>/<episode name>.kdenlive`. An
   existing project anywhere inside the working folder can be named instead
   (the user's projects sit in the series folder), resolved by
   `resolve_in_working`.
   - `default_project(working_dir, episode)` decides which project a tool
     means when none is named: the project the episode's last `video_cut`
     used (recorded in `<episode>/.haruspex/state.json`), else the only
     `.kdenlive` file in the episode folder, else the default path when the
     call creates a project. With several candidates and no record it returns
     "Name the project: a.kdenlive, b.kdenlive." Every later tool uses it.
6. **Adding a bin clip.** For a media path not yet in the bin, write a `chain`
   into `main_bin` with these properties (every path Haruspex writes, in
   `resource` and the `root` attribute, uses forward slashes on all platforms,
   with Windows drive letters kept as `C:/…`): `resource` (relative to `root`
   when inside it, absolute for a Settings intro/outro outside it),
   `mlt_service=avformat-novalidate`, `length` (frames, from the probe),
   `kdenlive:id` (next free integer), `kdenlive:control_uuid` (new UUID),
   `kdenlive:clip_type` (0 = A/V, 1 = audio, 2 = video), `kdenlive:folderid=-1`,
   `audio_index`/`video_index` from the probe, `kdenlive:file_size`, and
   `kdenlive:file_hash`. The hash is Kdenlive's: MD5 of the whole file when
   it is 2,000,000 bytes or smaller, otherwise MD5 of the first 1,000,000
   bytes followed by the last 1,000,000 bytes. This was checked on
   2026-10-25 against the user's `intro.mp4` (3,608,099 bytes), whose computed
   hash matches the `a9d87884…` Kdenlive recorded. A unit test runs the rule
   on generated files of 1 MB and 3 MB. Leave `meta.*` out; Kdenlive regenerates it on open.
7. **`apply_cut(CutSpec)`.**
   - `CutSpec { project?, preset?, intro?: string | true, outro?: string |
     true, items: [{ index?, path?, in_secs?, out_secs? }] }`. Each item has
     exactly one of `index` (an existing main-track item) or `path` (a new
     clip).
   - `intro: true` uses `videoIntroPath` from Settings → Video. When that
     is empty it returns "No intro is set in Settings → Video; name the
     file." A string is a path inside the working folder (for example
     `intro001/intro.mp4`) or the Settings path. `outro` works the same way.
   - Builds the target sequence: optional intro, the items, optional outro.
     Then it diffs that against the current main track: kept items stay with
     their filters, removed items go, new items get a fresh per-track chain
     pair (one on the video track, one on the audio track) and an `AVSplit`
     group.
   - Rewrites both main-track playlists in place. Haruspex never writes a
     `<blank>`. A `<blank>` already between two items that both stay
     adjacent is kept; any other blank is dropped as the cut closes up.
   - Updates the tractor, sequence and black-track `out`.
   - Out-of-range in/out values are clamped to the clip length, with a note
     in the result.
   - `preset`, when given on an existing project, rewrites `<profile>` and the
     profile description the same way `template.rs` does. Renders always use
     the project's profile, so this is how the model changes the output
     format.
8. **`apply_op(ProjectOp)`.** `trim { index, in_secs?, out_secs? }`,
   `remove { index }`, `move { from, to }`. Each one re-uses the cut diff
   machinery on the current item list, so groups and lengths stay right.
9. **Saving.**
   - Before each write, copy the current file to
     `<episode>/.haruspex/backups/<name>-<UTC yyyymmddThhmmss>.kdenlive`, keeping
     the newest 20.
   - Write to a temp file in the same folder and rename over the original.
   - Every edit is read-modify-write in one command, so it always starts from
     what's on disk, including a save the user just made in Kdenlive.
   - After writing, load-check with `melt <project> -consumer null
     real_time=0 out=0` (the `melt` from Phase 01). On failure, restore the
     backup and return melt's error.
10. **Summary (`video_project_summary`).** The profile, then the main track's
    items with index, path, source in/out, timeline start, duration and a
    "has your effects" flag. Then a count of things Haruspex doesn't edit
    ("2 other tracks, 1 guide, 3 user effects — kept as is") and the total
    length.
11. **Tools (`video.ts`).**
    - `video_project_read { episode, project? }` → the summary.
    - `video_cut { episode, project?, preset?, intro?, outro?, items[] }` → creates the
      project if missing, applies the cut and returns the new summary plus:
      "If this project is open in Kdenlive, close it without saving and
      reopen it, or Kdenlive will overwrite these changes."
    - `video_edit { episode, project?, op, index, ... }` → applies one op and returns
      the summary.

    The schema descriptions explain item order and seconds. `displayLabel`
    examples: "Cutting ep12 (14 clips)", "Trimming clip 3".

## Build gate

- `npm run check`
- `npm run lint`
- `npm run format:check`
- `npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
- `./scripts/export-ipc-types.sh` leaves no diff.
- `npm run test` and `cargo test` also pass on mactest and wintest
  (`ssh haruspex-mac`, `ssh haruspex-win`).

## Test plan

- Rust:
  - Round trip: `open` + `save` with no edits is byte-identical for both
    fixtures and the template.
  - `apply_cut` on the template gives the expected entries, chains, groups and
    lengths (golden file).
  - Re-applying the same cut is a no-op (byte-identical).
  - On `user-edited.kdenlive`, a cut that keeps item 2 keeps its effect, and
    the V2 clip, the guide and the user's groups are unchanged byte-for-byte
    outside the main track's spans.
  - `trim` / `remove` / `move` goldens.
  - A document version other than 1.1 is refused for edits.
  - On `user-edited.kdenlive`, the user's mix is byte-identical after a trim of
    item 1, and a `move` of item 3 is refused.
  - A trim of the start of an item given by `index` keeps its filter.
  - `default_project` with zero, one and two projects and with a recorded
    state.
  - `intro: true` with an empty setting returns the error.
  - The frame/time conversion round-trips at 30, 60 and 30000/1001.
  - `file_hash` matches the fixture's recorded value for a test media file.
- Ignored-by-default integration test (`cargo test -- --ignored kdenlive_accepts`)
  for each golden: runs `QT_QPA_PLATFORM=offscreen kdenlive <golden> out.mp4
  --render` and checks that it exits 0 with a non-empty output. Run on Linux in
  this phase and on mactest/wintest in Phase 03.
- Vitest: tool argument parsing and clamping notes; summary formatting.
- Manual, Linux:
  - In Chat with the series folder picked, "make ep010 with the intro, then the
    OBS recording from 0:05 to the end". Open the project in Kdenlive 26.08: no
    warning dialog, intro then recording, A/V linked, timeline length right.
  - Add an effect and a music track in Kdenlive and save. Ask the model to
    trim the start. The effect and the music track survive.
  - Add a crossfade in Kdenlive between two clips and ask the model to move one
    of them: it refuses and says why.

## Commit

`feat(video): read and edit Kdenlive projects, add video_cut and video_edit`

## Rollback

Revert the commit. Projects already written are ordinary Kdenlive files and
stay valid. Backups under `.haruspex/backups/` can be deleted by hand.
