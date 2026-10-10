# Remote API — Implementation Plan

An optional API that lets something other than the desktop window drive
Haruspex: first Claude, for testing; then a web client, so the owner can leave
Haruspex running on their desktop and keep working on their projects from
another machine.

See [`overview.md`](./overview.md) for the why, the settled decisions and the
invariants.

**Status:** Phases 1–4 merged (#423, #431, #432, #434). Phase 5 is a sketch
to be written up before it starts. The phone app (was phase 6) moved to
`plan/futures.md` on 2026-10-09.

## Phase map

| #   | File                         | Phase                                                                                                             | Depends on |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | `phase-01-driver.md`         | Land `scripts/drive.mjs` and make it interactive: a long-lived app Claude can send prompts to and read state from | —          |
| 2   | `phase-02-engine-surface.md` | One dispatcher in the webview for Code-session operations and state events; the drive hooks move onto it          | 1          |
| 3   | `phase-03-owner-api.md`      | Rust transport: HTTP + SSE, per-client tokens and scopes, Settings → Remote control                               | 2          |
| 4   | `phase-04-web-client.md`     | The Code tab served to a remote browser, as a view of the desktop's sessions                                      | 3          |
| 5   | `phase-05-chat.md`           | Chat store keyed by conversation; chat in the web client                                                          | 4          |

Every phase that changes something a user can see updates `docs/guide/` in the
same PR. Phases 1 and 2 change nothing a user sees (label `no-docs`).
