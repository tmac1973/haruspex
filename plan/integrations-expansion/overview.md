# Integrations Expansion — Project Overview

**Status:** Locked 2026-09-03 · **Type:** New feature (multi-track) · **Output of:** a guided planning session against a three-tier integration strategy.

---

## Problem

Haruspex ships three hand-built integrations: filesystem/local docs, web search +
fetch, and IMAP email. Every additional service would, today, mean another
hand-built Rust module — which does not scale past the handful of things worth
that investment.

The gap is twofold:

1. **No general integration mechanism.** There is no MCP client, so the entire
   third-party ecosystem is unreachable. `src-tauri/src/integrations/mod.rs`
   has said "eventually a general MCP client for the long tail" since Phase 10.
2. **Missing capabilities that only a desktop app can have.** Clipboard, active
   window and screen capture are the things a browser-based assistant
   structurally cannot do, and Haruspex does not expose any of them to the
   agent. A local-first PIM story stops at email, with no calendar or contacts.

## Goals

- A **three-tier integration strategy**, implemented:
  - **Tier 1, hand-built** — desktop context (clipboard, active window,
    screenshots) and CalDAV/CardDAV, chosen because they need OS-level access or
    are used every session.
  - **Tier 2, curated MCP catalog** — vetted server configs with tested default
    tool filters and guided setup, shipped with the app.
  - **Tier 3, arbitrary user-defined MCP servers** — the long tail.
- An MCP client that **speaks both protocol eras** (2026-07-28 stateless and the
  2025-11-25-and-earlier handshake), because most servers in the wild are still
  on the older revision.
- **Zero-install for the user.** Adding an integration must be completable
  entirely inside the app's UI by someone who has never opened a terminal.
- **Per-server and per-tool enable/disable from day one**, plus a tool budget
  that scales with the active model — a 30-tool server wrecks a 9B model's tool
  selection and eats its context.

## Non-goals

- **Local semantic search over user files.** The flagship retrieval feature, and
  a project in its own right; it gets its own plan folder, as
  `plan/agentic-memory/` did. Nothing here may foreclose it.
- **OAuth as shared infrastructure.** There is no OAuth anywhere in the tree
  today and none is added. CalDAV/CardDAV use basic/app-password auth; anything
  Google-shaped ships as a curated MCP config instead of a hand-built integration.
- **Docker-based MCP servers.** Docker is never bundled and is not a supported
  acquisition kind.
- **MCP resources and prompts.** Tools only in v1.
- **CalDAV/CardDAV writes.** Read-only first, mirroring how email shipped
  (10.1 read-only, 10.2 sending).
- **Background polling of anything.** No capability here ever samples the
  clipboard, the focused window, or the screen on a timer.

## Users & primary flows

Single-user desktop app. The person adding an integration is assumed
**non-technical** — this is the constraint that shapes the whole MCP design.

**Flow A — add a curated MCP server.** Settings → Integrations → browse the
bundled catalog → "Add" → the app installs the server package with a progress
bar (bundled npm/uv, or a checksum-verified release binary) → guided setup steps
collect whatever the server needs (a token, a credentials file, a browser auth
step) → the server starts, its tools are discovered, sensible defaults are
enabled, and the tools appear to the agent. No terminal, no separately installed
software.

**Flow B — add a custom MCP server.** The tier-3 escape hatch: the user supplies
a command and arguments directly. Same lifecycle, same tool controls, no catalog
entry.

**Flow C — desktop context.** The user hits a global hotkey; Haruspex opens with
the clipboard (and, where the platform can report it, the active window) already
in the composer. Or, mid-conversation, the model calls `read_clipboard` /
`active_window` / `capture_screen` because the user referred to something on
screen.

**Flow D — calendar and contacts.** The user adds a CalDAV/CardDAV account with a
URL and an app password; discovery finds the collections; the agent can then
answer questions about their schedule and their contacts alongside their email.

## Constraints

- **Non-technical user, zero install.** Bundle every runtime an integration
  needs. The user must never be told to install Node, Python, or Docker.
- **Local-first and offline-capable.** After install, starting a server must not
  require the network. The catalog ships in the bundle, not from a hosted endpoint.
- **User-initiated capture only.** Clipboard, window and screen reads happen on
  an explicit tool call or an explicit keypress, never on a timer — and this must
  be obvious from reading the source.
- **Third-party code runs here.** MCP servers are arbitrary programs with
  arbitrary side effects. Non-read-only tools are gated behind an approval
  prompt, and a tool with no annotation is treated as unsafe.
- **Process lifecycle is the part that bites.** Spawn, crash, hang and zombie
  reaping get built and tested before any protocol work.
- **All three platforms.** Linux, macOS and Windows are implemented up front for
  every new native capability; Tim verifies on real machines.
- **Context is the scarce resource.** Every exposed tool's schema ships in every
  request. Tool controls and a model-scaled budget are day-one features, not
  follow-ups.

## Success criteria

- A non-technical user can add GitHub from the catalog, supply a token in a
  form, and have the agent read their repositories — without leaving the app.
- The Google Drive/Workspace guided setup walks that same user through the Cloud
  project, OAuth client, credentials file and browser auth, entirely in-app.
- Killing an MCP server mid-call recovers cleanly; quitting the app mid-call
  leaves no orphaned child processes.
- A server exposing 30+ tools produces a visible budget warning on the 9B tier,
  and the user can disable individual tools to clear it.
- `read_clipboard` and `active_window` work on X11, Windows and macOS, and report
  a clear, honest "unavailable" under Wayland rather than failing obscurely.
- Screen capture works under the Wayland portal, X11, macOS and Windows, and the
  model demonstrably reads the resulting image.
- A real Nextcloud or Fastmail account can be added and queried for events and
  contacts.

## Decisions

Every decision below is resolved. Nothing is deferred to implementation.

### Scope and sequencing

| Decision | Resolution |
|---|---|
| Capabilities in scope | Desktop context (clipboard + active window), MCP client infrastructure, screenshots, CalDAV/CardDAV |
| Local semantic search | **Out of scope.** Separate plan folder later |
| Plan layout | One folder, dependency-ordered phases (this folder) |
| Ordering | Desktop context as warm-up, then MCP front-loaded, then screenshots and DAV as independent tracks |
| Platforms | Linux, macOS and Windows implemented up front |

### MCP

| Decision | Resolution |
|---|---|
| Client implementation | **rmcp 3.x**, the official Rust SDK |
| Protocol eras | Both. 2026-07-28 stateless *and* the 2025-11-25-and-earlier `initialize` handshake |
| Runtimes | **Bundled**: Node + npm and `uv`. `uv` manages its own CPython, so no Python bundle |
| Third acquisition kind | **Release binary**, per-platform, checksum-verified — required by GitHub's official server, which is a Go binary, not an npm package |
| Docker | Never bundled; not a supported acquisition kind |
| Package acquisition | **Explicit install with progress**, then launch from disk. `npx -y` rejected: re-resolves over the network every launch, fails opaquely offline |
| Tool registration | **Dynamic, into the existing registry Map**, under a new `mcp` category |
| Tool naming | Namespaced `mcp__<server>__<tool>` to avoid collisions |
| Approval gate | **Annotation-driven.** `readOnlyHint` runs freely; anything else prompts once per tool with "always allow". **Missing annotation = treated as non-read-only** |
| Tool budget | Per-tool enable/disable from day one, plus a **warning** above a model-scaled cap. Warn, never auto-narrow |
| Catalog location | **Bundled JSON in the repo**, shipped with the app |
| Catalog v1 entries | **GitHub** (release binary, PAT) and **Google Drive/Workspace** (npm, OAuth-heavy) |
| Catalog format | Includes a **guided-setup concept**: ordered steps with instruction text and links, secret and file inputs, and a post-install auth command whose output the app surfaces |
| Transports | **stdio first**; streamable HTTP is a later phase within this plan |
| Server-initiated requests | Multi Round-Trip Requests (`resultType: "input_required"` → retry with `inputResponses`) mapped onto the **existing** HITL primitive in `src/lib/stores/userQuestion.svelte.ts` |
| Secrets storage | The settings blob, same trust level as the existing Brave / inference / IMAP credentials. Documented explicitly, not silently |

### Desktop context

| Decision | Resolution |
|---|---|
| Surfaces | Both **agent tools** (`read_clipboard`, `active_window`) and a **global hotkey** that captures context into a new chat |
| Clipboard implementation | Reuse the existing `src-tauri/src/clipboard.rs` (arboard, off the main thread). No new native code |
| Active window | **Best-effort per platform with an honest "unavailable"**: X11 `_NET_ACTIVE_WINDOW`, Windows `GetForegroundWindow`, macOS `NSWorkspace` app name (title only with an Accessibility grant), Wayland unavailable |
| Why Wayland is unavailable | `ext-foreign-toplevel-list-v1` is compositor-dependent and does not cleanly report focus; GNOME needs a shell extension, KDE needs KWin scripting. Not a generic capability |
| Polling | **Never.** User-initiated reads only |

### Screenshots

| Decision | Resolution |
|---|---|
| Capture scope | Whole screen or a user-chosen window |
| Linux | **Portal-first** — `xdg-desktop-portal` Screenshot on Wayland; its system picker *is* the user-initiated guarantee. Direct X11 path otherwise |
| macOS / Windows | ScreenCaptureKit with the Screen Recording grant; native capture on Windows |
| Vision | Confirmed available — every model in `src-tauri/src/models.rs` carries an `mmproj_url`. **No OCR fallback needed** |

### CalDAV / CardDAV

| Decision | Resolution |
|---|---|
| v1 scope | **Read-only.** Writes are a later phase, mirroring email's 10.1/10.2 split |
| Auth | **Basic / app-password only.** No OAuth is added to the tree |
| Covered servers | Nextcloud, Fastmail, iCloud, Radicale, Baikal, Synology |
| Google Calendar | **Not hand-built.** Ships as a curated MCP config, consistent with the "don't hand-build Google" rule |
| Discovery | RFC 6764 — `/.well-known/caldav` plus SRV records |
| Account shape | Mirrors `EmailAccount`: multi-account, per-account enable toggle, UUID keyed, fan-out on list-style calls |
