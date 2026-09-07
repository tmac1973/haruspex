# Verification record — integrations expansion

What was actually checked, on what, and when. Written to be honest rather than
complete: a row that could not be verified says so and says what it would take,
because a checklist full of assumed ticks is worse than no checklist.

**Machine of record:** CachyOS (Arch), Linux 7.2.3, KDE Plasma on Wayland,
dual monitor (7520x2160 combined), x86_64. No macOS or Windows machine was
available while the phases were written.

Three states are used:

- **automated** — a named test proves it and runs in CI.
- **observed** — a person or a tool actually did it; the date and machine are
  given.
- **unverified** — nobody has done it. What it would take is stated.

---

## Cross-platform matrix

| Capability | Linux/X11 | Linux/Wayland | macOS | Windows |
|---|---|---|---|---|
| `capture_screen` | unverified | **observed** | unverified | unverified |
| Bundled node/npm/uv | unverified | unverified | unverified | unverified |
| MCP stdio server | unverified | **observed** | unverified | unverified |
| Companion probe (Blender, Godot) | unverified | unverified | unverified | unverified |

### capture_screen — Linux/Wayland: observed

2026-09-07, KDE Plasma Wayland. `cargo test portal_capture -- --ignored`
opened the desktop's own picker and returned a 7520x2160 PNG, which decoded and
downscaled cleanly. That run is what found the downscale bug below.

### capture_screen — Linux/X11: unverified

The machine of record runs Wayland, and XWayland's root window is not viewable,
so `GetImage` returns `BadMatch` — the fallback cannot be exercised there. The
error path *was* exercised, and produces the message that tells the user to
install a portal, which is the right answer under XWayland.

Pixel handling is **automated**: `to_rgb` is tested for 32bpp and 24bpp in both
byte orders, for an unreadable depth, and for a short read
(`desktop::linux::tests`). What is unverified is only whether a real X server
hands back what those tests assume.

**To verify:** log into an X11 session (or a bare WM with no portal running)
and run `cargo test --manifest-path src-tauri/Cargo.toml x11_capture -- --ignored --nocapture`.

### capture_screen — macOS and Windows: unverified

Neither path has ever been compiled. There is no cross toolchain on the machine
of record (no rustup), macOS has **no CI job at all**, and the Windows CI job is
opt-in via the `windows-ci` label. `desktop/external.rs` first compiles at
release time.

**To verify:** on macOS, launch before granting Screen Recording and confirm the
result names System Settings rather than describing an empty desktop; then grant
it and capture both a screen and a focused window. On Windows, capture both. Add
the `windows-ci` label to the PR to get the Windows compile checked earlier.

### MCP stdio server — Linux/Wayland: observed

2026-09-05/06. The GitHub catalogue entry was installed from the UI, a token
pasted, and the model asked to summarise a PR. Three real bugs came out of that
session and are fixed: configured servers were never started at launch, a
reloaded frontend hit "already running" against a backend that outlives it, and
the server log was unreadable. `Settings → Logs → MCP` was used to diagnose the
third, which is also what verified the log tab.

### Bundled node/npm/uv: unverified

The GitHub entry is a **binary** download, so the run above exercised the
catalogue, install, spawn and tool-call path but **not** the bundled runtimes.
No npm-packaged (Google Drive) or PyPI-packaged (Blender, Godot) server has been
installed on any machine.

`tauri-build` validating the `externalBin` paths is automated in both CI jobs
(they create stubs). That proves the paths are declared, not that the binaries
run.

**To verify:** install Google Drive from the catalogue on each platform, which
exercises node + npm; then Blender or Godot, which exercises uv.

### Companion probe: unverified

`classify_tool_probe` and `probe_tcp`'s three outcomes are **automated**
(`integrations::mcp::companion::tests`), including that an unrecognised failure
degrades to *unknown* rather than *disconnected*. Neither Blender nor Godot has
been run.

**To verify:** journeys 3 and 4 below.

---

## Process lifecycle soak

| Check | State |
|---|---|
| Normal quit leaves no children | unverified |
| `kill -9` then relaunch reaps every orphan | **automated** (partial) |
| A recycled pid running something else is left alone | **automated** |
| Fifty start/stop cycles accumulate nothing | unverified |
| A server that crashes on every start does not spin | **automated** (by construction) |
| Hot-reload during `make dev` | **observed** |

The orphan registry's behaviour is covered by `integrations::mcp::orphans::tests`
— a matching stale pid is killed, a recycled pid running a different command is
not, a dead pid is not reported as killed, the sweep visits every entry rather
than stopping at the first miss, and a corrupt registry file round-trips. What is
unverified is the real `kill -9` on a real app with real children.

Nothing auto-restarts (`process.rs` module docs), so the restart-loop row is
true by construction rather than by test.

The hot-reload row is observed rather than clean: `make dev` restarting several
times is exactly what surfaced the "already running" bug, now fixed by adopting a
server that is already `Ready`.

**To verify the rest:** start three servers, use them, quit — `pgrep -f mcp`
should be empty. Then start three, `kill -9` the app, relaunch, and check the
same. Then script fifty start/stop cycles and watch RSS and `ls /proc/<pid>/fd`.

---

## Offline and degraded

| Check | State |
|---|---|
| Installed server starts and works with no network | unverified |
| Network dropping mid-download fails cleanly | unverified |
| A missing bundled runtime is reported in Settings | **automated** (by construction) |
| An unreachable DAV server errors readably rather than hanging | **automated** |

`mcp_runtimes_available` is called by the MCP settings section on mount, so a
missing runtime is surfaced there rather than at spawn. That is structural, not
tested end to end.

The DAV row is
`integrations::dav::client::tests::an_unreachable_server_fails_readably_instead_of_hanging`:
a real request to a closed loopback port, wrapped in a timeout that fails the
test if it hangs, asserting the message names the address and says what went
wrong.

**To verify the rest:** install a server, disconnect, restart the app, use it.
Then start a download and pull the network mid-way; confirm no partial directory
survives and a retry works.

---

## Hostile and malformed servers

| Check | State |
|---|---|
| Both protocol eras reachable | unverified (legacy era) |
| Malformed JSON, enormous results, unseen schemas | **automated** |
| A server whose tools carry no annotations — every one prompts | **automated** |
| A server that renames its tools between listings | **automated** |
| A companion that dies mid-conversation | **automated** (classification only) |
| A `tool` probe whose target tool is gone → *unknown* | **automated** |
| An oversized tool result is truncated, not 400'd | **automated** |

- No annotations prompting is `mcp.test.ts` → "prompts when the server said
  nothing at all". This is the load-bearing one: the absence of a claim about
  safety is not a claim of safety.
- Renaming is "replaces a previous registration rather than accumulating" —
  the old names stop being callable.
- Oversized results are `context-budget.test.ts` → "truncates a single oversized
  message" and "always satisfies the budget post-condition, even pathologically".
- Transport failure mid-call is "turns a transport failure into a tool error,
  not an exception" and "says a tool is gone when its server stopped mid-turn".
- The **legacy** protocol era is exercised only against the local fixture server
  (`tests/`), not against a real handshake-era server. rmcp's
  `ClientLifecycleMode::Auto` chooses the era, so the untested part is its
  probe against a real one, not our handling of the result. The GitHub server
  observed in journey 1 is a modern-era server.

A genuinely adversarial server — one deliberately returning malformed frames —
has not been written. The coercion layer (`coerce.test.ts`) and the parser are
covered against malformed *input*, not against a malicious peer.

---

## Small-model behaviour

**unverified.** The budget warning and the curated-default subset both exist and
are unit-tested, but no side-by-side comparison of tool-selection quality on the
9B tier has been run, and that comparison is the evidence that calibrates the
cap.

**To verify:** with the GitHub server enabled, ask the same five questions on the
9B model with the curated defaults and then with every tool switched on, and
record which tool it picked each time. That belongs here, not in someone's
memory.

---

## End-to-end user journeys

| # | Journey | State |
|---|---|---|
| 1 | Install GitHub, paste a token, ask about a repo | **observed** |
| 2 | Google Drive setup start to finish, no terminal | unverified |
| 3 | Blender: install, addon, describe the scene | unverified |
| 4 | Godot: hint without the addon, then reconnect | unverified |
| 5 | Screenshot a window and ask what it says | unverified |
| 6 | Nextcloud account, ask what's on this week | unverified |

Journey 1 was run on 2026-09-05 and is what produced the three MCP fixes noted
above.

Journey 5 is partly covered: the portal capture itself is observed, but not the
`window` target and not the round trip through the model.

Journey 6 has never been run against a real server. The whole DAV stack —
CalDAV and CardDAV — is verified only against fixtures. **This is the largest
untested surface in the expansion**: discovery, the `calendar-query` REPORT, the
`addressbook-query` REPORT and its PROPFIND fallback have never spoken to a real
server. The unit tests cover what the code does with a response, not whether
real servers send what it expects.

**To verify:** add one Nextcloud or Fastmail account and press Check. That one
click exercises well-known discovery, the principal lookup, both home sets and
both collection listings, and it names what it found.

---

## Bugs this phase's own work found

Recorded because they are the argument for the checklist existing.

1. **Downscaling a multi-monitor capture.** Found by the one live portal run.
   A 1536 long-edge cap left a 7520x2160 desktop at 1536x441 — the same pixel
   count spread so thin that nothing on it could be read. Replaced with a pixel
   budget, which gives 2150x618 for the same image-token cost.
2. **An escaped `&` truncated calendar and contact data.** Found while writing
   the CardDAV path. quick-xml reports `&amp;` as its own event, splitting
   character data around it, and the parser kept only the first piece — so any
   calendar was silently cut at its first "Bob & Alice sync". Present since
   phase 10, fixed in phase 11, five regression tests.
3. **A settings panel that stopped navigating.** Reported by the user. Sections
   edit a working copy in `$state` and handed that proxy back to the store;
   `structuredClone` throws on a proxy, and a throw inside a Svelte template
   aborts the render. Fixed at the store boundary so every write snapshots to
   plain data.

Each was a silent wrong answer rather than a crash, which is the class of bug
this expansion is most exposed to.

---

## Build gate

Run on the machine of record, 2026-09-07, all clean:

```
npm run check && npm run lint && npm run test && npm run format:check
cargo test   --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
cargo fmt    --manifest-path src-tauri/Cargo.toml -- --check
node scripts/check-ipc.mjs
npm run tauri build -- --bundles deb
```

`npm run tauri build -- --bundles deb` produced `Haruspex_0.1.61_amd64.deb`
(304 MB) with zero warnings. It has been run on **Linux only**.

The release build is worth running for its own sake and not only for the
bundle: it is a different `cfg` from everything else in the gate, and it caught
a dead-code warning in `runtimes.rs` that no debug build or clippy run had ever
shown. Add it to the pre-release routine rather than to every commit.
