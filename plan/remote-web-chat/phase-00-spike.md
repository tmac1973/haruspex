# Phase 00 — Answer the Question the Design Rests On

Two questions, both cheap, both able to change what gets built. Neither ships
code beyond a throwaway.

## 1. Does a backgrounded webview keep running?

**The assumption:** the local Haruspex sits minimised for hours while its
webview keeps executing turns on behalf of remote users.

**Why it might not hold:** WebKitGTK, WebView2 and WKWebView all throttle
background work to some degree — timers coalesced, rendering suspended,
sometimes whole processes frozen. macOS App Nap is the most aggressive. If the
webview is throttled, remote turns stall in ways that look like random hangs,
and the failure is worst on exactly the platforms this feature targets
(Windows and macOS).

**The test**, on Windows and macOS, in that order:

1. Add a temporary `setInterval` in the app that logs a monotonic tick every
   5s, and a second one that runs an actual model call every few minutes.
2. Minimise the window. Leave it 30 minutes. Do not touch the machine.
3. Read the log: are ticks evenly spaced, coalesced into bursts, or absent?
   Did the model calls complete?

Repeat with the window **fully occluded** by another maximised window rather
than minimised — occlusion and minimisation are throttled differently, and a
gaming PC user will do neither, but the *host* machine may well have its window
covered.

**If it holds:** nothing changes; phase 01 proceeds.

**If it does not**, the mitigations are known and bounded — this is a risk, not
a cliff:

- Windows: WebView2 exposes background-throttling controls; Tauri passes
  browser flags through.
- macOS: App Nap can be disabled per-app via `NSAppSleepDisabled` in
  `Info.plist`.
- Failing both: keep a WebSocket or interval alive from the Rust side to hold
  the page "active", or run remote sessions in a small always-visible window.

What must *not* happen is discovering this after the server, relay and client
are built. Hence phase 00.

**Also worth watching:** the queue's 5-minute lease means a throttled webview
releases its ticket rather than wedging inference for everyone — so the
failure mode is a stalled remote turn, not a dead app. Confirm that is what
actually happens.

## 2. Cap parallel lanes at the server's advertised slots

Independent of this feature, and worth landing first.

`InferenceQueue` treats a parallel lane as **unbounded**: capacity is 1 or
infinity (`inference_queue.rs`, `lane_parallel`). For OpenRouter that is right.
For a self-hosted server it is not — llama-server launched with `-np 4`, or a
toolchest model reporting four slots, will accept a fifth request and queue it
*internally*, where the app cannot see or report it. The user loses the
"waiting" signal precisely when contention starts, which is the moment this
feature makes contention normal.

The slot count is already collected: the toolchest probe reports it and it is
stored as `remoteParallel`, used today only for display in the capabilities
readout.

**The change:** carry a capacity rather than a bool from `laneFor()` through
`inference_acquire` into the lane's admission check. `remoteParallel` when
known; unbounded for OpenRouter, whose concurrency is not ours to model; 1 for
local.

**Why first:** it is small, it improves the app whether or not remote chat ever
ships, and it means phase 01 is not simultaneously introducing remote turns
*and* changing how admission counts them.

## Results

### Linux / WebKitGTK 4.1 — passes cleanly (2026-08-17)

The engine Tauri actually uses on Linux, in a GTK window that minimised itself
after a 45s visible baseline, with every event timestamped by the server rather
than the page (a frozen page cannot fake its own liveness):

| | |
|---|---|
| ticks before minimising | 8, avg gap **5.00s** |
| ticks after minimising | 135 over ~11 min, avg gap **5.01s**, worst **6.95s** |
| slow fetches completed | 23, of which **22 after minimising** |

135 ticks is exactly the expected count for the elapsed time, so essentially
nothing was dropped, and the worst gap of 6.95s is a scheduling hiccup rather
than throttling — throttling shows up as minute-long gaps, not a 2s one. The
in-flight fetches, which are the shape a streaming model call has, all
completed while backgrounded.

**Weak evidence for the platforms that matter, though.** Linux is the least
aggressive of the three, and the users this feature targets are on Windows and
macOS. Wayland also made external window control unreliable, hence the
self-minimising harness; occlusion by another window was not tested separately.

### Windows / WebView2 — still owed

The one to actually worry about: WebView2 is Chromium, and Chromium throttles
hidden pages hard (timers clamped to roughly once a minute after five minutes
of being hidden). If that applies to a minimised WebView2 host, remote turns
stall on the primary target platform.

Worth noting what the Linux run suggests but does not prove: turns are driven
by streaming fetches, not timers, and network activity is the thing that most
often keeps a page out of the frozen state. So the likely failure is the
queue's heartbeat timer rather than the turn itself — which the 5-minute lease
would then reclaim, degrading to a stalled turn rather than a wedged app.

### macOS / WKWebView — still owed

App Nap is the aggressive one here, and `NSAppSleepDisabled` in `Info.plist`
is the documented mitigation if it bites.

## Verification

- A written answer to question 1 for **Windows and macOS**, added above, before
  phase 01 starts. Linux is done.
- For question 2: a test that a lane with capacity 2 admits two and queues the
  third, and that an unknown slot count still behaves as it does today.
