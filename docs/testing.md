# Testing

Haruspex has four layers of tests. The first runs on every pull request; the
others are added by `plan/misc_futures/phase-14-automated-end-to-end-testing.md`.

| Layer | What it drives | Command |
| --- | --- | --- |
| Unit and component | modules and Svelte components, in jsdom; Rust in `cargo test` | `npm run test`, `cargo test --lib` |
| UI flows | the frontend in Chromium, with Tauri's IPC mocked and the model scripted | `npm run e2e:ui` |
| Real app | the built app through WebDriver, IPC real, model scripted | *(phase 14, part 2)* |
| Live | the real app against real services, on the test machines | *(phase 14, part 3)* |

## The fake LLM

Model output changes from run to run, so every test that involves the model
talks to `e2e/fake-llm/server.mjs` instead. It is an OpenAI-compatible server
(`/v1/models`, `/v1/chat/completions`, streaming or not) that replays a
**scenario**: a JSON list of turns in `e2e/fake-llm/scenarios/`.

```json
[
	{ "match": { "lastUser": "write the notes file" },
	  "reply": { "tool_calls": [{ "name": "fs_write_text", "arguments": { "path": "notes.txt" } }] } },
	{ "match": { "toolResult": "notes\\.txt" },
	  "reply": { "content": "I wrote notes.txt." } }
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

**A new spec must be seen failing once.** Break what it asserts — rename the
scripted answer, say — and check the failure says plainly what is wrong.
