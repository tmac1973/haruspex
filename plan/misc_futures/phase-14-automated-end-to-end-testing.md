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
| **Live** | the real app against real services: remote inference, a test mail account, ComfyUI | Proxmox VMs as self-hosted runners | nightly |

**The key piece is a scripted fake LLM.** Model output varies from run to run,
so every flow that involves the model, including tool calls, is driven by an
OpenAI-compatible server that replays scripted responses.

**Seeding the app needs no app code.** Remote inference mode
(`inferenceBackend.mode = 'remote'`) already skips the local llama-server and
the first-run wizard (`src/routes/+layout.svelte:276-280`). Settings live in
`localStorage` under `haruspex-settings` (`settings.ts:578`). So a test points
the app at the fake by seeding that blob and reloading.

**macOS:** `tauri-driver` has no WKWebView support. macOS keeps CI's compile
and unit-test job, plus a short manual checklist (step 9). Running macOS VMs on
Proxmox breaks Apple's licence unless the host is Apple hardware.

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
8. **MANUAL — the Proxmox runners.** A person does this step once; record the
   result in `docs/testing.md`.
   - **VMs:**
     - Ubuntu 24.04, 4 vCPU, 8 GB;
     - Windows 11, 4 vCPU, 8 GB, with WebView2 and VS Build Tools.
   - **On each:**
     1. install the GitHub Actions runner with the labels
        `self-hosted, haruspex-live, <os>`;
     2. take a clean snapshot;
     3. have a cron job, or Proxmox's API, roll the VM back to it after each
        nightly run.
   - **Secrets:** the live suite's variables are repository secrets, used
     only by `nightly.yml`, which runs at 03:00 local time and on demand.
     Fork PRs never run on self-hosted runners: `nightly.yml` has no
     `pull_request` trigger.
9. **`docs/testing.md`.**
   - What each layer covers, and the command to run it locally.
   - How to add a scenario: the JSON shape, and how to record one by running
     the fake in `--record` mode in front of a real server. That mode proxies
     to `--upstream`, saves the turns, and is added in step 1.
   - The macOS manual checklist, at most 10 lines: launch, chat on remote,
     generate a test image, kill the app from Activity Monitor and check that
     sd-server is gone on the next launch, Settings sections.

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
- **Manual, once:** a nightly run on the Proxmox runners completes, and the
  VM snapshot roll-back leaves the next run starting clean.

## Commit

Three commits:
- `test(e2e): a scripted fake LLM, and UI flows in Playwright with mocked IPC`
- `test(e2e): drive the real app through WebDriver on Linux and Windows`
- `test(e2e): a nightly live suite for self-hosted runners`

## Rollback

Revert the commits. Nothing in the shipped app depends on them. The `e2e`
mode import is absent from production builds, and the CI step that checks
for it goes with the revert.
