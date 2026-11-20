# Phase 08 — Settings → Video editing → Editor, and the tools on `.mlt`

**Depends on:** 05, 06, 07 · **Enables:** 09; Shotcut available to users

## Goal

Users get Shotcut projects. Settings → Video editing → Editor picks the format
for new projects (Shotcut by default), the `video_cut` tool takes an `editor`
override, and every video tool finds, reads, edits and renders `.mlt`
projects the way it does `.kdenlive`. Wording the model or the user sees names
the project's own editor.

## Files touched

- `src/lib/stores/settings.ts` → `videoEditor: 'shotcut' | 'kdenlive'`,
  default `'shotcut'`. Any other stored value is read as `'shotcut'`.
- `src-tauri/src/video/project.rs` → `VideoSettings.editor: Format`.
  `CutSpec.editor: Option<Format>`. `project_files(dir)` matches both
  `.kdenlive` and `.mlt`, skipping the `.mlt` files Shotcut writes that
  aren't projects: one without a main tractor carrying `shotcut="1"`
  (Shotcut's exported playlists and filter presets) is ignored.
  `default_project` creates `<episode>/<episode>.<ext>` using
  `spec.editor.unwrap_or(settings.editor)`. When an episode folder holds both
  a `.kdenlive` and a `.mlt`, `default_project` returns the existing "more
  than one project" error, which names both files and asks for `project`.
- `src/lib/video/args.ts` (where `VideoSettings` is built) → pass `editor`.
- `src/lib/components/settings/VideoEditingSection.svelte` → an Editor select
  (Shotcut, Kdenlive) with the title tooltip "Format for new projects.
  Existing projects keep theirs."
- `src/lib/components/settings/VideoEditingSection.test.ts` → the select
  saves `videoEditor`.
- `src/lib/agent/tools/video.ts` → `video_cut` gains `editor: { enum:
  ['shotcut', 'kdenlive'], description: 'Editor format for a new project.
  Default from Settings → Video editing.' }`. The `project` parameter
  description says "The .mlt (Shotcut) or .kdenlive file". `video_render`'s
  description says "project" instead of "Kdenlive project". The `video_cut`
  description's last sentence becomes "The user can open the project in its
  editor and change it too."
- `src/lib/video/report.ts` → `KDENLIVE_OPEN` becomes
  `editorOpenNote(editor)`, which names Shotcut or Kdenlive.
  `summaryReport` names the editor and its version.
- `src/lib/video/report.test.ts`, `src/lib/agent/tools/video.test.ts`,
  `video.project.test.ts` → Shotcut cases next to each Kdenlive one.
- `src-tauri/resources/skills/cut-video/SKILL.md`,
  `src-tauri/resources/skills/narrate/SKILL.md` → "the project's editor
  (Shotcut or Kdenlive)" where they say Kdenlive. Line 86's refusal example
  gains Shotcut's GPU-mode refusal.
- `src/lib/ipc/gen/*` → regenerated.
- `docs/guide/video-editing.md`, `docs/guide/video-render.md`,
  `docs/guide/settings-tools.md` → Shotcut alongside Kdenlive, the Editor
  setting, and what isn't supported (GPU processing mode, converting between
  formats).

## Steps

1. Add `VideoSettings.editor` and `CutSpec.editor`, then regenerate the IPC
   types.
2. `project_files` and `default_project`, with tests for: only a `.mlt`; only
   a `.kdenlive`; both (error); a non-project `.mlt` next to a project
   (ignored); a new project with the editor from settings; and with the
   per-call override.
3. Settings store field, section select, tool parameter, and the report
   wording.
4. Skills and guide pages. Keep each page under 6 KB, don't run Prettier on
   `docs/guide`, and run `node scripts/guide-check.mjs < /dev/null`.

## Build gate

- `cargo fmt -- --check`, `cargo clippy -- -D warnings`, `cargo test`.
- `./scripts/export-ipc-types.sh` with no diff afterwards.
- `npm run check`, `npm run lint`, `npm run test`, `npm run format:check`.
- `node scripts/guide-check.mjs < /dev/null`.

## Test plan

- Dev app, Editor = Shotcut: "make ep01 from these three clips with 1 s
  crossfades" writes `ep01/ep01.mlt`, the report says Shotcut, and the file
  opens in Shotcut with the crossfades.
- Editor = Kdenlive: the same request writes `ep01.kdenlive`, as before.
- With Editor = Shotcut, asking for "a Kdenlive project for ep02" makes the
  model pass `editor: 'kdenlive'` and get a `.kdenlive`.
- Drive both through `npm run drive` against the fake LLM so the tool-call
  shapes are covered without a real model.

## Commit

`feat(video): make and edit shotcut projects`

## Rollback

Revert the commit and regenerate the IPC types. A stored `videoEditor` is
then ignored, and `.mlt` files are no longer found. Projects already written
stay on disk. Safe to revert on its own.
