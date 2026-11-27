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
2. **Missing capabilities that only a desktop app can have.** Screen capture is
   the thing a browser-based assistant structurally cannot do, and Haruspex does
   not expose it to the agent. A local-first PIM story stops at email, with no
   calendar or contacts.

## Goals

- A **three-tier integration strategy**, implemented:
  - **Tier 1, hand-built** — screen capture and CalDAV/CardDAV, chosen because
    they need OS-level access or are used every session.
  - **Tier 2, curated MCP catalog** — vetted server configs with tested default
    tool filters and guided setup, shipped with the app. Includes
    **companion-app** entries: servers that drive a third-party desktop
    application Haruspex neither bundles nor installs.
  - **Tier 3, arbitrary user-defined MCP servers** — the long tail.
- An MCP client that **speaks both protocol eras** (2026-07-28 stateless and the
  2025-11-25-and-earlier `initialize` handshake). Not for the features — a
  modern-only client against a legacy server simply *fails*, per the spec's own
  compatibility matrix, so the era we skip is a slice of the ecosystem we cannot
  talk to at all. As of September 2026 the stateless revision is five weeks old
  and the feature-lifecycle policy guarantees legacy at least a twelve-month
  deprecation window, with the v1 SDK lines alive alongside v2; the long tail
  Tier 3 exists to serve will be handshake-era for a while yet. Revisit once the
  curated catalog is majority-modern — dual-era is scoped (see Phase 03) so that
  dropping legacy is a deletion, not an untangling.
- **Zero-install for the user.** Adding an integration must be completable
  entirely inside the app's UI by someone who has never opened a terminal.
- **Per-server and per-tool enable/disable from day one**, plus a tool budget
  that scales with the active model — a 30-tool server wrecks a 9B model's tool
  selection and eats its context.

## Non-goals

- **Local semantic search over user files.** The flagship retrieval feature, and
  a project in its own right; it gets its own plan folder, as
  `plan/archive/agentic-memory/` did. Nothing here may foreclose it.
- **OAuth as shared infrastructure.** There is no OAuth anywhere in the tree
  today and none is added. CalDAV/CardDAV use basic/app-password auth; anything
  Google-shaped ships as a curated MCP config instead of a hand-built integration.
- **Docker-based MCP servers.** Docker is never bundled and is not a supported
  acquisition kind.
- **MCP resources and prompts.** Tools only in v1.
- **CalDAV/CardDAV writes.** Read-only first, mirroring how email shipped
  (10.1 read-only, 10.2 sending).
- **Background polling of anything.** No capability here ever samples the screen
  on a timer.
- **Clipboard and active-window tools, and a global hotkey.** Cut 2026-09-05.
  A `read_clipboard` / `active_window` pair plus a system-wide shortcut that
  prefills a new chat is a lot of per-platform native work — X11 atoms, Win32,
  AppKit, an honest Wayland "unavailable", plus shortcut registration and
  focus-stealing behaviour on three platforms — for something the user already
  does by pasting into the composer. The hotkey in particular is the hardest
  thing here to get right cross-platform and the easiest to live without. Screen
  capture survives the same cut because the agent deciding to *look*,
  mid-conversation, is a capability dragging a file into the composer does not
  provide.

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

**Flow C — screen capture.** Mid-conversation, the user refers to something on
screen and the model calls `capture_screen`; on Wayland the portal's own picker
is what makes the capture user-initiated. The user can also attach a capture from
the composer directly.

**Flow D — a companion application.** The user installs the Blender entry from
the catalog, runs its addon install, and enables the addon in Blender. From then
on the app knows whether Blender is actually reachable and says so in Settings,
rather than looking healthy and failing at chat time.

**Flow E — calendar and contacts.** The user adds a CalDAV/CardDAV account with a
URL and an app password; discovery finds the collections; the agent can then
answer questions about their schedule and their contacts alongside their email.

## Constraints

- **Non-technical user, zero install.** Bundle every runtime an integration
  needs. The user must never be told to install Node, Python, or Docker.
- **Local-first and offline-capable.** After install, starting a server must not
  require the network. The catalog ships in the bundle, not from a hosted endpoint.
- **User-initiated capture only.** Screen reads happen on an explicit tool call
  or an explicit composer action, never on a timer — and this must be obvious
  from reading the source.
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
- With Blender closed, its server's Settings row says *running, but Blender is not
  connected* with the steps to fix it — and flips on its own once the user starts
  the addon, without restarting anything.
- Screen capture works under the Wayland portal, X11, macOS and Windows, and the
  model demonstrably reads the resulting image.
- A real Nextcloud or Fastmail account can be added and queried for events and
  contacts.

## Decisions

Every decision below is resolved. Nothing is deferred to implementation.

### Scope and sequencing

| Decision | Resolution |
|---|---|
| Capabilities in scope | MCP client infrastructure (including companion-app servers), screen capture, CalDAV/CardDAV |
| Local semantic search | **Out of scope.** Separate plan folder later |
| Clipboard / active window / global hotkey | **Cut 2026-09-05.** Heavy per-platform native work for something pasting already covers; the hotkey is the hardest part to get right on three platforms. See Non-goals |
| Plan layout | One folder, dependency-ordered phases (this folder) |
| Ordering | MCP front-loaded and internally sequential; screen capture and DAV as independent tracks alongside it |
| Platforms | Linux, macOS and Windows implemented up front |

### MCP

| Decision | Resolution |
|---|---|
| Client implementation | **rmcp 3.x**, the official Rust SDK |
| Protocol eras | Both, but *scoped*: connect / `tools/list` / `tools/call` on either era; the interactive path (MRTR) is modern-only |
| Runtimes | **Bundled**: Node + npm and `uv`. `uv` manages its own CPython, so no Python bundle |
| Third acquisition kind | **Release binary**, per-platform, checksum-verified — required by GitHub's official server, which is a Go binary, not an npm package |
| Docker | Never bundled; not a supported acquisition kind |
| Package acquisition | **Explicit install with progress**, then launch from disk. `npx -y` rejected: re-resolves over the network every launch, fails opaquely offline |
| Tool registration | **Dynamic, into the existing registry Map**, under a new `mcp` category |
| Tool naming | Namespaced `mcp__<server>__<tool>` to avoid collisions |
| Approval gate | **Annotation-driven.** `readOnlyHint` runs freely; anything else prompts once per tool with "always allow". **Missing annotation = treated as non-read-only** |
| Tool budget | Per-tool enable/disable from day one, plus a **warning** above a model-scaled cap. Warn, never auto-narrow |
| Catalog location | **Bundled JSON in the repo**, shipped with the app |
| Catalog v1 entries | **GitHub** (release binary, PAT), **Google Drive/Workspace** (npm, OAuth-heavy), **Blender** (pypi, companion app) and **Godot** (pypi, companion app). Between them they exercise all three acquisition kinds and every setup step kind |
| Catalog format | Includes a **guided-setup concept**: ordered steps with instruction text and links, secret and file inputs, and a post-install auth command whose output the app surfaces |
| Transports | **stdio first**; streamable HTTP is a later phase within this plan |
| Server-initiated requests | Multi Round-Trip Requests (`resultType: "input_required"` → retry with `inputResponses`) mapped onto the **existing** HITL primitive in `src/lib/stores/userQuestion.svelte.ts` |
| Secrets storage | The settings blob, same trust level as the existing Brave / inference / IMAP credentials. Documented explicitly, not silently |

### Companion-app servers

| Decision | Resolution |
|---|---|
| The class | Servers bridging a third-party desktop app the user installs themselves — the app must be present, carry an enabled addon, and be **running** |
| v1 entries | **Blender** (`blender-mcp`, MIT, community) and **Godot** (`godot-editor-mcp`, community) |
| The problem being solved | The MCP process is genuinely healthy — it negotiates and lists tools — while every call fails. Without modelling this, Settings shows green and the model reports it cannot reach Blender |
| Declaration | A `companion` block in the catalog entry: app name, minimum version, download link, a probe, and a hint string shown to the user |
| Probe kinds | **`tcp`** (Blender's addon listens on 9876) and **`tool`** (Godot's addon dials *out* to the server, so a port check would always succeed; call a tool and classify `BRIDGE_DISCONNECTED`) |
| Probe safety | A `tool` probe may name only a tool carrying `readOnlyHint`, validated at parse time. The app calls probes on its own initiative, so a probe must never reach a tool the approval gate would prompt for |
| Status shape | A **field beside** `SidecarStatus`, not a fifth variant — the process state is genuinely fine. Displayed as one combined line |
| Probe cadence | On start, on demand, after a failed tool call, and on a slow poll **only while the settings panel is open** |
| Blender telemetry | `DISABLE_TELEMETRY=true` in the entry, asserted by a test against the spawned environment. A catalog entry that phones home contradicts the product |
| Blender code execution | `execute_blender_code` is out of `defaultTools`, carries no `readOnlyHint` so the gate prompts, and is never probe-eligible |
| Godot addon scope | Per **project**, not per machine — installed from the Asset Library into each project. The setup steps and the hint both say so |
| Vetting community entries | Pinned version, recorded license and maintainer shown in the catalog browser **before install**, source reviewed at the pinned version, `defaultTools` actually exercised |

### Screen capture

| Decision | Resolution |
|---|---|
| Surfaces | An **agent tool** (`capture_screen`) plus a composer attach control. No global hotkey |
| Capture scope | Whole screen or a user-chosen window |
| Linux | **Portal-first** — `xdg-desktop-portal` Screenshot on Wayland; its system picker *is* the user-initiated guarantee. Direct X11 path otherwise |
| macOS / Windows | ScreenCaptureKit with the Screen Recording grant; native capture on Windows |
| Vision | Confirmed available — every model in `src-tauri/src/models.rs` carries an `mmproj_url`. **No OCR fallback needed** |
| Consent | One Settings toggle, default off, gated twice (schema filter **and** `executeTool`) |
| Polling | **Never.** User-initiated reads only |

### CalDAV / CardDAV

| Decision | Resolution |
|---|---|
| v1 scope | **Read-only.** Writes are a later phase, mirroring email's 10.1/10.2 split |
| Auth | **Basic / app-password only.** No OAuth is added to the tree |
| Covered servers | Nextcloud, Fastmail, iCloud, Radicale, Baikal, Synology |
| Google Calendar | **Not hand-built.** Ships as a curated MCP config, consistent with the "don't hand-build Google" rule |
| Discovery | RFC 6764 — `/.well-known/caldav` plus SRV records |
| Account shape | Mirrors `EmailAccount`: multi-account, per-account enable toggle, UUID keyed, fan-out on list-style calls |
