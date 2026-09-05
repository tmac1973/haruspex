# Phase 11 — CardDAV read

**Depends on:** Phase 10 · **Enables:** nothing (leaf).

## Goal

Contacts alongside calendar and email, completing the PIM story. Small phase by
design: the DAV client, discovery, auth and account model all come from Phase 10.

## Files touched

- **NEW** `src-tauri/src/integrations/dav/carddav.rs` — address books, queries.
- **NEW** `src-tauri/src/integrations/dav/vcard.rs` — vCard → normalized contacts.
- **EDIT** `src-tauri/src/integrations/dav/discovery.rs` — `_carddavs._tcp`,
  `/.well-known/carddav`, `addressbook-home-set`.
- **EDIT** `src-tauri/src/integrations/dav/account.rs` — a capability flag for
  accounts serving one protocol but not both.
- **EDIT** `src-tauri/src/integrations/dav/commands.rs`
- **NEW** `src/lib/agent/tools/contacts.ts` + test.
- **EDIT** `src/lib/components/settings/CalendarSection.svelte` — surface
  discovered address books alongside calendars (one account, both collections).

## Implementation

### Discovery

The same ladder as CalDAV against the CardDAV service. One account commonly
serves both — Nextcloud and Fastmail do — so discover both from a single set of
credentials and record which the server actually offers. An account offering only
one must not present a broken half.

### Reading contacts

`addressbook-query` REPORT, with `addressbook-multiget` to fetch matched hrefs.
Normalize vCard (2.1, 3.0 and 4.0 all appear in the wild) to a flat shape:
display name, structured name, emails with types, phones with types,
organization, title, note, birthday, addresses, photo presence.

Skip the photo bytes by default — a base64 JPEG per contact would flood the
context for no benefit. Note that a photo exists; fetch it only if a later phase
needs it.

Malformed or exotic vCards degrade to whatever parsed, never a failed query. A
contact list is exactly the kind of data with one weird entry in it.

### Tools

- `contacts_search(query)` — over name, email, phone, organization.
- `contacts_get(identifier)` — full detail for one contact.

Same account resolution and fan-out as Phase 10.

### Why this is worth its own phase

It shares everything structural with CalDAV but nothing in its parsing, and vCard
version drift is the kind of detail that quietly produces wrong answers. Keeping
it separate keeps Phase 10 reviewable and lets CalDAV ship on its own.

## Build gate

```bash
npm run check && npm run lint && npm run test
cargo test  --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
node scripts/check-ipc.mjs && ./scripts/export-ipc-types.sh
```

## Test plan

- **Unit (Rust)** — vCard 2.1 / 3.0 / 4.0 fixtures; quoted-printable and base64
  encodings; folded lines; multiple emails and phones with types; a malformed
  card is skipped without failing its siblings; discovery for an account offering
  only CardDAV.
- **Unit (TS)** — tool gating; search matches across all indexed fields.
- **Manual** — against a real account: search by partial name, by email domain,
  and by organization; fetch full detail; confirm an account with both
  collections shows both.

## Commit

`feat(contacts): read-only CardDAV contacts integration`

## Rollback

Revert. CalDAV is unaffected.
