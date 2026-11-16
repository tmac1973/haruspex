# Instance sync — Project Overview

Issue: tmac1973/haruspex#1081.

## Problem

Someone with Haruspex on two or three computers has their chats and Code
sessions split between them. Remote control (see `plan/remote-api/` and the
`remote-control` guide page) already lets them reach one computer's sessions
from another, but only from a browser: they leave the app, open a URL, click
past a certificate warning, and work in a page that looks and behaves
differently from the Code tab and Chat they use all day. Nothing finds the
other computers for them.

## Goals

- A Haruspex with **Settings → Remote control → Show my other computers here**
  on finds the other Haruspex computers on its local network by itself (mDNS),
  and takes a typed name or address for one it can't find (a Tailscale or
  NetBird name).
- Each other computer's chats and Code sessions appear in this app's existing
  lists, in a section per computer ("On desk-pc"), and open in the normal Chat
  and Code views with a badge naming where they run.
- From those views you can do what the Remote control web page can: read,
  follow a running turn, send, steer, stop, continue, retry, answer prompts,
  start a new session in a folder there, rename, fork, delete, set effort and
  model, and read files read-only.
- A session on another computer that waits on you (Run this command?, a
  question, an MCP tool, a skill write) marks its row and, when this window
  isn't focused, fires a desktop notification through `src/lib/notify.ts`.
- The other computer's certificate is checked: on first contact this app shows
  its SHA-256 fingerprint to compare with that computer's Settings → Remote
  control → Advanced → Certificate, then pins it. A changed certificate asks
  again; a refused one is never used.
- An unreachable computer keeps its last-known list of titles and times,
  greyed and marked offline, and is retried quietly.

## Non-goals

- **No copying.** Nothing is replicated between computers: transcripts,
  threads, memories and files stay on the computer that owns them. No merge or
  conflict handling exists because nothing is merged.
- **Turns never move.** A session on desk-pc runs on desk-pc, with desk-pc's
  files and models, exactly as it does from the web page.
- **No new pairing protocol.** This app gets in through the other computer's
  existing **Who can connect**: **These computers** or **My whole network**,
  or a script token pasted from **Add a device…** when it is **Devices with a
  token**. No code exchange, no new server-side trust store.
- No Shell, Jobs, Settings, Home, Images, Music or Video of another computer.
- No relaying: this app shows only computers it reaches directly, never a
  computer's view of a third.
- No editing another computer's files; the file viewer is read-only.
- No mobile app; no change to the web client or Guest chat.
- No NAT traversal or relays: the network between computers is the owner's
  (LAN, Tailscale, NetBird).

## Users & primary flow

The owner, with Haruspex on a desktop (desk-pc) and a laptop.

1. On desk-pc: Settings → Remote control → on, Who can connect → **These
   computers** with the laptop's name (or **My whole network**).
2. On the laptop: Settings → Remote control → **Show my other computers
   here** on. desk-pc appears under **Other computers** within a few seconds,
   found by mDNS. (Off the LAN: **Add a computer…** and type its tailnet
   name; desk-pc must then list the laptop's tailnet name under **These
   computers**, since **My whole network** doesn't cover tailnet addresses.)
3. The laptop shows desk-pc's certificate fingerprint; the owner compares it
   with desk-pc's Settings → Remote control → Advanced → Certificate and
   clicks **Trust**.
4. The Code tab's session list and Chat's list each gain an **On desk-pc**
   section with desk-pc's sessions and chats.
5. The owner opens a desk-pc Code session, sends a message, and watches the
   turn stream in the normal Code view, badged "Runs on desk-pc".
6. The turn asks **Run this command?**. The laptop notifies; the owner
   approves from the session view.
7. desk-pc is shut down. Its section greys out, "desk-pc · offline", with the
   titles it last had. When desk-pc is back, it refreshes by itself.

## Constraints

- Stack: Tauri 2.x (Rust) + SvelteKit 5 runes; the agent loop runs in the
  owning computer's webview (`plan/remote-api/overview.md`, decision 2).
- The other computer's API is the existing owner API: HTTPS on port 8788 with
  a self-signed certificate (`src-tauri/src/owner/tls.rs`), `POST
  /api/v1/op`, `GET /api/v1/events` (SSE), uploads and images
  (`docs/guide/remote-control-api.md`). This feature is a client of it; it
  adds no operation the web page lacks, beyond an mDNS advertisement.
- The webview cannot pin a self-signed certificate, so every request to
  another computer goes through Rust, which pins the fingerprint.
- The web client already rebuilds sessions and chats from events
  (`src/web/store.svelte.ts`, `src/lib/engine/reduce.ts`); the desktop reuses
  that, not a second reducer.
- The owner API refuses a request whose `Origin`/`Host` doesn't name the
  computer, and lets in a trusted computer only with `X-Haruspex: 1`
  (`src-tauri/src/owner/trust.rs`); the client must send what it expects.
- **My whole network** trusts only private LAN ranges (RFC 1918, link-local,
  loopback), not Tailscale/NetBird's `100.64.0.0/10`. A computer reached over
  a tailnet needs **These computers** with this computer's tailnet name, or
  a token.
- The other computer replaces its certificate by itself near expiry and
  when its names change, so "Certificate changed" is a normal event.
- `sessions.list` rows carry no time today; phase 01 adds `updatedAt` (a
  field on an existing operation, not a new operation).
- Linux, macOS and Windows. mDNS must work on all three without a system
  daemon the user installs.
- A token pasted for **Devices with a token** is a secret: keyring only
  (`secrets.rs`), never in the settings blob.
- UI copy per CLAUDE.md: one short sentence per section, details in `title`
  tooltips, Settings paths named in full. User guide pages updated in the
  same PRs.
- Off by default; nothing advertises or searches until the owner turns it on.

## Success criteria

- With the switch off, the app sends no mDNS query and opens no connection to
  another computer (checked by test and by packet capture once by hand).
- Two Haruspex instances on one LAN, one with Remote control on and **My whole
  network**, find each other within 10 seconds of the switch going on.
- A computer added by name over a tailnet shows its sessions.
- Every operation the web page offers works on a remote session from the Code
  view and Chat, verified by an automated test against a real owner API.
- A turn on the other computer streams into this app with no visible lag
  beyond the web page's.
- A certificate that changes after pinning blocks all requests and asks the
  owner; a refused fingerprint is never contacted again until re-added.
- An unreachable computer shows its last-known titles greyed and marked
  offline, and comes back without a restart.
- A remote session waiting on the owner fires one desktop notification when
  this window isn't focused.
- A new `other-computers` guide page describes
  all of this, under 6 KB.

## Decisions

- **What "sync" means** → Browse and drive the other computer's sessions
  live through its Remote control API; no copying, turns run where the session
  lives.
- **How computers find each other** → mDNS on the LAN (`_haruspex._tcp`) plus
  adding a name or address by hand for tailnets and other subnets.
- **How one Haruspex gets permission to use another** → The other computer's
  existing Who can connect (These computers / My whole network); no new
  pairing.
- **When the other computer requires a token** → Accept a pasted script token
  from its Add a device… as a fallback, kept in the keyring.
- **Certificate check** → Show the SHA-256 fingerprint on first contact,
  confirm once, pin; a change asks again.
- **Where the other computer's sessions appear** → In the existing Code and
  Chat lists, a section per computer, opening in the normal views with a
  "runs on" badge.
- **What you can do with them** → Everything the Remote control web page
  does; Shell, Jobs and Settings stay out.
- **Offline computers** → Greyed last-known list of titles and times, marked
  offline, retried quietly.
- **Default** → Off; Settings → Remote control → Show my other computers here
  turns on searching. Advertising only while Remote control is on and
  listening on all networks.
- **Prompts waiting on you** → Row badge plus desktop notification when the
  window isn't focused (Haruspex has no notification setting to consult).
- **Rendering remote sessions** → A `CodeSessionView` / `ChatSource`
  interface the existing views take; remote adapters implement it.
- **Transport** → A Rust client per peer that pins the fingerprint; Tauri
  commands for ops, uploads and images.
- **Event stream ownership** → Rust keeps one SSE stream per peer and emits
  it to every window; only the main window answers prompts and notifies.
- **Identity** → A random per-install instance id plus the computer's name,
  in `/api/v1/health` and the mDNS TXT record.
- **mDNS implementation** → `mdns-sd`.
- **Storage** → Peers in settings (token in the keyring); last-known lists in
  a `peer_lists` table.
- **Connection lifetime** → One stream per trusted peer, always, while the
  switch is on.
- **Delivery** → A PR per phase, the switch hidden behind a build flag until
  phase 13.
- **End-to-end test** → Two app instances through the driver, plus Rust and
  unit tests.
- **New session folder on a peer** → Its recent session folders plus a
  typed path.
- **Prompt dialogs** → This app's own approval modals, through an adapter,
  labelled with the computer.
