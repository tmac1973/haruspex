# Phase 08 — YouTube upload

**Depends on:** 01 (Settings → Video), 02 (`default_project`), 03 (renders, the background task
registry, card and follow-up turn), 05 (chapters file), 07 (thumbnail) ·
**Enables:** nothing further; this completes the overview's flow

## Goal

The user signs in to YouTube once in Settings → Video. After that the model can
propose an upload of a render, with title, description (chapters included),
tags, category and thumbnail. Haruspex shows an upload dialog with everything
that will be sent. The user edits what they like, picks private, unlisted or
public (private preselected), answers YouTube's "made for kids" question, and
confirms. Nothing is uploaded without that click. The upload runs in the
background on the Phase 03 task card, resumes after a dropped connection, and
reports the video link in a follow-up turn. Only the `youtube.upload` scope is
requested. Captions aren't uploaded; the SRT stays next to the render.

## Files touched

- `src-tauri/src/integrations/dav/google.rs` — make `sign_in` and
  `consent_url` take a scope set, so `SCOPES` becomes the calendar set and a
  new `YOUTUBE_SCOPES = "openid email
  https://www.googleapis.com/auth/youtube.upload"` sits beside it.
  `access_token` is unchanged.
- `src-tauri/src/video/youtube.rs` — new: YouTube sign-in/out, the resumable
  upload, and `thumbnails.set`.
- `src-tauri/src/video/mod.rs` — declare `youtube`.
- `src/lib/components/video/VideoTaskCard.svelte` — upload label and the Open
  on YouTube / Open in Studio buttons.
- `src/lib/video/taskWatch.ts` — the upload notice text.
- `src-tauri/src/video/tasks.rs` — a second task kind, `upload`, using the
  same registry, progress event, cancel and orphan handling (no child process;
  cancel aborts the tokio task). One upload and one render may run at the same
  time; a second upload is refused like a second render.
- `src-tauri/src/video/commands.rs` — `youtube_sign_in`, `youtube_sign_out`,
  `youtube_account`, `youtube_upload_start`.
- `src-tauri/src/lib.rs` — register the commands.
- `src/lib/ipc/gen/*` — regenerated (`YoutubeAccount`, `UploadRequest`,
  `Visibility`).
- `src/lib/stores/youtubeUploadApproval.svelte.ts` — new: the pending-upload
  modal store, modelled on `src/lib/stores/skillApproval.svelte.ts`.
- `src/lib/components/video/YoutubeUploadDialog.svelte` — new: the confirm
  dialog.
- `src/lib/components/video/YoutubeUploadDialog.test.ts` — new.
- `src/routes/+layout.svelte` — mount the dialog next to
  `SkillApprovalModal`.
- `src/lib/components/settings/VideoSection.svelte` — a YouTube row: "Sign in
  to YouTube", or the signed-in email with Sign out.
- `src/lib/agent/tools/youtube-upload.ts` — new: registers `youtube_upload`
  (category `video`).
- `src/lib/agent/tools/youtube-upload.test.ts` — new.
- `src/lib/agent/tools/index.ts` — import it.
- `docs/guide/video.md` — add "Upload to YouTube", saying it never uploads
  without your confirmation and that captions are added in YouTube Studio.
- `docs/google-verification.md` — add the youtube.upload justification text.

## Steps

1. **Scopes.** Refactor `google.rs` so `sign_in(scopes, proxy)` builds the
   consent URL from its argument. Calendar keeps calling it with `SCOPES`, so
   its tests stay as they are. YouTube calls it with `YOUTUBE_SCOPES`. The two
   grants are separate refresh tokens, so signing out of one leaves the other.
2. **Account (`youtube.rs`).** `youtube_sign_in(proxy)` runs the consent flow,
   checks that the granted scope includes youtube.upload (otherwise it returns
   "Google didn't grant upload access."), and stores the refresh token with
   `secrets` under `youtube:refresh` and the email under `youtube:email`.
   `youtube_account()` returns the email or none. `youtube_sign_out` revokes
   the token with `google::revoke` and deletes both secrets.
   `google_sign_in_available()` also gates the YouTube row. Release builds
   only have it when the `GOOGLE_SIGN_IN` variable is set.
3. **The tool proposes; the user decides (`youtube-upload.ts`).**
   - `youtube_upload { episode, project?, render?, title, description, tags?,
     category_id?, thumbnail?, chapters?: boolean }`. The project comes from
     Phase 02's `default_project` and names the default thumbnail and
     chapters files.
   - It resolves the render (default: the newest in `<episode>/renders/`) and
     the thumbnail (default: `<project stem>.thumbnail.jpg` when present). With
     `chapters` true (the default) it appends `<project stem>.chapters.txt` to
     the description after a blank line, when that file exists.
   - It validates YouTube's limits: title 1–100 characters with no `<` or `>`,
     description up to 5,000 bytes, tags up to 500 characters in total.
     Violations are returned to the model, not trimmed.
   - It refuses when not interactive: "Uploading needs you here; this run is
     unattended."
   - It refuses when not signed in: "Sign in to YouTube in Settings → Video
     first."
   - Then it calls `askYoutubeUpload(request)` and waits, with
     `ctx.onApprovalWait`.
4. **Dialog (`YoutubeUploadDialog.svelte`).**
   - Shows the file name, duration and size; the thumbnail preview; editable
     title, description and tags; and a category select (default 22, People &
     Blogs, with YouTube's standard list).
   - Visibility is a radio with Private preselected, Unlisted and Public.
   - "Made for kids" is a required Yes/No with no default; Upload is disabled
     until it's answered.
   - It also shows the signed-in email.
   - Buttons are Upload and Cancel. Cancel returns "The user cancelled the
     upload." to the model. Upload returns the user's final values; the tool
     result reports which fields the user changed.
   - Copy follows the UI rules: one short sentence, "Uploads to <email>'s
     channel."
5. **Upload task (`youtube.rs` + `tasks.rs`).**
   - `youtube_upload_start(request)` starts an `upload` task. It POSTs
     `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`
     with the snippet (title, description, tags, categoryId) and status
     (privacyStatus, selfDeclaredMadeForKids).
   - It then PUTs the file in 16 MiB chunks with `Content-Range`, emitting
     `video-task-progress` after each chunk.
   - On a network error or 5xx, it queries the upload status (`Content-Range:
     bytes */<size>`) and resumes from the server's offset. It retries with
     backoff of 2, 4, 8, 16 and 32 s, then fails.
   - On 401 it refreshes the access token once.
   - Use the network proxy from Settings → Network (`http_util` client with
     proxy), never the search proxy.
   - When the video resource comes back with an `id`, the task POSTs the
     thumbnail to `thumbnails.set`. A thumbnail failure (for example an
     unverified channel without custom thumbnails) doesn't fail the upload;
     it's reported as a problem.
   - Done state: `{ video_id, url: https://youtu.be/<id>, studio_url, problems
     }`.
6. **Follow-up and card.** The task appears on `VideoTaskCard` as "Uploading
   ep012 to YouTube", and its done state shows Open on YouTube and Open in
   Studio. `taskWatch` (Phase 03) delivers "YouTube upload finished: <url>
   (private). Thumbnail set." to the conversation.
7. **Google verification (hand step, outside code).** Add `youtube.upload` to
   the Haruspex OAuth consent screen and write its justification into
   `docs/google-verification.md`. Record a demo video of the upload dialog and
   resubmit for verification. Until Google approves, users see the
   "unverified app" screen for the YouTube sign-in and the 100-user cap
   applies. #388 is closed, so open a new GitHub issue for this when the phase is merged.

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
  - The consent URL carries exactly the YouTube scopes for the YouTube flow
    and exactly the calendar scopes for calendar (the existing tests keep
    passing).
  - A grant missing youtube.upload is refused.
  - Resumable upload against a local mock server (axum is already a
    dependency): a happy path in chunks; a dropped connection mid-chunk
    resumes from the server's offset; 401 refreshes once; a thumbnail 403 is
    reported as a problem, not a failure.
  - Cancel aborts with no further requests.
- Vitest:
  - The tool refuses when unattended and when signed out.
  - Limit validation messages.
  - The chapters file is appended.
  - The dialog: Private is preselected, Upload is disabled until "made for
    kids" is answered, and edited values are returned.
  - Cancel returns the cancellation text.
- Manual, Linux, on a test channel:
  - Sign in from Settings → Video.
  - Ask the model to upload the ep010 render. The dialog shows the right file,
    thumbnail and description with chapters. Change the title, pick Unlisted,
    say No to made for kids, and confirm.
  - The card shows progress, and the follow-up turn gives the link. YouTube
    Studio shows the video as Unlisted with the edited title, the chapters
    and the thumbnail.
  - Pull the network cable for 20 s mid-upload: it resumes.
- Manual, mactest and wintest: sign-in and a small private upload.

## Commit

`feat(video): upload renders to YouTube after the user confirms`

## Rollback

Revert the commit. The `google.rs` scope refactor reverts with it and Calendar
keeps working. Stored YouTube secrets become unused; signing out first (or
revoking at myaccount.google.com) removes the grant. Uploaded videos stay on
YouTube.
