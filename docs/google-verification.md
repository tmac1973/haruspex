# Google OAuth verification

What to submit so Google removes the "unverified app" screen and the 100-user
cap from Sign in with Google. Background is in
[google-sign-in.md](google-sign-in.md).

Both scopes are **sensitive**, not restricted, so there is no third-party
security assessment. Google's review typically takes a few days to a few weeks
and may come back with questions by email.

## 1. Prove you own the domain

The authorized domain is `tmac1973.github.io`. Google checks ownership in
Search Console, at the root of the domain, which a project site (`/haruspex/`)
can't serve. So a user site holds the proof:

1. Open [Search Console](https://search.google.com/search-console) with the
   same Google account that owns the Cloud project. Add a **URL prefix**
   property for `https://tmac1973.github.io/`.
2. Choose **HTML file** verification and download the file
   (`google<random>.html`).
3. Put that file at the root of a repository named `tmac1973.github.io`, with
   Pages on (Settings → Pages → Deploy from a branch → `main` / root). It is
   then served at `https://tmac1973.github.io/google<random>.html`.
4. Click **Verify** in Search Console.

Keep the file there for good: Google re-checks ownership.

## 2. Branding (already done)

| Field | Value |
| --- | --- |
| App name | Haruspex |
| App logo | *empty* (a logo triggers a separate brand review) |
| Home page | https://tmac1973.github.io/haruspex/ |
| Privacy policy | https://tmac1973.github.io/haruspex/privacy/ |
| Terms of service | https://tmac1973.github.io/haruspex/terms/ |
| Authorized domain | tmac1973.github.io |

The home page must describe what the app does and link the privacy policy;
it does both.

## 3. Scope justifications

Paste into Data access → each scope's justification field.

**`https://www.googleapis.com/auth/calendar.readonly`**

> Haruspex is a desktop AI assistant that runs on the user's own computer.
> When the user asks about their schedule ("what's on my calendar this
> week?", "when am I free on Thursday?"), the assistant reads the events in
> the requested date range from the user's calendars to answer. It never
> creates, changes or deletes events, so it requests the read-only calendar
> scope. Events are fetched from Google directly by the app on the user's
> device, only when the user asks, and are not stored or sent to the
> developer.

**`https://www.googleapis.com/auth/contacts.readonly`**

> When the user asks the assistant about a person ("what's Sam's email?",
> "who works at Acme?"), Haruspex reads the user's contacts to find the
> answer. It never creates, changes or deletes contacts, so it requests the
> read-only contacts scope. Contacts are fetched from Google directly by the
> app on the user's device, only when needed, and are not stored or sent to
> the developer.

**Why not a narrower scope?** Both are already Google's narrowest read-only
scopes for the data. `calendar.events.readonly` would not list which calendars
a user has, which is how the assistant names where an event comes from.

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
