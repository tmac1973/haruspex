# Testing

Haruspex has four layers of tests. The first runs on every pull request; the
others are added by `plan/misc_futures/phase-14-automated-end-to-end-testing.md`.

| Layer              | What it drives                                                                 | Command                                    |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------ |
| Unit and component | modules and Svelte components, in jsdom; Rust in `cargo test`                  | `npm run test`, `cargo test --lib`         |
| UI flows           | the frontend in Chromium, with Tauri's IPC mocked and the model scripted       | `npm run e2e:ui`                           |
| Real app           | the built app through WebDriver, IPC and Rust real, model and sidecars stubbed | `npm run e2e:app:build`, `npm run e2e:app` |
| Live               | the real app against real services, on the test machines                       | _(phase 14, part 3)_                       |

## The fake LLM

Model output changes from run to run, so every test that involves the model
talks to `e2e/fake-llm/server.mjs` instead. It is an OpenAI-compatible server
(`/v1/models`, `/v1/chat/completions`, streaming or not) that replays a
**scenario**: a JSON list of turns in `e2e/fake-llm/scenarios/`.

```json
[
	{
		"match": { "lastUser": "write the notes file" },
		"reply": { "tool_calls": [{ "name": "fs_write_text", "arguments": { "path": "notes.txt" } }] }
	},
	{ "match": { "toolResult": "notes\\.txt" }, "reply": { "content": "I wrote notes.txt." } }
]
```

- A request gets the reply of the **first** turn whose `match` fits its last
  message. `lastUser` is a case-insensitive regex tested against a user
  message, and `toolResult` one tested against a tool result. A turn with an
  empty `match` fits anything.
- No match is not an error: the reply is `(no scenario matched: <message>)`,
  so a broken test shows what the model was asked.
- `POST /__scenario {"name": "…"}` switches scenario and forgets earlier
  requests. `GET /__requests` returns every request received, so a test can
  check what the app sent.
- It never takes a port a Haruspex sidecar uses. The default is 18765.

Run it by hand with `npm run e2e:fake-llm -- --scenario chat-hello`, and
point a dev build at `http://127.0.0.1:18765` (Settings → Inference →
Remote).

**Recording a scenario** from a real model: run the fake in front of it, use
the app, and every exchange is saved as a turn.

```bash
node e2e/fake-llm/server.mjs --record my-flow --upstream http://compute:3000/v1
```

Edit the saved `match` patterns afterwards. They are the first 80 characters
of each message, escaped, which is usually more than a test should depend
on.

## UI flows (Playwright)

`npm run e2e:ui` starts the fake LLM and a dev server in the `e2e` Vite mode
on port 1430, then runs `e2e/ui/*.spec.ts` in Chromium.

- **The IPC mocks** are `src/lib/e2e/installMocks.ts`, installed by
  `src/hooks.client.ts` in the `e2e` mode only. CI builds the app for
  production and fails if the mocks' marker string is in the output.
- **A command with no mock fails the test with its name.** When a flow starts
  calling something new, add it to the table, with an answer of the type the
  Rust command returns. The jobs tables are an in-memory database
  (`src/lib/e2e/jobsDb.ts`), so a job created in a test can be run.
- **Each test starts clean,** in remote mode pointed at the fake, with the
  startup notice dismissed (`e2e/ui/fixtures.ts`). Pass more settings with
  `test.use({ settings: { … } })`.
- **Nothing leaves the machine.** Requests to anything but localhost are
  aborted and listed in the test's annotations.
- **From a spec:** `useScenario(name)` and `llmRequests()` from the fixtures,
  and `window.__e2e.mock(cmd, value)` to change one command's answer.

**Screenshots** (`e2e/ui/visual.spec.ts`, tagged `@visual`) are compared only
inside the pinned Playwright image, because fonts and rendering differ between
machines:

```bash
npm run e2e:ui:visual                          # compare (podman or docker)
npm run e2e:ui:visual -- --update-snapshots    # after an intended change
```

Timings and token counts are masked. CI's `e2e-ui` job runs everything,
screenshots included, in the same image.

## The real app (WebdriverIO and tauri-driver)

`e2e/app/` drives the built app the way a user would, with everything real
except the model (the fake LLM) and the sidecar binaries (stubs):

```bash
npm run e2e:app:build   # debug build with the e2e identifier, stubs swapped in
npm run e2e:app         # start tauri-driver and run e2e/app/specs/*.e2e.mjs
```

- **Isolated from your Haruspex.** The build uses the identifier
  `com.haruspex.app.e2e` (`e2e/app/tauri.e2e.conf.json`), so its data,
  settings and WebView storage live in their own folders. Those folders are
  wiped before every spec file. It is built into `src-tauri/target-e2e`, so
  swapping in stub sidecars never touches the `target/` your dev app runs
  from.
- **Stub sidecars.** `e2e/sidecar-stub/main.rs` (plain `rustc`, no
  dependencies) answers every request `200 {"status":"ok"}` on the port it is
  given, and records its pid in `$E2E_STUB_PIDS`. The build copies it over
  llama-server, whisper-server, koko and sd-server.
- **Seeding:** `seed(settings)` in `e2e/app/helpers.mjs` writes the settings
  blob and restarts the app at `/`. `REMOTE` points it at the fake LLM.
  `LOCAL` is a fresh install, which with a stub `.gguf` in its models folder
  starts the stub llama-server.
- **The specs:**
  - a chat round trip;
  - a tool call writing a real file, through a research job's working
    directory (Chat's needs a native folder dialog, which WebDriver can't
    drive);
  - Settings → Image → Generate a test image, against the fake ComfyUI in
    `e2e/fakes/comfyui.mjs`;
  - phase 13's guarantee: kill the app outright, and the model server goes
    within 2 s.
- **What you need:**
  - **Linux:** `tauri-driver` (`cargo install tauri-driver --locked`) and
    `WebKitWebDriver`, which comes with webkit2gtk (on Ubuntu, the
    `webkit2gtk-driver` package). With no display, run under `xvfb-run -a`.
  - **Windows:** `tauri-driver` too, and an `msedgedriver` that matches the
    installed WebView2. `cargo install --git
https://github.com/chippers/msedgedriver-tool` fetches one; point
    `MSEDGEDRIVER` at it.
  - **macOS** has no WebDriver for WKWebView, so this layer doesn't run
    there.
- **On the test machines:** `scripts/ci-runner/remote-test.sh windows
e2e-app` runs it on the Windows PC, in your desktop session.
- **Where it runs:**
  - **Linux:** CI's `e2e-app` job, on every PR.
  - **Windows:** the self-hosted test PC. On GitHub's hosted Windows
    runner, WebView2 never opens the debugging port msedgedriver waits for,
    although the same build passes on a desktop machine.
- **Failures** leave a screenshot in `e2e/app/output/`, which CI uploads.

**A new spec must be seen failing once.** Break what it asserts — rename the
scripted answer, say — and check the failure says plainly what is wrong.

## The Code tab inside WSL (Windows)

On Windows the Code tab works inside a WSL2 distro (`code_tools/wsl.rs`, and
`plan/code-tab/phase-10-windows-wsl.md`). GitHub's hosted Windows runners have
no distro, so the tests that need one are `#[ignore]`d and run by hand on a
Windows machine with one (git installed inside it):

```bash
cargo test --lib -- --ignored wsl distro
```

They cover resolving a folder in the distro, commands and their Stop and
timeout (the whole Linux process group), background processes and the
launch sweep, files through the `\\wsl.localhost` share with symlinks in and
out of the project, search, git and worktrees in the distro, and the
editor's polling. They leave nothing behind in the distro.

Run them from a cold distro too (`wsl --shutdown` first): that is where the
worst bug hid. **Never kill a `wsl.exe`** the app started: terminating one
while its distro boots, with another starting beside it, left the WSL service
failing every call (`Wsl/Service/E_UNEXPECTED`) until `wsl --shutdown`. Stop
the Linux process group instead (`wsl::GroupState`).

## Driving the app with a real model

`scripts/drive.mjs` runs the same e2e build through tauri-driver, but against
a real OpenAI-compatible server (or the fake LLM), to reproduce and explore
what an agent does in the Code tab. It is a tool for a developer (or an agent)
to run by hand, not a test.

```bash
npm run e2e:app:build    # once, and after any frontend or Rust change
```

**One pass:** start, open one session, send each prompt once the last turn
ends, save the results, stop.

```bash
npm run drive -- run --base-url http://compute:3000 \
	--prompt "Fix the bug in the project and run it to check." \
	[--prompt "a follow-up"] [--model ID] [--api-key-env NAME] [--folder PATH] \
	[--timeout 600] [--verbose-payloads] [--no-auto-approve] [--show]
```

**Step by step:** `start` leaves the app running in a background process, and
each other command is one short call to it, which prints JSON.

```bash
npm run drive -- start --base-url http://compute:3000    # or --fake code-tab
npm run drive -- new-session [--folder PATH]             # prints the session id
npm run drive -- send <id> "Fix the bug" --wait          # returns when the turn ends or needs someone
npm run drive -- approval                                # the command waiting for approval
npm run drive -- approve allow|allow-session|deny        # presses the modal's button
npm run drive -- wait <id>                               # carry on waiting
npm run drive -- steer <id> "also add a test"            # while a turn runs
npm run drive -- cancel <id>                             # presses Stop
npm run drive -- state [<id>] [--transcript]
npm run drive -- logs --since 0                          # agent debug log; "next" is the next --since
npm run drive -- screenshot | minimise | restore | status
npm run drive -- stop                                    # saves the results, stops everything
```

**Through the engine** (`src/lib/engine/`, the surface the owner API will
expose): `send`, `steer`, `cancel` and `approve` take `--via engine` to send
the operation through Rust instead of pressing the UI. It's the only way to
reach a session in a detached window.

```bash
npm run drive -- detach <id>                             # the tab's ⤢: the session moves to its own window
npm run drive -- send <id> "..." --via engine --wait
npm run drive -- approve deny --via engine               # prompts.answer, in whichever window shows it
npm run drive -- events [--since N]                      # engine events from every window
npm run drive -- consistent <id>                         # do the events rebuild what session.get says?
```

**Through the owner API:** `start --api` turns Settings → Remote control on
(this computer only, a free port), adds a device, and sends every engine
operation over HTTP (`POST /api/v1/op`) from then on: `--via engine`,
`approve --via engine`, `state`, `status`. `api-events [--seconds N]` reads
`GET /api/v1/events` for N seconds. `web-url` prints a one-time link that opens the web
client (`src/web/`) as a new device, for checking it by hand or with a browser.

`consistent` must hold for an idle session. While a turn streams, the replay
trails by a few tens of milliseconds, so `differs` listing only
`streamingContent` or `roundText` then is lag, not a bug.

- **Isolated as the specs are:** it wipes the e2e identifier's data first,
  never starts a local model server, and uses tauri-driver ports of its own.
  So only one driver runs per machine, and not alongside `npm run e2e:app`.
- **The backend** is what Settings → Inference → Test connection would save:
  the app's own probe of `--base-url`, with `--model` or the first model
  `/v1/models` lists.
- **`--fake SCENARIO`** points the app at `e2e/fake-llm` instead, and
  `scenario NAME` switches scenario; `requests` shows what the app sent.
  **`--record NAME`** puts the fake in front of `--base-url` and saves each
  exchange to `e2e/fake-llm/scenarios/NAME.json`.
- **The folder** defaults to a fresh temp copy of `e2e/fixtures/average-bug`
  (`index.js` fails until the loop in `stats.js` is fixed). The copy is kept,
  so you can look at what the model changed.
- **Headless by default,** on a private X server (Xvfb, or TigerVNC's Xvnc with
  no network port). `--show` opens the window on your desktop.
- **Settings → Code → auto-approve** is on for `run`, so risky commands don't
  wait for a click nobody will make, and off for `start`, so approvals can be
  driven. `--auto-approve` / `--no-auto-approve` choose.
- **`send --wait` and `wait` return early** with `"state": "approval"` or
  `"waiting-shell"` when the turn needs a person, and with `"timeout"` (exit
  code 3) after `--timeout` seconds; the turn keeps running.
- **Everything a user presses is pressed in the UI:** messages are typed into
  the session's input box, approvals and Stop are clicked.
- **The control channel** is a Unix socket, `$XDG_RUNTIME_DIR/haruspex-drive.sock`,
  never a TCP port. A started driver stops itself after `--idle-timeout`
  minutes (default 60) with no commands and no turn running.
- **Results** go to `e2e/drive-output/<timestamp>/` (gitignored):
  `transcript-<id>.md` (messages, reasoning, tool calls and results, diffs)
  and `session-<id>.json` for each session, `debug.log` (the agent debug log,
  `src/lib/debug-log.ts`), `screenshot.png`, `tauri-driver.log`, and for
  `start`, `driver.log`.
- `node scripts/drive/selftest.mjs` drives the driver against the fake model;
  CI runs it after the real-app specs.

The page side is `src/lib/e2e/driveHooks.ts`, on `window.__haruspexDrive`.
Only a build with `VITE_HARUSPEX_E2E=1`, which `e2e/app/build.mjs` sets,
carries it; CI checks the production build has none of it.
