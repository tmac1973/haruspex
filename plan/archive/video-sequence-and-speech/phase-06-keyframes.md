# Phase 06 — Keyframe stills

**Depends on:** 01 (`video_still` for existing clips' first frames), 04 (clip
plan and progress file), 05 (the job pipeline) · **Enables:** 07 (start and end images for clips)

## Goal

Make the still each generated section starts from, and the re-anchor stills,
with the image backend, keeping one subject across sections; use the user's
own start image where the spec gives one; fall back to text-to-video when
there is no image backend. In Attended mode, stop to show the stills — the
cheap checkpoint before hours of video.

## Files touched

- `src/lib/agent/jobs/types/video-sequence/keyframes.ts` — the stage.
- `src/lib/agent/jobs/types/video-sequence/pipeline.ts` — replace the
  Keyframes placeholder.
- `src/lib/agent/jobs/types/video-sequence/keyframes.test.ts`.
- Reused, not changed: `src/lib/agent/tools/_imageJob.ts` and the image
  backend resolver (`resolveImageBackend`) for generate and edit.

## Steps

1. For each generated section in order:
   - `start_image` given: copy nothing; record it as the section's keyframe.
   - Else, with `image_keyframes` on and an image backend:
     - First such section: generate from `style + keyframe_prompt (or
       prompt)` at the instance's video size (nearest size the image model
       takes, then cropped to the video aspect).
     - Later sections: when the backend can edit with a reference picture,
       edit the first keyframe ("the same <subject> as in the picture, <this
       section's prompt>"); otherwise generate from `style + prompt`.
   - Else: no keyframe; the section opens text-to-video.
   Save to `<episode>/keyframes/<section>.png`; record in the progress file.
2. Re-anchor stills: for each `reanchor(section, n)` in the clip plan, edit
   the section keyframe with the clip's prompt (or reuse the keyframe when the
   backend cannot edit) to `keyframes/<section>-r<n>.png`.
3. Existing-clip sections that a transition ends on: `video_still_extract`
   `first` into `keyframes/<section>-first.png`.
4. A keyframe already listed done in the progress file and present on disk is
   skipped (resume).
5. Attended: present all stills in one message (as asset generation's style
   anchor does: `image_store_bytes`, `registerLocalImage`, markdown) and ask
   **Approve**, **Redo one** (pick a section, optional note → remake that
   keyframe and its re-anchors), **Stop**.

## Build gate

`npm run check` · `npm run lint` · `npm run format:check` · `npm run test`.

## Test plan

- Unit (fake image backend): two sections, edit-capable backend → the second
  keyframe is an edit of the first; generate-only backend → both generated;
  no backend → no keyframes and the plan's starts stay `text`; a user
  `start_image` is used as is; a rerun skips keyframes on disk.
- Hand: the fox spec on Lemonade or ComfyUI; the summer fox looks like the
  snow fox.

## Commit

`feat(jobs): Video sequence keyframe stills`

## Rollback

Revert the commit; the stage goes back to its placeholder. Stills already
written stay in `keyframes/` and are harmless.
