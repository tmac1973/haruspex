# Phase 01 — Finding a Browser and Driving It

A self-contained `proxy/browser/` module: locate an installed Chromium-family
browser, run it headless with a throwaway profile, and expose one operation —
"navigate to this URL and give me the settled DOM". No search knowledge here.

## Steps

### 1. Detection

`browser/detect.rs`, in priority order. First hit that passes verification wins.

**1. Explicit override.** A settings-provided path, and `HARUSPEX_BROWSER_PATH`
for headless/CI use. Always first: every heuristic below will be wrong for
somebody, and an escape hatch costs one line.

**2. Per-OS candidates.**

*Linux* — `PATH` lookups then absolute paths. Verified present on the dev box:

```
google-chrome, google-chrome-stable, chromium, chromium-browser,
brave-browser, microsoft-edge, microsoft-edge-stable      (via PATH)
/opt/google/chrome/chrome
/usr/lib64/chromium-browser/chromium-browser
/usr/bin/chromium
/snap/bin/chromium
```

**Flatpak is deliberately excluded.** `flatpak run com.brave.Browser
--headless=new --user-data-dir=... --dump-dom about:blank` hung until killed —
the sandbox does not cooperate with an external profile directory. Detecting it
would offer the user a browser that never returns.

*macOS* — app bundles, system then user:

```
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
/Applications/Chromium.app/Contents/MacOS/Chromium
/Applications/Brave Browser.app/Contents/MacOS/Brave Browser
/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge
~/Applications/… (same four)
```

Safari is not a candidate: no CDP. A Mac with only Safari has no browser mode.

*Windows* — the registry first, since it survives non-default install
locations:

```
HKLM/HKCU  SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe
HKLM/HKCU  SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe
```

then the conventional paths under `%ProgramFiles%`, `%ProgramFiles(x86)%` and
`%LOCALAPPDATA%` for Chrome, Edge, Brave and Chromium. **Edge ships with
Windows 10+ and is Chromium**, so coverage there is effectively total — worth
stating in the UI copy, because "install Chrome" is the wrong instruction on a
machine that already has a Chromium browser.

**3. Verification, not just existence.** Run `--version` with a short timeout
and require Chromium-family output (`Chrome/`, `Chromium/`, `Brave/`, `Edg`).
An executable named `chromium` that is a wrapper script pointing at a missing
snap is a real thing; a file existing is not evidence it runs.

Detection result is cached for the process, with an explicit refresh so the
Settings page can re-probe after the user installs something.

### 2. Launching

`browser/process.rs`. The flag set is not arbitrary — each one was earned:

```
--headless=new
--disable-gpu
--user-data-dir=<fresh temp dir>     # never the user's profile
--remote-debugging-port=0            # let the OS pick; read the real port back
--remote-allow-origins=*             # Chrome >=111 rejects the WS handshake without it
--user-agent=<normal Chrome UA>      # see below — load-bearing
--no-first-run --no-default-browser-check --disable-extensions
```

**The user-agent flag is load-bearing.** Without it Chrome advertises
`HeadlessChrome/...` and Startpage silently redirects to its homepage: zero
results, no error, nothing in the logs to explain it. With a normal Chrome UA
the identical URL renders ten. Derive the version from the detected browser's
`--version` output so the claim stays plausible rather than pinning a number
that ages.

`--remote-debugging-port=0` means reading the actual port from the
`DevToolsActivePort` file in the profile dir (first line), rather than guessing
a free port and racing another process for it.

Lifecycle: launch on first use, keep warm, quit after an idle timeout
(60s is a reasonable start) or when the app shuts down. The temp profile is
removed on quit. Measured cost: 0.19s to start, ~1.2 GB resident while alive —
which is why it does not stay alive.

**Process cleanup is a correctness issue, not hygiene.** A leaked headless
Chrome holds ~1 GB and a debugging port; the existing sidecar supervisor has
the same concern and `kill_process_on_port` already exists in `sidecar_utils`.
Kill on drop, and on startup sweep any browser left behind by a previous crash
(identify by the temp-profile path prefix, not by process name — the user's own
Chrome must never be touched).

### 3. A minimal CDP client

`browser/cdp.rs`. This does not need a CDP crate; the whole surface is five
methods over one WebSocket:

- `Target.createTarget` (on the browser-level socket) → a tab
- attach to that target's own WebSocket
- `Page.enable`, `Runtime.evaluate`, `Target.closeTarget`

Add `tokio-tungstenite` (the only new dependency — `reqwest` already covers the
`/json/version` HTTP call, and `tokio`/`futures-util` are present).

`Target.createTarget` returns the id; the tab's WebSocket URL comes from
`/json`. **Pick `type == "page"`**: extension background pages are listed first
and attaching to one returns a 77-byte DOM, which reads exactly like "the site
returned nothing".

One public operation:

```rust
/// Navigate, wait until `ready` reports the page has what the caller needs
/// (or the deadline passes), and return the settled `outerHTML`.
pub async fn render(&self, url: &str, ready: &dyn Fn(&str) -> bool, timeout: Duration)
    -> Result<String, BrowserError>;
```

Polling `Runtime.evaluate` for `document.documentElement.outerHTML` every
~300ms is enough and avoids subscribing to lifecycle events; the caller's
`ready` closure is what knows when a page is done, which for search means "the
parser found results". A proof-of-work challenge clears in ~2s and a plain
render in well under one, so a 15s deadline is generous.

Guard the first poll: `document.documentElement` is briefly null right after
navigation and `Runtime.evaluate` then returns no `value` at all, which is a
panic if unwrapped.

### 4. Tests

The parts worth testing here are the pure ones — a browser cannot be assumed
in CI:

- Candidate path lists are non-empty per platform, and the override takes
  precedence over everything.
- `--version` output classification: accepts Chrome/Chromium/Brave/Edge
  strings, rejects Firefox and garbage.
- `DevToolsActivePort` parsing: first line is the port, missing/short file is
  an error rather than a panic.
- CDP frame encode/decode against captured payloads, including the
  `documentElement is null` shape that returns no `value`.

An integration test that actually launches a browser must be `#[ignore]`d, with
its command in the phase notes so it is runnable by hand.

## Verification

- Run the ignored integration test locally against Chrome and Chromium; both
  are installed on the dev box and both were verified working during
  investigation.
- Kill the app mid-search and confirm no headless process survives, and that
  the temp profile is gone.
- Point `HARUSPEX_BROWSER_PATH` at a non-browser and confirm the failure is a
  clear error, not a hang.
