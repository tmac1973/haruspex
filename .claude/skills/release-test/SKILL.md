---
name: release-test
description: Test latest main before a release — every automated suite on Linux, the Windows PC and the Mac mini, then live passes that drive the real app against a real model — and record the results in a GitHub issue. Use when Tim asks to test main before releasing, or for a "release test" / "live test" pass.
---

# Release test

A pass over latest `main` before a release. You run it; Tim reads the issue
it leaves. Work in a git worktree, never in the checkout `tauri dev` runs from.

Ask Tim which model to drive with if he hasn't said (an OpenAI-compatible
server, usually on `compute:3000`; `curl http://compute:3000/v1/models` shows
what is loaded). The test machines are `haruspex-win` and `haruspex-mac`
(`scripts/ci-runner/README.md`); check both answer `ssh <host> echo ok`.

## 0. Set up

- Bring the worktree to `origin/main`. Note the last tag
  (`git tag --sort=-creatordate | head -1`) and list what changed since:
  `git log --format=%s <tag>..origin/main | grep -E '^(feat|fix)'`.
- Read the open issues (`gh issue list`), especially the hand-test one, and
  the last runs on main: `gh run list --branch main --limit 12`. A failing
  `Platforms` run is the first thing to look into.
- Open an issue, `Release test: <version>`, with a checklist of the stages
  below; tick boxes and add comments as you go.
- In the worktree: `npm ci`; sidecars from the main checkout with
  `cp -as <main checkout>/src-tauri/binaries/. src-tauri/binaries/`;
  `npx playwright install chromium chromium-headless-shell` if a run says the
  browser is missing.
- **A private display.** Everything below runs headless. With `Xvfb` installed
  there is nothing to do. Without it (Tim's KDE box), start a virtual KWin
  and put an `Xvfb` stand-in on `PATH` that runs a rootful Xwayland inside it:

  ```bash
  env -u DISPLAY WAYLAND_DISPLAY= kwin_wayland --virtual --no-lockscreen \
      --socket wl-hx-live --width 1400 --height 900 --exit-with-session "sleep infinity" &
  # $SCRATCH/bin/Xvfb:
  exec env WAYLAND_DISPLAY=wl-hx-live Xwayland "$1" -nolisten tcp -geometry 1400x900
  ```

  The wdio suite needs the app on that display too: run it as
  `kwin_wayland --virtual … --exit-with-session "npm run e2e:app"` with
  `DISPLAY` unset and `GDK_BACKEND=wayland`.

## 1. Automated suites

Start the remote ones first, in the background; they take 10–25 minutes.

| Where   | Command                                                                                                                | Covers                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Linux   | `npm run check`, `lint`, `format:check`, `test`; `cargo fmt --check`, `clippy --all-targets -D warnings`, `cargo test` | what CI runs                                                                                           |
| Linux   | `CI=1 npx playwright test`                                                                                             | UI flows (screenshots run only in CI's container)                                                      |
| Linux   | `npm run e2e:app:build`, then `npm run e2e:app` on the private display                                                 | the real app, sidecars stubbed                                                                         |
| Linux   | `PATH=$SCRATCH/bin:$PATH node scripts/drive/selftest.mjs`                                                              | the driver, against the fake model                                                                     |
| Windows | `scripts/ci-runner/remote-test.sh windows unit`, then `windows e2e-app`                                                | the same, in WebView2                                                                                  |
| Mac     | `scripts/ci-runner/remote-test.sh mac unit`, then `mac smoke`                                                          | unit; the app launches and starts its model server, and after a `kill -9` a relaunch clears the orphan |

`remote-test.sh` sends the working tree as it is, uncommitted changes
included, so a fix can be tested on all three before it is pushed. The
machines run their installed copies of `scripts/ci-runner/agent/*`: after
changing one, `scp` it to `~/.haruspex-test/` on that machine.

## 2. Live passes

`scripts/drive.mjs` (docs/testing.md, "Driving the app with a real model")
runs the e2e build against the real model. Start one app for the session:

```bash
node scripts/drive.mjs start --api --base-url http://compute:3000 --model <id> \
    --out $SCRATCH/drive/live --idle-timeout 120
```

Then cover each area the release touched. What has worked:

- **Code tab:** `new-session`, then `send <id> "Fix the bug…" --wait`; a
  follow-up prompt; check the fixture's `node index.js` passes.
- **Approvals:** ask for exactly `kill -9 999999` (no such PID; harmless, and
  it matches the risk patterns). `approval`, `approve deny`, then once more
  with `approve allow`. Never ask the model for `rm` or anything destructive.
- **Steer:** `send` a turn that runs `sleep 20 …`, then `steer` mid-turn.
- **Stop:** a turn told to run `sleep 45` **in the foreground**; `cancel`, and
  check with `pgrep` the process went. Left to itself the model may run long
  commands in the background; then check the "background command finished"
  turn arrives when it ends.
- **Windows and the engine:** `detach <id>`, `send … --via engine --wait`,
  `consistent <id>`.
- **Chat:** `chat-send new "<question about a setting>" --wait`; the model
  should answer from the guide (`haruspex_docs`).
- **Web client:** `web-url`, open it in Playwright's Chromium with
  `ignoreHTTPSErrors`, save `storageState`, send from a session, answer a
  prompt there. Collect `pageerror` and console errors.
- **MCP:** `fake-mcp`, ask Chat to call `mcp__fake__unannotated_thing`, allow
  it (from the web page, or `answer mcp '{"choice":"allow_once"}'`).
- **Skills:** a session in a throwaway git repo, `send <id> "/init "` (the
  trailing space: a bare `/init` + Enter only completes the menu), answer the
  `agentsMd` prompt with `answer skill '{"action":"save","text":…}'`.
- **Worktree session:** Code → **New session** on that repo; the **Work in a
  new worktree** box appears a moment after the dialog opens.
- **Jobs:** `click "button=Jobs"`, `click "button=+ New"`, `fill` the name
  and step fields, `click "button=Save"`, `click '[title^="Run now"]'`, then
  `screenshot`.
- **Windows:** copy `remote-drive.ps1` from this folder to the repo root as
  `.remote-drive.ps1`, set the model in it, run
  `scripts/ci-runner/remote-test.sh windows drive`, then
  `scp -r haruspex-win:.haruspex-test/drive-out/* …` and read the transcripts.
  Delete `.remote-drive.ps1` afterwards; it is not committed. It covers a
  Windows folder (PowerShell) and a folder in the WSL distro.

Read every transcript and `debug.log`, not just the summary line. Judge the
**app**, not the model: a model that refuses a test codeword, or answers from
memory instead of calling a tool, is not a bug. A prompt that never appears,
a turn that never ends, a wrong path, a stale UI, or an error in the log is.

What the driver returns: `send --wait` gives `no-turn` (with the pane's
note) for a slash command that starts no turn, and `prompt` or `approval`
when a turn waits on someone, as `chat-send --wait` does for its prompts.
`click`, `fill` and `select` act on the one match on screen; when several
show (each message's **Fork from here**), pick with `--nth N` or `--nth last`.
A modal (an approval, the fork dialog) covers everything else: answer or
cancel it before clicking on.

## 3. Packaging

`npm run tauri build` on Linux with the real sidecars: check the deb, rpm and
AppImage are made and list `/usr/bin/haruspex-*` (`dpkg -c`, `rpm -qlp`).
Installers for Windows and macOS are built by the Release workflow from the
tag; they can't be checked before it.

## 4. Report

- Fix what you can in a PR (CI-only failures, harness bugs). Ask before
  committing or pushing.
- A comment on the release-test issue: a table of stages with pass/fail and
  evidence, the bugs found (filed as issues, or fixed in the PR), and what
  still needs Tim — at least: the Mac UI, screen capture, voice, image
  generation on his ComfyUI, mail and calendar, local inference on a real
  GPU, and anything left in the hand-test issue.
