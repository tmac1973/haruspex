# Phase 07 — Live verification and follow-ups

**Depends on:** 01–06 · **Enables:** the next release

## Goal
Prove the whole path against the real servers (compute2:3000 and
asmodean:3000). Record the measurements in `docs/image-generation.md` and the
toolchest verification notes, and file the follow-ups the overview defers, so
nothing lives only in this plan.

## Files touched
- **`docs/image-generation.md`:** a "Measured" block under "The llama-toolchest
  backend" (instance, size, seconds, jobs vs sync).
- **`docs/guide/music.md`:** a "What has been tested" line, with the hosts
  named generically ("an R9700 and an A4000"). Stay under 6 KB.
- **`/home/tim/Projects/llama-toolchest/plan/generation-backends/verification.md`:**
  replace the "Haruspex has no provider…" note (L239-245) with the results.
- GitHub issues, through `gh issue create`. No files.

## Steps
1. **Live script.** Drive a dev build through the Remote control API on 8788,
   per the existing live-test practice, with settings through
   `webview-store.json`.
   - **Image:** toolchest on asmodean (`qwen-turbo-local`): one square and
     one cancelled mid-run.
   - **Transparent image:** the `ming-image` instance created on compute2 in
     Phase 02: one transparent sprite, checked for alpha.
   - **Music:** toolchest on asmodean (`ace-xl`) — one 30 s song with lyrics,
     one 10 s instrumental with `path` in a Code session, one cancelled.
   - Record the phase sequence seen, the total time and the output size of
     each run.
2. **Fallback check.** Both hosts run Phase 01, so the synchronous fallback is
   covered by Phase 02's `backend.test.ts` sync-path case alone. Re-run that
   test here and record it.
3. **Restart check.** Restart Haruspex; the song from step 1 plays. Restart
   toolchest; it still plays, served from Haruspex's cache.
4. **Web client.** Open the Remote control page; the song plays and seeks.
5. **Issues.** No open issue covers these (checked 2026-10-24; #626 is
   Lemonade-only), so file three new ones.
   - **"Image editing across backends"**: an `edit_image` tool, toolchest
     `/v1/images/edits` (FLUX.2 klein `edit`), ComfyUI img2img, Lemonade.
   - **"Music follow-ups"**, a checklist:
     - game music/sfx in the asset generation job;
     - a stock ACE-Step (`/release_task`) backend;
     - play audio files opened from the Code tab;
     - step-count progress if sd-server and ace-server expose it.
   - **"Toolchest generation API"**, filed in the toolchest repo with
     `gh -R` and its owner/name from `git remote`, a checklist:
     - a jobs list endpoint;
     - persist jobs across restart;
     - prune audio written before a restart;
     - hard delete of a finished job.
   - Link each issue from the final PR body. #626 is not touched.

## Build gate
```bash
npm run check
npm run lint
npm run test
npm run format:check
cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt -- --check
node scripts/guide-check.mjs
```

## Test plan
This phase is the test. It is done when each run in step 1 has a recorded
result, the fallback, restart and web-client checks pass, and the issues
exist. Any failure found here is fixed in a PR against the phase that owns it
before this phase's docs PR merges.

## Commit
`docs(image,music): record llama-toolchest live results`

## Rollback
Docs-only. Revert the commit. The issues stay open regardless.
