# Phase 14 — Automated end-to-end testing

Depends on: — (13's CI jobs exist) / Enables: every later phase's test plan

## Goal

Replace as much of the manual test pass as possible with automated runs, in
three layers. Unit and component tests (vitest, `cargo test`) already exist
and are not part of this phase.

| Layer | Drives | Where it runs | When |
| --- | --- | --- | --- |
| **UI flows** | the SvelteKit frontend in a browser, IPC mocked | GitHub Linux | every PR |
| **Real app** | the built app through WebDriver, with sidecars and IPC real and the LLM faked | GitHub Linux and Windows | every PR |
| **Live** | the real app against real services: remote inference, a test mail account, ComfyUI | the user's Mac mini and Windows PC as self-hosted runners | nightly |

**The key piece is a scripted fake LLM.** Model output varies from run to run,
so every flow that involves the model, including tool calls, is driven by an
OpenAI-compatible server that replays scripted responses.

**Seeding the app needs no app code.** Remote inference mode
(`inferenceBackend.mode = 'remote'`) already skips the local llama-server and
the first-run wizard (`src/routes/+layout.svelte:276-280`). Settings live in
`localStorage` under `haruspex-settings` (`settings.ts:578`). So a test points
the app at the fake by seeding that blob and reloading.

**macOS:** `tauri-driver` has no WKWebView support, so the Mac mini runs a
different driver: Appium's Mac2 driver, which works through the accessibility
tree. It covers fewer flows (step 8), and what it can't reach stays on a short
manual checklist (step 9).

**The user's own machines, as the user.**
- The Mac mini and the Windows PC are the user's everyday machines, so tests
  run as the user, in their session. A dedicated CI user would need its
  desktop to be the one on screen for UI tests, and has none of the user's
  credentials.
- **The test build is isolated by app identifier.** Every e2e build uses
  `tauri build --config '{"identifier":"com.haruspex.app.e2e"}'`, so its app
  data and WebView storage live apart from the user's real Haruspex.
- **A clean start** wipes only that identifier's folders.
- **A sidecar port clash** with the user's running Haruspex fails cleanly:
  phase 13 frees a port only from a process of the same install.
- **The Windows PC's integrated GPU** lets its nightly run cover local
  inference with a small model, the one thing no hosted runner can test.

## Files touched

- New `e2e/fake-llm/server.mjs`, `e2e/fake-llm/scenarios/*.json`, and
  `e2e/fake-llm/server.test.ts`.
- New `e2e/fakes/docker-compose.yml`: GreenMail (IMAP/SMTP) and Radicale
  (CalDAV).
- New `e2e/ui/`: Playwright config, `mockIpc.ts`, and specs.
- New `src/lib/e2e/installMocks.ts`, imported only in the `e2e` Vite mode.
- New `e2e/app/`: WebdriverIO config, helpers and specs.
- `package.json`: dev dependencies (`@playwright/test`, `@wdio/cli`,
  `@wdio/local-runner`, `@wdio/mocha-framework`), and the scripts `e2e:ui`,
  `e2e:app` and `e2e:live`.
- `vite.config.ts`: the `e2e` mode alias.
- `.github/workflows/ci.yml`: an `e2e-ui` job; `e2e-app` steps in a new Linux
  job and in the Windows job.
- New `e2e/mac/`: Appium Mac2 specs for the Mac mini.
- `src-tauri/Cargo.toml` and `src-tauri/src/lib.rs`: an `e2e` Cargo feature
  with the `--e2e-seed <file>` launch flag, which writes the settings blob
  before the webview loads. Never in a release build.
- New `.github/workflows/nightly.yml`: the live suite on `self-hosted`
  runners.
- New `docs/testing.md`: how to run each layer and add a scenario.

## Steps

1. **The fake LLM** (`e2e/fake-llm/server.mjs`, plain Node, no
   dependencies).
   - **Endpoints:** `GET /v1/models` (one model, `fake-model`, with a context
     length) and `POST /v1/chat/completions`, streaming (SSE) and
     non-streaming.
   - **Scenarios:** a JSON file is a list of turns, each
     `{ match: { lastUser?: regex, toolResult?: regex }, reply: { content?,
     tool_calls?: [{ name, arguments }] } }`. The server answers with the
     first turn whose `match` fits the request's last message, and with
     "(no scenario matched: <last message>)" otherwise, so a broken test
     reads plainly.
   - **Control:** the scenario is chosen per test with `POST
     /__scenario { name }`, and `GET /__requests` returns every request
     received, so a test can assert what the app sent (system prompt, tools
     offered).
   - **Ports:** `--port`, default 18765. It must never use a port from
     phase 13's sidecar list.
2. **Fake services** in `e2e/fakes/docker-compose.yml`: GreenMail (IMAP
   3143, SMTP 3025, accounts preloaded) and Radicale (5232). Used by the
   live suite and by the email specs once phases 09–11 land. Pin both
   images by digest.
3. **UI layer: mocked IPC.**
   - `src/lib/e2e/installMocks.ts` calls `mockIPC` and `mockWindows` from
     `@tauri-apps/api/mocks`, with a handler table that answers each command
     the covered flows use with fixture data. An unknown command throws,
     with its name.
   - `vite.config.ts`: in `--mode e2e` only, the app entry imports it before
     anything else. A production build must not contain it; a build-output
     grep in the CI job checks that.
   - LLM HTTP goes to the fake server, seeded through `localStorage`.
4. **UI specs** (Playwright, Chromium, `e2e/ui/`). One spec per flow:
   - **Chat:** send a message, see the scripted streamed answer; a scripted
     tool call shows its step card.
   - **Settings:** move between every section without errors (the same flow
     as `SettingsPanel.test.ts`, in a real browser); Settings → Image probe
     against a mocked backend.
   - **Jobs:** create a research job, run it, see each step and the final
     output. After phase 03 lands, browse other jobs while the run continues.
   - **Visual baselines:** screenshots of the chat, Settings and jobs pages
     at 1280×800, compared with Playwright's `toHaveScreenshot` (0.2%
     tolerance). Baselines are committed and updated with
     `npm run e2e:ui -- --update-snapshots`.
5. **Real-app layer** (WebdriverIO plus `tauri-driver`, `e2e/app/`).
   - Build with `npm run tauri build -- --debug --no-bundle`, then point
     `tauri-driver` at the binary.
   - **Linux:** `webkit2gtk-driver` under `xvfb-run`.
   - **Windows:** `msedgedriver` matching the runner's WebView2 version,
     installed by a step that reads the version from the registry.
   - **Before each spec,** a helper:
     1. starts the fake LLM;
     2. waits for the app window;
     3. seeds `haruspex-settings` with remote mode at the fake's URL (via
        `browser.execute`);
     4. reloads;
     5. waits for the remote status label.
   - **Specs:**
     - **Chat round trip:** a scripted answer arrives in the real webview.
     - **A tool call that touches disk:** a scenario calls `fs_write_text`
       in a temporary working directory, and the spec reads the file back.
     - **Settings → Image → Generate test image** against the ComfyUI fake
       from `comfy.rs`'s tests, run as a standalone binary or a small Node
       port.
     - **Phase 13's guarantee,** with a real sidecar:
       1. start a sidecar whose binary is a stub (CI's placeholder sidecar
          becomes a tiny script that listens on its port and sleeps);
       2. kill the app (`taskkill /F` or SIGKILL);
       3. assert that the sidecar's process is gone within 2 s.
6. **CI.**
   - **`e2e-ui` job** (ubuntu): installs Playwright Chromium, runs
     `npm run e2e:ui`, and uploads the HTML report and any screenshot
     diffs as artifacts on failure.
   - **`e2e-app` job** (ubuntu, with the backend job's system dependencies,
     `webkit2gtk-driver` and `xvfb`).
   - **Windows job:** gains the same `e2e:app` steps after its unit tests.
   - All of these run on every PR; failures upload the driver logs and a
     final screenshot.
7. **Live layer** (`e2e/live/`). It reuses the real-app helpers, but seeds
   real services from environment variables:
   - `HARUSPEX_LIVE_INFERENCE_URL` and `_MODEL`: one of the user's inference
     servers;
   - `HARUSPEX_LIVE_IMAP`, `_SMTP` and `_PASSWORD`: a dedicated test mailbox;
   - `HARUSPEX_LIVE_COMFY_URL`.

   Its assertions are loose:
   - a chat answer is non-empty;
   - a research job finishes `succeeded`;
   - an asset smoke job writes its files;
   - after phase 11, a reply sent to the test mailbox arrives there.

   Each spec skips with a stated reason when its variables are absent.
8. **The self-hosted runners: the Mac mini and the Windows PC.** Already
   scripted in `scripts/ci-runner/` (`setup-macos.sh`, `setup-windows.ps1`;
   see its README). The user runs one script per machine, once, from their
   own account. The same scripts install the `remote-test.sh` agent, which
   runs a suite from the user's Linux box over SSH on the working tree. The
   nightly workflow takes the agent's lock (`~/.haruspex-test/busy`) for its
   whole run, so the two never collide. What the scripts and this phase add:
   - **The runner runs as the user**, started at their login, in their
     session. Labels: `self-hosted, haruspex-live, macos | windows`, plus
     `igpu` (this Windows PC) or `gpu` on Windows.
   - **Clean start.** The nightly workflow's first step deletes the e2e
     identifier's data only:
     - macOS: `~/Library/Application Support/com.haruspex.app.e2e` and its
       WebKit storage;
     - Windows: `%APPDATA%\com.haruspex.app.e2e` and
       `%LOCALAPPDATA%\com.haruspex.app.e2e`.

     It then kills any leftover e2e build process, matched by its path, never
     by name.
   - **Unlocked session.** UI specs need the session unlocked. The workflow's
     first step checks this (macOS: `CGSSessionScreenIsLocked` from `ioreg`;
     Windows: a `LogonUI` process present) and skips the UI specs with that
     reason, rather than failing on a locked screen. The `unit` suite runs
     either way.
   - **Windows:** msedgedriver is fetched at run time to match the installed
     WebView2.
   - **macOS:** Appium's Mac2 driver needs full Xcode, and so an Apple
     account. The user has none, so it is opt-in (`setup-macos.sh
     --with-xcode`).
     - Without it, the Mac runs the `unit` suite and a process-level spec
       with no UI driver: launch the e2e build, wait for its window process,
       `kill -9` it, relaunch, and assert the orphan sweep removed the stale
       sidecar. That's phase 13's macOS path.
     - The Mac2 specs run only when `appium` is on PATH, and skip with that
       reason otherwise.
     - With Xcode, the Mac2 driver also needs the Accessibility and Screen
       Recording grants the script asks for.
   - **Mac specs** (`e2e/mac/`, WebdriverIO plus Appium Mac2) cover:
     - launch;
     - seeding remote mode: write `haruspex-settings` through a debug-only
       launch flag, `--e2e-seed <file>`, compiled only with the `e2e` Cargo
       feature;
     - a chat round trip, located by accessibility labels;
     - Settings → Image → Generate test image against ComfyUI;
     - kill the app (`kill -9`), relaunch, and assert the orphan sweep removed
       the stale sd-server. That's phase 13's macOS path.
   - **`igpu`/`gpu`-tagged Windows run:** the live suite also runs one
     local-model chat, with the smallest catalogue model downloaded once into
     the e2e identifier's models folder. A bundled-engine test image is
     `gpu`-only. On `igpu` it runs only on a manual dispatch with
     `image: true`, because Ming at 1024 on shared memory takes many minutes.
   - **Secrets:** the live suite's variables are repository secrets, used
     only by `nightly.yml`, which runs at 03:00 local time and on demand.
   - **Security, because the repo is public:**
     - `nightly.yml` has no `pull_request` trigger, and no other workflow
       uses the `haruspex-live` label;
     - the fork-PR approval policy is `all_external_contributors`. Runner
       groups don't exist for a personal-account repo, so this setting is
       what stops a PR that edits a workflow from running on the user's
       machines.
9. **`docs/testing.md`.**
   - What each layer covers, and the command to run it locally.
   - How to add a scenario: the JSON shape, and how to record one by running
     the fake in `--record` mode in front of a real server. That mode proxies
     to `--upstream`, saves the turns, and is added in step 1.
   - The macOS manual checklist: only what the Mac2 specs can't reach, at
     most 10 lines. For example, screen capture permission prompts and the
     notarised DMG install.

## Build gate

The overview's gate, plus `npm run e2e:ui` locally. `npm run e2e:app` runs
locally on Linux with `webkit2gtk-driver` installed. Any new Node scripts get
their own vitest tests: `server.test.ts` covers scenario matching, SSE framing
and `/__requests`.

## Test plan

- **Fake LLM unit tests:**
  - the first matching turn wins;
  - no match returns the readable miss;
  - a streamed reply is valid SSE ending in `[DONE]`;
  - a tool-call reply streams `tool_calls` deltas the app's parser accepts
    (feed the output through the app's own stream parser in the test);
  - `--record` writes a scenario a fresh server replays identically.
- **The specs themselves are the tests,** so each must be seen failing once:
  break the asserted behaviour locally (rename the scripted answer, kill the
  stub sidecar early) and confirm the spec fails with a readable message.
  Note it in the commit.
- **CI:** both new jobs are green on the PR that adds them; the Windows job's
  `e2e:app` steps are green.
- **Manual, once:**
  - a nightly run completes on both machines;
  - a second run starts clean (no settings or images carried over);
  - the user's own Haruspex data on those machines is untouched.

## Commit

Three commits:
- `test(e2e): a scripted fake LLM, and UI flows in Playwright with mocked IPC`
- `test(e2e): drive the real app through WebDriver on Linux and Windows`
- `test(e2e): a nightly live suite for self-hosted runners`

## Rollback

Revert the commits. Nothing in the shipped app depends on them. The `e2e`
mode import is absent from production builds, and the CI step that checks
for it goes with the revert.
