---
title: Remote control from a script
description: Drive Code sessions, chats, jobs and settings from a script through Remote control's HTTP API: the operations, their permissions and limits.
---

# Remote control from a script

Remote control (see `remote-control`) also takes requests from a script. Turns run on this computer.

## Connect

Send the token as `Authorization: Bearer <token>`, and trust the certificate: save it with **Copy certificate** in Settings → Remote control → Advanced and pass it, e.g. `curl --cacert haruspex.pem`. From a trusted computer, send `X-Haruspex: 1` instead of a token.

- `POST /api/v1/op` with an operation as JSON. The answer is `{"value": …}`, or an error message.
- `GET /api/v1/events` streams the events named below.
- `POST /api/v1/upload` with a picture as the body (PNG, JPEG, WebP or GIF, up to 16 MB) answers its `hash`. Needs **Drive**.
- `POST /api/v1/images` with `{"urls":[…]}` says which of them this computer has cached; `GET /api/v1/image/<hash>` returns one.
- `GET /api/v1/health` needs no token.

## Code sessions and chats

`{"type":"sessions.list"}`, `session.new` (`root`, and on Windows a `wslDistro` with a Linux `root`; `wsl.distros` lists them), `session.send` (`id`, `text`), `session.get`, `session.stop`, `session.compact`. Chats: `chats.list`, `chats.search` (`query`), `chat.new`, `chat.send`, `chat.get`, `chat.stop`, `chat.continue`, `chat.retry`. Prompts waiting on you: `prompts.list` and `prompts.answer`.

A session's controls: `session.close` (stops its turn and processes; stays saved), `session.delete` (its worktree stays), `session.fork` (`index` of a message; `mode` `worktree` for its own worktree), `session.rewind` (`index`; cuts it back there in place, putting files back unless `restoreFiles` is false; `overwrite` names changed ones to restore too; `dryRun` lists them), `session.rename`, `session.effort` (`low` to `xhigh`, or null for Settings), `session.model` (`{baseUrl, modelId, apiKeyId}` or null) and `session.stopBackground` (`processId`). A chat's: `chat.delete`, `chat.rename`, `chat.memory` (`enabled`), `chat.folder` (`path` or null; `id`, else the open chat) and `chat.rewind` (`keep`: messages that stay; then `chat.send` or `chat.retry`).

Models: `models.list` names Settings → Inference's model, the saved remote options and the API keys; `models.probe` (`baseUrl`, `apiKeyId`) lists a server's models. Keys go by id, never by value.

`session.send` and `chat.send` take `images`, a list of up to 8 hashes from `/api/v1/upload`; a message can be pictures alone. A message starting with `/name` runs as it does in the input box: a skill goes with the message, and a built-in such as `/new` answers `{"handled":true}` with its `note` or new `id`, sending nothing. Mid-turn, a send steers and a `/name` is just text.

## Jobs

- `jobs.types`: each job type, whether it can run here, and its defaults.
- `jobs.list`, `jobs.get` (`jobId`).
- `jobs.create`: `job` with `name` and `job_type` (and `working_dir`, `description`, a model), `steps` as prompts, `config` laid over the type's defaults, and a `schedule` such as `{"kind":"daily","time":"09:00"}`.
- `jobs.update` (`jobId`): changes only what it names; `steps`, when given, replaces them all. `jobs.duplicate`, `jobs.delete`.
- `jobs.run` (`jobId`): runs now, or queues until its model is free, answering its `runId`.
- `run.cancel` (`runId`): stops a run, or unqueues it.
- `runs.list` (`jobId`), `runs.get` (`runId`; a running one carries its text and steps), `runs.current` (the run in view and the queue), `runs.delete`.

Events: `job-run` when a run's status or steps change, `job-run-live` with the step's text, and `job-queue`. A guided-planning or asset job's question shows in `prompts.list` with its `runId`.

## Watching the app

- `debug.tail`: the debug log's newest lines (`lines`, default 200, at most 2000), or those after `since`, the `next` it answered. `contains` filters them. `window` picks a window's log (`main` by default). Secrets and URL queries are blanked.
- `inference.queue`: who holds a model slot and who is waiting, on which lane.
- `tasks.list`: the background tasks, or one owner's (`chat:<id>`, `code:<id>`). `tasks.cancel` (`taskId`) stops one.
- `home.cards`: Home's cards in order, each with `title`, `size` and `payload`.

Events: `task` when a background task changes; `home-card` (`cardId`) when a card changes. A card's job run sends `job-run`.

## Settings

- `settings.get`: every setting, or `keys` for a few. Secrets and MCP args come back blank, URLs without login or query (`redacted` lists them).
- `settings.patch` with `patch`: objects merge key by key, so `{"patch":{"inferenceBackend":{"mode":"remote"}}}` keeps the rest of `inferenceBackend`. Misspelt names and wrong types are refused.

A patch can't set a secret, the API keys, Settings → Integrations (accounts), Settings → MCP servers, Settings → Remote control or Settings → Guest chat. Most changes apply at the next turn. A patch doesn't start the model server, but probes an added image or video model.

## Lean mode

`app.mode` (Read) answers `{"lean":true}` in lean mode, when ops that open or drive a session are refused and only research jobs can be made (see `lean-mode`).

## What each permission allows

- **Read**: list, read and follow everything above.
- **Drive**: start, send, steer and stop sessions and chats, and every control above; run, cancel and delete jobs and runs; duplicate a job; upload pictures; cancel a task; probe a server's models.
- **Approve**: answer prompts, and `jobs.create` and `jobs.update`. A job's tools run without asking, so writing one approves its commands.
- **Settings**: `settings.get` and `settings.patch`. Off for a new device unless you tick it, and for a computer let in without a token unless Settings → Remote control → **Let them change settings** is ticked.

## What it doesn't do

- No Shell tab, Images, Music or Video tabs, and no MCP servers.
