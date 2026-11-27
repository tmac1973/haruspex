# Phase 1 — The driver, landed and interactive

**Depends on:** — · **Guide:** none (`no-docs`); `docs/testing.md` changes

## Goal

Claude can start the real app once, against a real model or the fake LLM,
then over many separate commands: open Code sessions, send prompts, steer,
cancel, answer approvals, and read back the full state. Today's
`drive.mjs run` does one scripted pass and exits; that suits reproducing a
bug, but not exploring one.

## 1. Land `8fc77c0` on main

Branch `code-tab/dev-driver` predates phases 5–6b. Only `8fc77c0` is new:
`0f7ae5f` is the same change as #410, already on main.

- Cherry-pick `8fc77c0` onto a fresh branch from main. Expect conflicts in
  `src/hooks.client.ts` (main now starts the debug-log file in the non-e2e
  branch), `package.json`, `docs/testing.md`, `CodePane.svelte`.
- `driveHooks.ts` reads `s.streamingContent`, `s.searchSteps`, `s.usage`,
  `s.lastError`, `s.saveError` and `s.snapshot()`. All still exist on
  `CodeSession` (`streamingContent` now goes through `LiveTurn`); check
  `snapshot()` and `messageSteps` still have the same shape.
- `CodePane.svelte` gained `data-session-id` / `data-status` on the branch;
  main's `CodeTabStrip.svelte` has `data-status` on the strip dots only. Keep
  the pane attributes; the driver selects by them.
- Run `npm run e2e:app:build` and one `npm run drive -- run` against the fake
  LLM (`--base-url http://127.0.0.1:18765` with `code-tab.json`) and one
  against a real server to confirm it still works end to end.

## 2. `drive start` / `drive send` / `drive state` / `drive stop`

A long-lived mode. `start` launches the app and a small control server; the
other subcommands are short-lived clients of it, so each is one Bash call for
Claude.

```bash
npm run drive -- start --base-url http://compute:3000 [--folder PATH] [--show]
npm run drive -- new-session [--folder PATH]          # prints the session id
npm run drive -- send <id> "Fix the bug" [--wait] [--timeout 600]
npm run drive -- steer <id> "also add a test"
npm run drive -- cancel <id>
npm run drive -- approve <id> allow|deny              # a pending command approval
npm run drive -- state [<id>] [--transcript]          # JSON, or transcript.md text
npm run drive -- logs [--since N]                     # debug log lines
npm run drive -- screenshot [PATH]
npm run drive -- stop
```

- **Control channel:** a Unix socket (named pipe on Windows) at
  `e2e/drive-output/control.sock`, JSON lines. Not a TCP port: nothing else on
  the machine can reach it. `start` writes a pidfile; `stop` and a second
  `start` clean up a stale one.
- `start` does what `run` does up to "app ready and backend configured", then
  holds the WebDriver session open. Process cleanup (`children`, scratch dirs,
  the X server) moves to the `stop` path and to signals.
- `run` stays, rebuilt on the same pieces (start → new-session → send each
  prompt with `--wait` → write outputs → stop).
- `send` types into the composer as `run` does today (real UI path).
  `--wait` blocks until `data-status` is `idle` again and prints the summary
  (`summarize()`); without it, it returns once the turn has started.
- `state` returns what `__haruspexDrive.codeSessions()` returns.
  `--transcript` renders it with the existing `transcript()`.
- `approve` needs a hook: add `pendingApprovals()` and
  `answerApproval(id, allow)` to `driveHooks.ts`, reading and answering
  `codeCommandApproval.svelte.ts` the way the modal does. Start without
  auto-approve so approvals can be tested; keep `--auto-approve` as an option.
- `steer` and `cancel` go through the UI as well (composer while running;
  `button.stop`), so they test what the owner presses.

## 3. Fake LLM and recording from the driver

- `start --fake SCENARIO` starts `e2e/fake-llm/server.mjs` on a free port and
  points the app at it, and `scenario NAME` switches it (`POST /__scenario`).
  This gives exact, repeatable runs for checks.
- `start --record NAME --base-url URL` starts the fake in `--record` mode in
  front of the real server, so a good exploratory run becomes a scenario.

## 4. Measure background throttling

Add `drive minimise` / `drive restore` (WebDriver `minimizeWindow`, or
`xdotool windowunmap` on the private display), then time the same turn
(`--fake`, a scenario with a long streamed reply) visible vs minimised. Record
the numbers in `overview.md` under Risks. If minimised turns are throttled,
phase 2 has to address it (the likely fix is turning off WebKit's
background throttling for the main window, or keeping the turn's timers
somewhere they aren't throttled).

## 5. Docs

`docs/testing.md`, "Driving the app with a real model": the new subcommands,
the control socket, `--fake` / `--record`, and that `drive` is for developers
and agents, never shipped.

## Tests

- `node:test` unit tests for the control protocol (parse/serialise, stale
  pidfile handling) and the transcript renderer, in `scripts/drive.test.mjs`.
- One WebdriverIO spec in `e2e/app/specs/` that runs `start --fake code-tab`,
  `send --wait`, `state`, `stop` and checks the fixture file was edited. This
  keeps the driver from rotting.
- CI: the existing grep that `__haruspexDrive` is absent from production
  output (add it if only `installMocks` is grepped today).

## Done when

Claude can, in one conversation and without the owner touching anything:
start the app against the owner's inference server, run several turns in a
Code session with an approval in the middle, read the state after each, and
stop it cleanly, with no Xvfb, tauri-driver or app processes left behind.

## As built (2026-10-09)

Branch `remote-api/p01-driver`. Differences from the plan above:

- **`approve` takes no session id.** The approval modal is app-wide, one at
  a time (`codeCommandApproval.svelte.ts`), so `approve allow|allow-session|deny`
  answers whatever is pending; `approval` shows it. `send --wait` and `wait`
  return `"state": "approval"` instead of waiting it out.
- **The socket lives in `$XDG_RUNTIME_DIR`**, not `e2e/drive-output/`: a
  worktree path plus `e2e/drive-output/control.sock` came within a few bytes
  of the 108-byte Unix socket path limit. One driver per machine either way,
  since the e2e identifier's data dir is shared.
- **The end-to-end check is `scripts/drive/selftest.mjs`**, not a WebdriverIO
  spec: a spec's app and the driver's app would wipe each other's data. CI
  runs it after `npm run e2e:app`. Unit tests are `scripts/drive/drive.test.ts`.
- **`--idle-timeout`** (default 60 min) stops a forgotten driver.
- **`e2e/fake-llm` record mode** now sends `--model` and the API key upstream
  (`upstreamModel`, `upstreamKey`), so it works against servers with several
  models or a key.

**Throttling, measured:** the same 1,527-token reply from the owner's vLLM
server (ThinkingCap-3.8-27B), alternating minimised and restored on a private
Xvnc display where the page reports `document.visibilityState` `hidden` and
`visible`: 5.4 s and 5.2 s hidden, 5.2 s and 6.2 s visible. No throttling of
a streaming turn. Repeated on the owner's GNOME desktop with `--show`: 5.2–5.3 s
minimised, 5.2–5.5 s visible. No throttling there either.
