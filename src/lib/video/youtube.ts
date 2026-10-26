/**
 * Whether the YouTube upload is offered: the `youtube_upload` tool and the
 * YouTube sign-in in Settings → Video editing. Off until Google verifies the
 * `youtube.upload` scope (#657), since an unverified app's sign-in warns and
 * caps users. The upload code stays; its guide page waits in
 * `docs/youtube-upload.md` and moves back to `docs/guide/youtube.md` with it.
 */
export const YOUTUBE_UPLOAD = false;
