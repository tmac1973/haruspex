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
