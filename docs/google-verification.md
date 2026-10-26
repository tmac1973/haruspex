# Google OAuth verification

What was submitted to verify Sign in with Google, which removes the
"unverified app" screen and the 100-user cap. Google approved
`calendar.readonly` and `contacts.readonly` on 2026-10-14 (#388). Background is
in [google-sign-in.md](google-sign-in.md).

Both scopes are **sensitive**, not restricted, so there is no third-party
security assessment. Google's review typically takes a few days to a few weeks
and may come back with questions by email.

## 1. Prove you own the domain

Google rejects a home page on a domain you can't show you control, which is
why `tmac1973.github.io` failed ("home page URL is not registered to you")
even with a verified Search Console property. The site is served on a domain
of our own instead:

- **DNS** (Hover, which also registered `spronglehump.com`): a `CNAME` from
  `haruspex` to `tmac1973.github.io`, and a `TXT` on `@` holding the
  `google-site-verification=…` value.
- **GitHub**: repo Settings → Pages → Custom domain is
  `haruspex.spronglehump.com`, with **Enforce HTTPS** on. The old
  `tmac1973.github.io/haruspex/` URLs redirect there.
- **Search Console**: a **Domain** property for `spronglehump.com`, verified
  by that TXT record, owned by the account that owns the Cloud project.

Keep the TXT record for good: Google re-checks ownership.

## 2. Branding (verified 2026-10-10)

| Field | Value |
| --- | --- |
| App name | Haruspex |
| App logo | *empty* (a logo triggers a separate brand review) |
| Home page | https://haruspex.spronglehump.com/ |
| Privacy policy | https://haruspex.spronglehump.com/privacy/ |
| Terms of service | https://haruspex.spronglehump.com/terms/ |
| Authorized domain | spronglehump.com |

The home page must describe what the app does and link the privacy policy;
it does both.

## 3. Scope justification

Data access has one justification field for both scopes, limited to 1,000
characters. Paste this (984 characters):

> Haruspex is a desktop AI assistant that runs on the user's computer. Both scopes let it answer questions about the user's own data, only when the user asks.
>
> calendar.readonly: for "what's on my calendar this week?", the app reads events in that date range. It also lists the user's calendars to say which one an event is from, which calendar.events.readonly can't do.
>
> contacts.readonly: for "what's Sam's email?", the app looks the person up in the user's contacts.
>
> The app never creates, changes or deletes anything, so it requests only these read-only scopes, the narrowest available for this data.
>
> Google data goes directly between Google and the user's device and is never sent to the developer. The app keeps no copy of calendars or contacts; what the assistant reads stays in that conversation on the device. If the user chooses a remote AI provider, that content is sent to it, as the privacy policy explains. Google data is not sold, used for ads or used to train models.

It mentions the remote AI provider case because the privacy policy does:
reviewers check the two against each other. Keep both in step if either
changes.

## 4. Demo video

Unlisted on YouTube, 2–4 minutes, in English. Google wants to see the whole
OAuth flow and every scope in use. Record the screen of a real install; no
narration needed if captions or on-screen text say what's happening.

1. **The app and its client ID.** Open Haruspex → Settings → Integrations →
   Calendar & Contacts. Show the browser's address bar during the next step
   so the `client_id` in the consent URL is readable
   (`967888378943-…apps.googleusercontent.com`).
2. **Consent.** Click **Sign in with Google**. In the browser, choose the
   account, show the consent screen listing both permissions with the app name
   "Haruspex", and click **Continue**. Show the "Signed in" page.
3. **Back in the app.** The card reads "Signed in as …" and lists the
   calendars and the Contacts address book.
4. **Calendar scope in use.** In Chat, ask "What's on my calendar this week?"
   Show the answer listing real events.
5. **Contacts scope in use.** Ask "What's [a contact]'s email address?" Show
   the answer.
6. **Revoking.** Click **Remove** on the account, then show
   myaccount.google.com/permissions no longer listing Haruspex.

## 5. Submit

Google Auth Platform → **Verification Center** → **Prepare for verification**
(or **Submit for verification**). Paste the video link and confirm the
details above. Answer any emails from the review team from the address on the
Branding page.

## After approval

Verified apps that later add a scope go through review again. If Haruspex
ever needs to write to calendars or contacts, that's a new submission, and
the privacy policy must say so first.

## YouTube uploads (youtube.upload)

The video tools upload a render to the user's channel after they confirm it
(`plan/video-editing/phase-08-youtube-upload.md`). It is a separate sign-in
(Settings → Video → **Sign in to YouTube**) asking for `openid email` and
`https://www.googleapis.com/auth/youtube.upload` only, so it needs its own
review round:

1. Google Auth Platform → **Data access** → add `youtube.upload`, and enable
   the YouTube Data API v3 in the Cloud project.
2. Check the privacy policy says videos are uploaded only when the user
   confirms each one, and that the app reads nothing from the channel. Keep it
   in step with the justification.
3. Paste this justification (under 1,000 characters):

> Haruspex is a desktop AI assistant that can cut and render the user's own videos on their computer. youtube.upload lets it upload a finished video to the user's channel, and only after the user confirms that upload in a dialog showing the file, title, description, thumbnail and visibility (private by default). The app never reads, changes or deletes videos, playlists or comments, so it asks for youtube.upload alone, the narrowest scope that can upload. The video goes directly from the user's device to YouTube and is never sent to the developer. Sign-in tokens stay on the device in the system keychain. Google data is not sold, used for ads or used to train models.

4. Record a demo video as in section 4: the consent screen listing the upload
   permission, the upload dialog with Private selected, the progress card, the
   video in YouTube Studio as Private, then **Sign out** in Settings → Video
   and myaccount.google.com/permissions no longer listing it.
5. Submit as in section 5. Until it is approved, the YouTube sign-in shows
   the "unverified app" screen and the 100-user cap applies.
