# Phase 13 — Two-instance test, user guide, switch on

**Depends on:** 01–12 · **Enables:** the release

## Goal

Prove the whole flow with two real app instances, write the user guide page,
and remove the build flag so **Settings → Remote control → Show my other
computers here** appears in release builds.

## Files touched

- `scripts/drive.mjs`, `scripts/drive/app.mjs`, `scripts/drive/control.mjs`
  — `--instance <name>`: its own data and config dirs, control socket and
  owner API port (8788 + n), so two drivers run side by side.
- `scripts/drive/peers-check.mjs` — new: the two-instance scenario below,
  run as `npm run drive -- peers-check`.
- `src/lib/peers/flag.ts` — deleted; every `PEERS_READY` use removed.
- `docs/guide/other-computers.md` — new page, under 6 KB, `title` and
  `description` frontmatter.
- `docs/guide/remote-control.md` — one line pointing at `other-computers`.
  The page is 5,977 bytes against the 6,000 limit
  (`src/lib/guide/pages.test.ts`), so first drop its "Use it from a script"
  section, which only points at `remote-control-api` (the same pointer
  stays in its opening sentence), to make room.
- `docs/testing.md` — the `--instance` option.

## Steps

1. Driver `--instance a|b` (Linux): the app identifier is fixed at build
   time, so instance b gets its own `XDG_DATA_HOME` and `XDG_CONFIG_HOME`
   under the driver's temp dir rather than a second identifier; socket
   `drive-<name>.sock`; owner port 8788 + index. Both run with
   `inferenceBackend.mode: "remote"` against the fake LLM, speech and image
   generation off, so neither starts a sidecar and ports 8765–8767 never
   collide; the script checks that with `ss -ltn` once both are up. The
   default instance is unchanged.
2. Scenario (fake LLM from `e2e/fake-llm/server.mjs`, scripted to ask for
   one shell command):
   - A: Remote control on, Who can connect → My whole network.
   - B: the script reads A's fingerprint from A's
     `<app_data_dir>/owner-tls.json` and A's instance id from its health,
     then writes `peersEnabled: true` and the peer `{instanceId, name,
     address: "127.0.0.1", port, fingerprint, auth: "trusted"}` with the
     driver's `settings` command.
   - B lists A's sessions under **On <A>**; B starts a session on A in
     `e2e/fixtures/average-bug`; sends a prompt; the turn's command prompt
     opens B's command modal with "On <A>"; B approves; the turn finishes on
     A; `consistent` on A agrees with what B's mirror shows.
   - B opens A's chat, sends, sees the answer stream.
   - Stop A: B's section shows the titles greyed and offline; start A: B
     reconnects without restart.
   - Change A's certificate (delete A's `<app_data_dir>/owner-tls.json`, restart A): B shows
     "Certificate changed" and sends nothing until trusted again.
3. mDNS is covered by phase 04's tests and the hand check below, not this
   scenario (loopback multicast varies on CI runners).
4. Guide page `other-computers`: headings by task — "Turn it on", "Add a
   computer that isn't found", "Check the certificate", "When the other
   computer needs a token", "What you can do", "When it's offline", "What it
   doesn't do" (no copying; turns run there; no Shell, Jobs, Settings, Home;
   files read-only; not through a third computer). It says a tailnet
   computer needs **These computers** or a token, since **My whole network**
   covers LAN addresses only, and that "Certificate changed" is expected
   near expiry and after a name change. Settings paths in full.
   Compact tables, no Prettier on the page.
5. Remove `flag.ts`; `applyPeers` uses `peersEnabled` alone.
6. `node scripts/guide-check.mjs < /dev/null` passes.
7. File a GitHub issue with the owner's hand tests (below) as a checklist,
   per CLAUDE.md, unless they were done in this PR.

## Build gate

- `npm run check && npm run lint && npm run test && npm run format:check`
- `cd src-tauri && cargo fmt -- --check && cargo clippy --all-targets -- -D warnings && cargo test`
- `npm run drive -- peers-check` passes locally after
  `npm run e2e:app:build`; its output goes in the PR body
- `node scripts/guide-check.mjs < /dev/null`

## Test plan

- The scenario above, automated.
- Hand, on two real computers (Linux + one of mac/Windows): found by mDNS
  within 10 s; add by Tailscale name; token mode with a pasted token; a
  notification for a waiting prompt while the window is in the background;
  `tcpdump udp port 5353` silent with the switch and Remote control off.

## Commit

`feat(peers): use your other computers' sessions and chats from this one (#1081)`

## Rollback

Restore `flag.ts` with `PEERS_READY = false` to hide the feature again; the
guide page goes with it. Data written (settings keys, `peer_lists`, keyring
tokens) is inert while hidden.

## As built

- `peers-check` runs both apps in one process (`App` with `instance: 'a'|'b'`)
  rather than two `drive start` daemons: one cleanup for both, and B can read
  A's fingerprint from A's own certificate (`X509Certificate.fingerprint256`,
  the same `AA:BB:…` as `owner/tls.rs`) instead of `owner-tls.json`.
  `App.close()` stops one instance; `start({ keep: true })` restarts it on its
  data, at the same owner API port.
- B acts through drive hooks (`setPeers`, `peerStartSession`, `peerSend`,
  `peerOpenChat`, `peerChatSend`, `peerStatus`…) that call what the UI calls,
  and the check reads B's window for the **On <A>** section, the dialog's
  origin label and the offline marker; it clicks **Allow once** itself.
- The certificate step checks B reports `certificateChanged`; that nothing is
  then sent follows from phase 03's manager, which stops the stream.
- `getting-started.md` is at its 6 KB limit, so it isn't given a line for the
  new page; `remote-control.md`'s opening sentence points at it.
- Hand tests and the markdown-pictures follow-up: #1106.
