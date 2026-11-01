---
title: Remote control from a script
description: Drive Code sessions, chats, jobs and settings from a script through Remote control's HTTP API, what each operation needs, and what stays off limits.
---

# Remote control from a script

Remote control (see the `remote-control` page) also takes requests from a script, through the web page's API. Turns run on this computer.

## Connect

Send the token as `Authorization: Bearer <token>`, and trust the certificate: save it with **Copy certificate** in Settings → Remote control → Advanced and pass it, for example `curl --cacert haruspex.pem`. From a trusted computer, send `X-Haruspex: 1` instead of a token.

- `POST /api/v1/op` with an operation as JSON. The answer is `{"value": …}`, or an error message.
- `GET /api/v1/events` streams what sessions, chats and job runs do.
- `POST /api/v1/upload` with a picture as the body (PNG, JPEG, WebP or GIF, up to 16 MB) answers its `hash`. Needs **Drive**.
- `POST /api/v1/images` with `{"urls":[…]}` says which image URLs this computer has cached; `GET /api/v1/image/<hash>` returns one.
- `GET /api/v1/health` needs no token.

## Code sessions and chats

`{"type":"sessions.list"}`, `session.new` (`root`, and on Windows a `wslDistro` with a Linux `root`; `wsl.distros` lists them), `session.send` (`id`, `text`), `session.get`, `session.stop`, `session.compact`. Chats: `chats.list`, `chat.new`, `chat.send`, `chat.get`, `chat.stop`, `chat.continue`, `chat.retry`. Prompts waiting on you: `prompts.list` and `prompts.answer`.

A session's controls, as the Code tab has them: `session.close` (stops its turn and background processes; it stays saved), `session.delete` (a worktree it works in stays), `session.fork` (`index` of a message; `mode` `worktree` for a worktree of its own), `session.rename`, `session.effort` (`low` to `xhigh`, or null for Settings), `session.model` (`{baseUrl, modelId, apiKeyId}`, or null for Settings) and `session.stopBackground` (`processId`). A chat's: `chat.delete`, `chat.rename`, `chat.memory` (`enabled`), and `chat.folder` (`path` or null; `id`, else the open chat), a chat's working folder.

Models: `models.list` names Settings → Inference's model, the saved remote options and the API keys; `models.probe` (`baseUrl`, `apiKeyId`) lists a server's models. Keys go by id, never by value.

`session.send` and `chat.send` take `images`, a list of up to 8 hashes from `/api/v1/upload`; a message can be pictures alone. A message starting with `/name` runs as it does in the input box: a skill goes with the message, and a built-in such as `/skills` or `/new` answers `{"handled":true}` with its `note` or the new `id` instead of sending anything. Mid-turn, a send steers and a `/name` is just text.

## Jobs

- `jobs.types`: each job type, whether it can run here, and its defaults.
- `jobs.list`, `jobs.get` (`jobId`).
- `jobs.create`: `job` with `name` and `job_type` (and `working_dir`, `description`, a model), `steps` as prompts, `config` laid over the type's defaults, and a `schedule` such as `{"kind":"daily","time":"09:00"}`. It is checked as the Jobs tab checks a save.
- `jobs.update` (`jobId`): changes only what it names; `steps`, when given, replaces them all. `jobs.duplicate`, `jobs.delete`.
- `jobs.run` (`jobId`): runs now, or queues behind the run in progress. It answers with the `runId`.
- `run.cancel` (`runId`): stops a run, or unqueues it.
- `runs.list` (`jobId`), `runs.get` (`runId`; a running one carries its text and steps), `runs.current` (the run and the queue), `runs.delete`.

Events: `job-run` when a run's status or steps change, `job-run-live` with the running step's text, and `job-queue`. A guided-planning or asset job's question shows in `prompts.list` with its `runId`.

## Watching the app

- `debug.tail`: the debug log's newest lines (`lines`, default 200, at most 2000), or those after `since`; pass back the `next` it answers to read on. `contains` keeps only lines holding that text. `window` picks a window's log (`main` by default). Secrets and URL queries are blanked.
- `inference.queue`: who holds a model slot and who is waiting, on which lane.
- `tasks.list`: the background tasks (renders, uploads, pictures and songs made in the background), or one owner's (`chat:<id>`, `code:<id>`). `tasks.cancel` (`taskId`) stops one.

Events: `task` when a background task starts, moves on or ends.

## Settings

- `settings.get`: every setting, or `keys` for a few. Secrets and MCP args come back blank, URLs without login or query; `redacted` lists where.
- `settings.patch` with `patch`: objects merge key by key, so `{"patch":{"inferenceBackend":{"mode":"remote"}}}` keeps the rest of `inferenceBackend`. A misspelt name or a value of the wrong type is refused.

A patch can't set a secret, the API keys, Settings → Integrations (accounts and MCP servers), Settings → Remote control or Settings → Guest chat. Change those on this computer. Most changes apply at the next turn; a patch doesn't start what Settings would, such as the model server.

## Lean mode

`app.mode` (Read) answers `{"lean":true}` in lean mode, when ops that open or drive a session are refused and only research jobs can be made (see `lean-mode`).

## What each permission allows

- **Read**: list, read and follow everything above, the debug log, the queue and the tasks.
- **Drive**: start, send, steer and stop sessions and chats, and every control above; run, cancel and delete jobs and runs; duplicate a job; upload pictures; cancel a task; probe a server's models.
- **Approve**: answer prompts, and `jobs.create` and `jobs.update`. A job's tools run without asking, so writing one approves its commands.
- **Settings**: `settings.get` and `settings.patch`. Off for a new device unless you tick it, and for a computer let in without a token unless Settings → Remote control → **Let them change settings** is ticked.

## What it doesn't do

- No Shell tab, Images, Music or Video tabs, and no MCP servers.
