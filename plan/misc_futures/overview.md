# Misc futures

The open items in `plan/futures.md` as of 2026-10-03, each planned as a phase.
They are mostly unrelated. Phases are ordered so the small, standalone ones
come first and each bigger feature's foundation comes before the feature.

## Problem

Three kinds of item:

**Rough edges found by the image-generation chain runs (2026-10-02):**
- The job list locks while a run is live.
- The outline approval is a wall of heading-sized text.
- A chained coding job is called "<job> — assets — coding".
- A chain can't plan with one model and code with another.
- A coding run reached outside its project: it read Haruspex's database and
  called the user's ComfyUI.
- Cancelling on a shared ComfyUI stops other people's jobs.
- A small object drawn touching a sprite gets cut out as part of it.

**Two new capabilities:**
- **Image generation as a tool.** Chat draws pictures inline, and the Shell
  assistant in code mode makes art for the project it is working on.
- **Email that can send.** The model drafts a reply or a new message. Nothing
  is sent until the user has reviewed it and clicked Send.

**A resource leak found on 2026-10-03:** the image engine and koko outlive
the app when it isn't quit cleanly. One held 9 GB of VRAM for hours.

**One long-standing performance item:** the context audit across job types,
and a lighter verification mode for guided planning.

## What reading the code found

- **Email** (`src-tauri/src/integrations/email/`) is read-only and costly:
  - every call opens a new TLS connection;
  - `list_recent` fetches each message whole (`BODY.PEEK[]`, attachments
    included) just to build a 240-character snippet;
  - nothing has a timeout, and the model's calls can't be cancelled;
  - `hours` is rounded to whole days, and error placeholders sort last and
    can be trimmed away;
  - HTML-to-text keeps `<style>` contents and loses paragraphs.

  Sending is half-built: `lettre` is a dependency and `EmailAccount` has SMTP
  fields and `sendEnabled`, but `send_message` always returns an error.
  Passwords are plain text in the settings blob, as are all API keys.
- **Generated images in chat** can use the existing image cache
  (`image_store_bytes` and the `haruspex-img` scheme), but have two gaps:
  - nothing links the image to its conversation, so the startup sweep
    deletes it;
  - the reload lookup is by `source_url`, which a generated image doesn't
    have in the message text.
- **The Shell assistant has no binary writer** for absolute paths, and
  `runShellTurn` drops tool progress.
- **The image engine and llama-server share one GPU** with no coordination.
- **A coding run's file tools are confined** to the working directory. Its
  `run_command` isn't: `classifyShellRisk` matches command shapes (sudo,
  `rm -rf`) but not targets, so `sqlite3 ~/.local/share/...` and
  `curl 127.0.0.1:8188` both pass.

## Goals

1. Each item in `futures.md` above is either done or consciously dropped.
2. **Image generation as a tool.** When Settings → Image has a backend, Chat
   can make an image that shows inline and survives a reload. The Shell
   assistant in code mode can make a sprite, icon or texture into a file in
   its working directory, normalised the way the asset job does it.
3. **Email that sends.** With a per-account "Allow sending" toggle, the model
   can draft a reply (threaded correctly) or a new message.
   - Every draft is shown to the user, who can edit it, and only the user's
     click sends it.
   - An unattended job can never send.
4. **Email that is cheap and robust.** A list call fetches only headers and a
   short preview, every network call has a timeout, and the model's calls can
   be cancelled.
5. **Email passwords leave the settings blob** for the OS keychain, through a
   secret store other secrets can move onto later.
6. **An unattended coding run is refused** when it tries to touch the app's
   data, Haruspex's own source, or Haruspex's local services, and it is told
   why.
7. **No sidecar outlives the app,** however the app ends, and a port is only
   ever freed from a process that is ours.
8. **Most of the manual test pass is automated:** UI flows and the real app
   run on every PR against a scripted fake LLM, and a nightly live suite runs
   on the user's Mac mini and Windows PC as self-hosted runners.

## Non-goals

- **An OS sandbox for coding runs** (bubblewrap, landlock). The denylist is a
  fence against accidents, not against a model trying to escape.
- **Moving API keys to the keychain.** Phase 10 builds the store, and moving
  the keys is a new `futures.md` item.
- **Attachments, folders other than INBOX, HTML mail, and drafts saved on the
  server.** Mail is sent as plain text.
- **Swapping the LLM out of the GPU to make room for images.** When both don't
  fit, the tool fails and explains why (decision 3).
- **The Windows/macOS pass for inline chat images.** That's manual testing and
  stays in `futures.md`.

## Shape

| # | Phase | Depends on |
| --- | --- | --- |
| 01 | Chain naming and a model per chained stage | — |
| 02 | A readable outline approval | — |
| 03 | Browse the jobs tab while a run is live | — |
| 04 | A boundary for unattended coding runs | — |
| 05 | Cancel only our own ComfyUI prompt | — |
| 06 | Catch a small object cut out with a sprite | — |
| 07 | Image generation in Chat | — |
| 08 | Image generation for the Shell assistant | 07 |
| 09 | Email: cheaper, bounded, cancellable reads | — |
| 10 | A secret store; email passwords move into it | — |
| 11 | Email: compose and send, after review | 09, 10 |
| 12 | Context audit and verification lite | — |
| 13 | Sidecars die with the app | — |
| 14 | Automated end-to-end testing | — |
| 15 | Image generation on other servers: the bundled engine remote, and OpenAI-images-API servers | 07, 10 |
| 16 | Faster coding runs: a model benchmark, adaptive reasoning, builds that don't time out, a cost estimate with MVP-first, a short chained preflight, a frame smoke test for graphical projects | 12 |
| 17 | Code-drawn textures from a recipe, with tile variants; objects become sprites | — |

The phases are independent except where noted, so they can be done in any
order. 07 lays down the single-image core that 08 reuses. 11 needs 09's
connection and timeout work and 10's store.

## Decisions taken

1. **Coding-run boundary: a denylist plus a rule, not a sandbox.**
   - Unattended runs refuse commands that name the app's data directory,
     the Haruspex source tree when it's known, or our own localhost ports
     (8765–8767, plus the configured image backend's port when it is local).
   - The prompt states that the project directory is the boundary.
   - Attended runs ask instead of refusing.
2. **Email credentials move to the OS keychain** (Secret Service, Keychain,
   Credential Manager) through a new `secrets` module, and existing passwords
   are migrated on first load. If no keychain is available (a bare Linux box
   without Secret Service), the password stays in the settings blob, as
   today, and Settings → Email says so.
3. **Image tool and GPU: try, then explain.** No model swapping. A failure
   caused by memory becomes one sentence naming the cause and the ways out: a
   smaller chat model, or ComfyUI on another machine.
4. **Chat makes plain images; the Shell assistant makes assets.**
   - Chat's tool generates one image in one of three shapes (square,
     landscape, portrait), with no normalisation.
   - The Shell tool takes a kind (sprite, icon, texture, or a plain image), a
     target size and a path. For the first three it runs the asset job's
     per-entry path (transparency, tiling, normalisation, checks) without the
     style anchor or sheets.
5. **Sending is never automatic.**
   - The send tool exists only in Chat (the Shell tab gets no email tools),
     never in a job's toolset.
   - It ignores auto-approve.
   - The review dialog is the only path to SMTP. The model's tool call
     returns either "sent" or "the user discarded the draft" (with any note
     the user typed).
6. **The context audit measures before it changes anything.** Phase 12 adds
   per-turn context telemetry to run history, takes numbers from one real run
   of each job type, and fixes only what the numbers point at. Verification
   lite is a guided-planning option: one verify round, no revise loop.

## Verification

Each phase lists its own build gate and test plan. Across the plan, the build
gate is the repo's:

```
cd src-tauri && cargo test --lib && cargo clippy --all-targets -- -D warnings && cargo fmt -- --check
cd .. && npm run lint && npm run format:check && npm run check && npm run test
node scripts/check-ipc.mjs && node scripts/check-constants.mjs
```

`npm run test` must report no unhandled errors, not just no failures. Live
checks need real accounts and backends: an IMAP/SMTP account for 09 and 11,
the bundled engine and ComfyUI for 05, 07 and 08, and a real chain run for
01, 04 and 12.
