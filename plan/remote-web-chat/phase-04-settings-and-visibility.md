# Phase 04 — The Host's Side

The switch, the link to hand out, and knowing what is happening on your own
machine. Depends on phases 01–03.

## Steps

### 1. The switch

A new Settings section — Remote Access — with:

- an enable toggle, **off by default**; enabling starts the server, disabling
  stops it and drops live sessions
- a port (default something memorable and unprivileged), and the resulting URL
  shown as a copyable link *with the token already in it*, since that link is
  the entire setup procedure for the guest
- a QR code of that link. The target user is holding a phone or standing at a
  gaming PC; typing a token by hand is the step where this feature would lose
  them
- a "rotate token" button, which invalidates existing links

The address shown must be the LAN address, not `0.0.0.0` or `localhost` — a
link nobody else can open is the most likely way for this to look broken.

### 2. Say what enabling does

Next to the toggle, not buried:

> Anyone on your network who has this link can chat with your Haruspex, using
> your computer's GPU. Their conversations are saved here. Traffic is not
> encrypted, so use this on networks you trust.

That is the honest description. A user who reads it and proceeds has consented
to what is actually happening; a checkbox labelled "enable remote access" has
not told them any of it.

The Windows firewall prompt on first bind is accepted as part of the flow
(decided), so the copy should pre-empt it: "Windows will ask whether to allow
Haruspex on your network — say yes, or nobody can connect."

### 3. Remote activity

A read-only panel showing, per connected client: its label, the current or last
prompt, and the answer streaming in.

This is cheap because the driver already holds the deltas — it is a small
store the remote driver writes to, rendered in the settings section or beside
the chat tab. It is **not** the chat store, and it is not live-mirroring a
conversation into the chat tab, which would require making the chat store
per-conversation. See the overview's non-goals.

The full conversation remains readable in the sidebar afterwards, which is
where anyone actually wanting to read a thread will go.

### 4. Disconnect and revoke

Per-session disconnect, and the token rotation from step 1. Both are the
"my friend is being annoying" affordance, and both are more useful than any
amount of per-request access control at this scale.

### 5. Tests

- Toggling off stops the listener and closes live streams.
- The displayed URL uses a LAN address and carries a working token.
- Rotating invalidates old links and the new link works.
- The activity panel shows a live remote turn and clears when it ends.

## Verification

- Enable, scan the QR from a phone, chat.
- Rotate the token with the phone still connected: it drops, and the new link
  works.
- Watch a remote turn appear in the activity panel while using the local chat
  tab at the same time — the two must not interfere, which is the whole point.

## As built (2026-08-17)

A Remote access section in Settings, under Capabilities, with the switch, the
port, the link, the QR code, rotation, and a live panel of who is connected.

**The LAN address is found by asking the OS which route it would take.** A
connected UDP socket picks an interface without sending a packet, and its local
address is the one a guest can reach. The alternative — walking every interface
and choosing — gets VPN adapters, Docker bridges and Hyper-V switches wrong in a
way that is invisible until someone says "it doesn't load". On a machine with no
route the panel says so plainly rather than showing `127.0.0.1`, which would
look like a working link and reach nobody.

**The QR code is a matrix, not an image.** `qrcode` (default features off) gives
the module grid; the frontend turns it into a single SVG `path`. Nothing is
returned as markup, so nothing has to be trusted as markup, and it is one
attribute rather than a thousand elements. This is the part that decides whether
the feature reaches a non-technical friend at all: the token is 32 characters of
noise and the guest is holding a phone.

**Rotation is revocation, and it is tested as such** — a server restarted with a
new token answers 401 to the old one and 202 to the new one. There is nothing
else to revoke at this scale, which is why the button is worth more than any
amount of per-request access control.

**Per-guest disconnect** drops the session, ends its SSE stream and cancels
whatever it had running. The conversation stays, because it is a database row.

**The activity panel is not a mirror.** The driver already holds every delta on
its way to the guest, so it writes them to a small store as well — label, current
prompt, answer so far, state. Live-mirroring a conversation into the chat tab
would mean making the singleton-shaped chat store per-conversation, which is a
rewrite in service of a status panel. Anyone who wants to read a thread opens it
in the sidebar, where it is a normal conversation.

Connected-guest state is polled every 3s while the section is open, because a
closed tab is not an event this window hears about.

## Still owed

The three verification items are manual and undone: scanning the QR from a phone
and chatting, rotating with a phone still connected, and watching a remote turn
in the panel while using the local chat tab. That last one is the whole point of
the feature and the only one that cannot be inferred from the tests.
