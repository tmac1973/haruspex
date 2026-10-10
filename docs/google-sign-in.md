# Sign in with Google

Settings → Integrations → Calendar & Contacts → **Sign in with Google** connects
a Google account's calendars and contacts, read-only. The user approves access
in their browser; they never touch the Google Cloud console.

## How it works

- **OAuth** (`src-tauri/src/integrations/dav/google.rs`): Google's installed-app
  flow. Haruspex listens on a random loopback port, opens the consent page with
  PKCE, and trades the returned code for a refresh token. The refresh token goes
  straight to the secret store under `dav:<account id>`; the frontend only gets
  its key. Access tokens are refreshed on demand and cached in memory.
- **Scopes**: `openid email` (to name the account), `calendar.readonly` and
  `contacts.readonly`. Nothing that can write.
- **Calendars** come from the Google Calendar API (`google_calendar.rs`), not
  CalDAV. Google's CalDAV lists calendars for a read-only token but refuses to
  return events without the full read-write `calendar` scope, whose consent
  screen asks to "see, edit, share and permanently delete" calendars. The
  Calendar API serves events under `calendar.readonly` and expands recurrence
  itself.
- **Contacts** come from the People API (`google_contacts.rs`), not CardDAV.
  Google's CardDAV accepts only the `carddav` scope, which the consent screen
  describes as "see, edit, download, and permanently delete your contacts".
  The People API reads "My contacts" under `contacts.readonly`.

## The OAuth client

Haruspex has one Google Cloud project ("Haruspex") with a **Desktop app** OAuth
client. `build.rs` compiles it in from `src-tauri/google-oauth.json`:

```json
{
	"clientId": "….apps.googleusercontent.com",
	"clientSecret": "GOCSPX-…"
}
```

Google does not treat a desktop client's secret as confidential, because it ships
inside the app. It is still gitignored, because GitHub's secret scanning flags
the `GOCSPX-` pattern. Release CI writes the file from the `GOOGLE_OAUTH_JSON`
repository secret, which holds the same JSON, but only when the `GOOGLE_SIGN_IN`
repository variable is `true`. It is unset until Google verifies the app, so
releases ship without Google sign-in while local builds keep it. To turn it on:
`gh variable set GOOGLE_SIGN_IN --body true`, then restore the **Sign in with
Google** bullet in `docs/guide/integrations.md` and the README.

A build without the file works, but doesn't offer Google sign-in. After adding
the file to a checkout for the first time, `touch src-tauri/build.rs` so Cargo
picks it up.

### Project settings

In the Cloud console, for the Haruspex project:

- **APIs enabled**: Google Calendar API and People API. The CalDAV and
  CardDAV APIs aren't used and can be disabled.
- **Google Auth Platform → Audience**: External. While the app is in **Testing**,
  only listed test users can sign in (up to 100), and Google shows an "unverified
  app" screen first.
- **Data access**: `…/auth/calendar.readonly` and `…/auth/contacts.readonly`.

### Branding and the public site

Google Auth Platform → Branding links to three pages, served by GitHub Pages
from `site/` (deployed by `.github/workflows/pages.yml`) on the custom domain
`haruspex.spronglehump.com`:

- Home page: `https://haruspex.spronglehump.com/`
- Privacy policy: `https://haruspex.spronglehump.com/privacy/`
- Terms of service: `https://haruspex.spronglehump.com/terms/`

The authorized domain is `spronglehump.com`. Leave the logo empty: uploading
one sends the app to brand review before anything else can change.

The privacy policy is what a verification reviewer reads. Keep it accurate if
the scopes change or Google data starts going anywhere new.

### Verification

What to submit is in [google-verification.md](google-verification.md).

### Before a public release

Both scopes are *sensitive*, not *restricted*, so verification needs no
third-party security assessment. It does need:

- a homepage and a privacy policy on a domain you control, linked under Branding;
- the domain verified in Search Console;
- a short video showing the consent screen and how the data is used;
- submitting the app for verification under Google Auth Platform → Verification
  Center.

Until then the app is published but unverified: any Google account can sign in
after an "unverified app" screen, up to 100 users in total.

## Testing against a real account

`google::tests::live_google_sign_in_and_discovery` is `#[ignore]`d. It opens a
browser for consent, then lists events and contacts through the same commands
the model calls:

```bash
cd src-tauri
HARUSPEX_GOOGLE_TOKEN_FILE=/tmp/google-token HARUSPEX_GOOGLE_EMAIL=you@gmail.com \
  cargo test live_google_sign_in_and_discovery -- --ignored --nocapture
```

The token file keeps the refresh token, so later runs skip the consent screen.
Delete the file when you're done.
