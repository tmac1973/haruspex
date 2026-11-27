# Phase 10 — DAV foundation + CalDAV read

**Depends on:** nothing (track B) · **Enables:** Phase 11.

## Goal

Complete the local-first PIM story that IMAP started: let the agent answer
questions about the user's calendar. Build the shared DAV client here, so
CardDAV in Phase 11 is mostly parsing.

Read-only, exactly as email shipped read-only first and gained sending later.

## Files touched

- **NEW** `src-tauri/src/integrations/dav/mod.rs`
- **NEW** `src-tauri/src/integrations/dav/client.rs` — PROPFIND/REPORT, auth.
- **NEW** `src-tauri/src/integrations/dav/discovery.rs` — RFC 6764.
- **NEW** `src-tauri/src/integrations/dav/account.rs` — the ts-rs account struct.
- **NEW** `src-tauri/src/integrations/dav/caldav.rs` — collections, event queries.
- **NEW** `src-tauri/src/integrations/dav/ical.rs` — iCalendar → normalized events.
- **NEW** `src-tauri/src/integrations/dav/commands.rs`
- **EDIT** `src-tauri/Cargo.toml` — `quick-xml` (DAV is XML; the existing
  `scraper` is an HTML parser and is the wrong tool), plus an iCalendar/vCard
  parser chosen to cover **both** formats so Phase 11 reuses it.
- **EDIT** `src-tauri/src/integrations/mod.rs` — `pub mod dav;`.
- **NEW** `src/lib/agent/tools/calendar.ts` + test.
- **EDIT** `src/lib/agent/tools/types.ts` — `'calendar'` category.
- **EDIT** `src/lib/agent/tools/registry.ts` — filter arm + hard gate.
- **EDIT** `src/lib/stores/settings.ts` — `integrations.dav.accounts[]` and a
  `hasEnabledCalendarAccount()` predicate.
- **NEW** `src/lib/components/settings/CalendarSection.svelte`.
- **EDIT** `src/lib/components/settings/SettingsPanel.svelte`.

## Implementation

### Auth: basic / app-password only

No OAuth is added to the tree. That covers Nextcloud, Fastmail, iCloud, Radicale,
Baikal and Synology — the self-hosted and privacy-oriented services this app is
for. **Google Calendar is not hand-built**; its CalDAV endpoint requires OAuth2,
and per the project's own rule it ships as a curated MCP config instead.

Say this in the UI. A user who adds a Google address and watches it fail with a
generic auth error is a support burden; a field that says "Google Calendar is
available through Integrations → MCP" is not.

### Discovery (RFC 6764)

Given an email-like address or a bare server URL:

1. DNS SRV `_caldavs._tcp` (and `_carddavs._tcp` in Phase 11), then
2. `/.well-known/caldav`, following redirects, then
3. `current-user-principal` via PROPFIND, then
4. `calendar-home-set`, then
5. PROPFIND the home set for collections (`displayname`, `calendar-color`,
   `supported-calendar-component-set`, `getctag`).

Always allow a manual URL override — plenty of self-hosted setups have partial
discovery, and a user who knows their URL should not be blocked by a missing SRV
record.

### Reading events

`calendar-query` REPORT with a time-range filter, so the server does the
filtering rather than shipping an entire calendar over the wire. Expand recurring
events over the requested window; a recurrence rule the model has to reason about
itself is a wrong answer waiting to happen.

Normalize before the model sees it: summary, start, end, all-day flag, location,
attendees, organizer, status, and the calendar it came from — a flat shape like
`EmailListing` in `integrations/email/`, not raw iCalendar. Timezones resolve to
the user's local zone with the original zone retained.

Cache per collection using `getctag`/`ETag` so a repeated question does not
re-fetch. Cache is a nicety; correctness never depends on it.

### Tools

- `calendar_list_events(start?, end?, calendar?)` — defaults to a sensible window
  around now rather than requiring the model to compute dates.
- `calendar_search(query, start?, end?)` — text match over summary, description,
  location, attendees.

Account resolution mirrors `resolveEmailAccounts` in
`src/lib/agent/tools/email.ts`: match by UUID, then label, then address, and
fan out across all enabled accounts when unspecified. Reuse that logic's shape —
it exists because models identify accounts by whatever name the user used.

### Account shape

Mirror `EmailAccount` from `integrations/email/auth.rs`: frontend-generated UUID,
label, per-account `enabled`, camelCase serde, credentials in the settings blob
at the same trust level as the existing IMAP passwords. Multi-account from day one.

## Build gate

```bash
npm run check && npm run lint && npm run test
cargo test  --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
node scripts/check-ipc.mjs && ./scripts/export-ipc-types.sh
```

## Test plan

- **Unit (Rust)** — discovery against recorded responses from Nextcloud, Fastmail
  and iCloud; PROPFIND/REPORT XML parsing; recurrence expansion including
  all-day, multi-day, and exception (`EXDATE`/`RECURRENCE-ID`) cases; timezone
  normalization across a DST boundary; malformed iCalendar degrades to a skipped
  event, never a failed query.
- **Unit (TS)** — tool gating on the account predicate; account resolution by
  UUID, label and address; multi-account fan-out.
- **Manual** — against a real Nextcloud or Fastmail account: discovery, list
  this week, search by attendee, and confirm a recurring event appears on the
  right days.

## Commit

`feat(calendar): read-only CalDAV calendar integration`

## Rollback

Revert. Tools are hidden with no enabled account, so a partial landing is inert.
