---
title: Remote control from a script
description: Drive Code sessions, chats, jobs and settings from a script through Remote control's HTTP API, what each operation needs, and what stays off limits.
---

# Remote control from a script

Remote control (see the `remote-control` page) also takes requests from a script. It is the same API the web page uses, so turns still run on this computer.

## Connect

Send the token as `Authorization: Bearer <token>`, and trust the certificate: save it with **Copy certificate** in Settings → Remote control → Advanced and pass it, for example `curl --cacert haruspex.pem`. From a trusted computer, send `X-Haruspex: 1` instead of a token.

- `POST /api/v1/op` with an operation as JSON. The answer is `{"value": …}`, or an error message.
- `GET /api/v1/events` streams what sessions, chats and job runs do (server-sent events).
- `POST /api/v1/images` with `{"urls":[…]}` says which image URLs in the messages this computer has cached; `GET /api/v1/image/<hash>` returns one.
- `GET /api/v1/health` needs no token.

## Code sessions and chats

`{"type":"sessions.list"}`, `session.new` (`root`, and on Windows a `wslDistro` with a Linux `root`; `wsl.distros` lists them), `session.send` (`id`, `text`), `session.get`, `session.stop`, `session.compact`. Chats: `chats.list`, `chat.new`, `chat.send`, `chat.get`, `chat.stop`, `chat.continue`, `chat.retry`. Prompts waiting on you: `prompts.list` and `prompts.answer`.

## Jobs

- `jobs.types`: each job type, whether it can run on this computer, and its default settings.
- `jobs.list`, `jobs.get` (`jobId`).
- `jobs.create`: `job` with `name` and `job_type` (and `working_dir`, `description`, a model), `steps` as prompts, `config` laid over the type's defaults, and a `schedule` such as `{"kind":"daily","time":"09:00"}`. It is checked as the Jobs tab checks a save.
- `jobs.update` (`jobId`): changes only what it names; `steps`, when given, replaces them all. `jobs.duplicate`, `jobs.delete`.
- `jobs.run` (`jobId`): runs now, or queues behind the run in progress. It answers with the `runId`.
- `run.cancel` (`runId`): stops the run, or takes a queued one out.
- `runs.list` (`jobId`), `runs.get` (`runId`; the run in progress also carries its text, reasoning and tool steps), `runs.current` (the run and the queue), `runs.delete`.

Events: `job-run` when a run's status or steps change, `job-run-live` with the running step's text, and `job-queue`. A guided-planning or asset job's question shows in `prompts.list` with its `runId`.

## Settings

- `settings.get`: every setting, or `keys` for a few. Secrets come back blank, and `redacted` lists where.
- `settings.patch` with `patch`: objects merge key by key, so `{"patch":{"inferenceBackend":{"mode":"remote"}}}` keeps the rest of `inferenceBackend`. A misspelt name or a value of the wrong type is refused.

A patch can't set a secret, the API keys, Settings → Integrations (accounts and MCP servers), Settings → Remote control or Settings → Guest chat. Change those on this computer. Most changes apply at the next turn; one that Settings applies by starting something, such as the model server or the bundled image engine, isn't started by a patch.

## What each permission allows

- **Read**: list, read and follow everything above, and `jobs.types`.
- **Drive**: start, send, steer and stop sessions and chats; run, cancel and delete jobs and runs; duplicate a job.
- **Approve**: answer prompts, and `jobs.create` and `jobs.update`. A job's tools run without asking, so writing one approves its commands ahead.
- **Settings**: `settings.get` and `settings.patch`. A new device doesn't get it unless you tick it; a trusted computer has it.

## What it doesn't do

- No Shell tab, Images, Music or Video tabs, and no MCP servers.
- Messages can't carry pictures or start a skill with `/name`.
- No debug log, and no inference queue.
