# Phase 09 — Another computer's Code sessions in the Code tab

**Depends on:** 07, 08 · **Enables:** 12 (prompt bridge has remote sessions
to badge), 13

## Goal

The Code tab's session list gains an **On <name>** section per trusted peer.
Opening one shows it in the normal Code pane, badged "Runs on <name>", and
everything the Remote control web page can do works from it. An offline
peer's section shows its last-known titles greyed. A new session can be
started on a peer from its recent folders or a typed path.

## Files touched

- `src/lib/peers/remoteCodeSession.svelte.ts` — new: `RemoteCodeSession
  implements CodeSessionView`.
- `src/lib/components/code/CodeSidebar.svelte` — peer sections.
- `src/lib/components/code/PeerSessionSection.svelte` — new: one peer's rows
  (live or greyed offline), "· offline" heading.
- `src/lib/components/code/CodeSessionHeader.svelte` — "Runs on <name>"
  badge when `view.peer` is set.
- `src/lib/components/code/NewSessionDialog.svelte` — a "Where" choice (This
  computer / each connected peer); for a peer, its recent roots plus a path
  field, the worktree tick, and the WSL distro pick when the peer's
  `wsl.distros` returns a non-empty list.
- `src/lib/components/code/CodeTranscript.svelte` — file-name links of a
  remote view open the read-only viewer through `session.readFile`; images
  through `peerImageUrl`.
- `src/lib/editor/document.svelte.ts` — a read-only `EditorIO`,
  `peerFileIO(view)`, whose read calls `session.readFile` on the peer and
  whose write refuses. `FileEditorModal.svelte` is opened through its store
  with that IO in read-only mode; the modal itself is unchanged.
- Tests beside new files.

## Steps

1. `RemoteCodeSession(peer: PeerView, id: string)`:
   - id seen by the registry: `peer:<instanceId>:<sessionId>`, so it can't
     collide with a local id; `peer: {id, name}` field for the badge.
   - state getters read `peer.client.mirrors[id].state` (follow on open,
     unfollow on close), mapping `SessionState` fields one to one; fields
     the state lacks (`totals`, `fileNotes`, `ticket`, `grouped`,
     `pendingToolCalls`, `contextNotice`) are empty/null.
   - actions → ops: `send` → `session.send` (images: each attached image is
     first `peer.client.upload`ed, then sent by hash, ≤ 8); `stop` →
     `session.stop`; `compactNow` → `session.compact`; `cancelShellWait` →
     `session.cancelShellWait`; `setEffort` → `session.effort`; `setBackend`
     → `session.model` with an option from the peer's `models.list`;
     `stopSubtask`/background stop → `session.stopBackground`; `fork` →
     `session.fork`; rename → `session.rename`; close → `session.close`;
     delete → `session.delete`. A `/name` message goes as text, as the web
     page sends it; a `{handled:true}` answer shows its `note` as a
     transcript note, or opens the new session `id` it returns.
   - `capabilities`: `git`, `helpers`, `specialists`, `detachWindow`,
     `openInShell`, `openInEditor`, `localFiles` all `false`.
   - Errors from ops become `lastError` on the view (shown where local
     errors are), and `offline` makes the composer read "desk-pc is offline."
2. `CodeSidebar`: below local sessions, for each peer from the phase 07
   store with `listedSessions(peer)` non-empty or status `open`: heading
   **On <name>**, then rows sorted as local rows are (open first, then
   `updatedAt`, list order where it's null). Greyed rows when offline; clicking one shows a toast
   "<name> is offline." The model picker in a remote session lists the
   peer's `models.list`, never this computer's.
3. Opening a row: create (or reuse) a `RemoteCodeSession`,
   `registerOpenView`, `setActiveSession`. `getOpenSessions()` never sees
   it (phase 08). It appears in the tab strip like
   any open session; closing its tab unregisters and unfollows.
4. Peer removed or disabled: its open tabs close.
5. New session on a peer: `session.new` with `root`, `worktree` and
   `wslDistro`; recent roots are the distinct `root`s of the peer's
   `sessions.list`, by `updatedAt` newest first (list order where null), at most 10. On success, open it as in
   step 3.
6. Copy follows CLAUDE.md: section headings and the badge are the only new
   text, plus the "Where" label; explanations in `title`.

## Build gate

- `npm run check && npm run lint && npm run test`
- `npm run format:check`

## Test plan

- `remoteCodeSession.svelte.test.ts` with a fake `EngineClient`: snapshot →
  getters; each action sends the right op with the right ids; images upload
  then send hashes; `{handled:true, note}` becomes a note; offline sets the
  composer message; capabilities all off.
- `CodeSidebar` test: two peers, one offline → two sections, offline rows
  greyed; a lean peer shows no section.
- `NewSessionDialog` test: choosing a peer lists its recent roots and sends
  `session.new` to that peer.
- Rust/driver check deferred to phase 13's two-instance test.

## Commit

`feat(peers): show and drive another computer's Code sessions in the Code tab`

## Rollback

Revert; with `PEERS_READY` false in release builds no user sees it anyway.
