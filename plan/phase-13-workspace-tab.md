# Phase 13: Workspace Tab (Interactive Python + HTML Stage)

## Goal

Add a second tab to the main view — alongside Chat — that gives the model a live **DOM stage** the user can watch and interact with. Backed by a separate Pyodide instance running in a same-origin iframe, the model can launch pygame-ce games, plotly/bokeh/altair interactive plots, folium maps, custom Python animations, or raw HTML dashboards. Persistent session semantics per chat: subsequent `update_tab` calls mutate the running view. On chat switch, the visual state is snapshotted and frozen until explicitly restarted.

## Prerequisites

- Phase 11 (code sandbox) — the workspace reuses the Rust FS/fetch commands (`sandbox_sync_workdir`, `sandbox_save`, `sandbox_delete_in_workdir`, `sandbox_fetch`) and the wheel-bundling pattern (`scripts/fetch-pyodide.sh`).
- An understanding that the chat-side `run_python` worker and the workspace iframe are **two independent Pyodide instances**. They do not share Python state.
- Familiarity with `maintenance.md` sections 4 (tool system), 6 (Tauri command registration — full-module-path rule), 10 (logging), 11 (persistence), 13 (build gates), 14 (ESLint complexity gates).

## Deliverables

- **User-testable**: Ask "render Snake in pygame I can play". Model calls `start_tab_session` → UI auto-switches to the Workspace tab → model calls `update_tab` with the pygame code → game appears, keyboard input works, console pane at the bottom of the tab shows `print()` output live.
- **User-testable**: Ask "plot the last 12 months of S&P 500 closes with plotly so I can hover for values". Model calls `start_tab_session`, fetches data via `pyodide.http.pyfetch` (routed through the proxy-aware bridge), generates a plotly figure, calls `update_tab` with code that injects the figure's HTML into `document.body`. Hovering shows tooltips.
- **User-testable**: Ask "show me an HTML form to collect three numbers and submit them somewhere". Model calls `start_tab_session`, then `update_tab` with `kind='html'` and a raw HTML page. Form is interactive in the iframe.
- **User-testable**: While a pygame game is running, switch to a different chat. The Workspace shows the new chat's last state (empty if it never used the workspace, or its frozen snapshot if it did). Switch back to the game's chat → see the frozen final frame of the game, with a "Restart session" button.
- **User-testable**: First call to `start_tab_session` in a chat prompts "Allow workspace session in this chat?" Subsequent `update_tab` calls in the same chat skip the prompt.

---

## Design Decisions

| Decision                   | Choice                                                                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture               | **Same-origin iframe** with its own Pyodide instance, separate from the chat sandbox worker.                                                                                                                                                                                                                  | pygame's SDL2/Emscripten backend wants a real `document` + `<canvas>` + DOM event listeners. An iframe gives that without polluting the main SvelteKit DOM. Independent Pyodide isolates a crashed game from chat sandbox state. |
| Tool surface               | **Session-scoped**: `start_tab_session`, `update_tab`, `stop_tab_session`. Optionally `clear_tab` and `reset_tab_kernel`.                                                                                                                                                                                     | Explicit lifecycle. `start` boots Pyodide; `update` mutates; `stop` tears down. Model has to plan ahead, which surfaces intent better in the chat transcript.                                                                    |
| Update payload             | `update_tab(content: string, kind: 'python' \| 'html')`.                                                                                                                                                                                                                                                      | Explicit kind avoids autodetect ambiguity. Single content field keeps the schema small.                                                                                                                                          |
| Multi-purpose              | One stage, two content kinds. Both interleavable within a session.                                                                                                                                                                                                                                            | Matches reality of the Pyodide ecosystem — most "interactive" Python libraries either generate HTML or draw to a canvas.                                                                                                         |
| Persistence on chat switch | **Snapshot + freeze.** Capture the iframe's visual state (canvas `toDataURL()` for pygame; `document.body.outerHTML` for HTML) into the chat's history; tear down Pyodide. On return, render the snapshot as a static image/iframe-srcdoc; model must call `start_tab_session` again to resume interactivity. | Cheapest. Avoids surprise CPU on chat switch. No replay logic to maintain. Live programs are explicitly "fresh start" on return.                                                                                                 |
| Filesystem bridge          | **Full parity with `run_python`**: pre-run workdir sync into MEMFS, post-run drain back, `haruspex.save`/`delete` helpers, `pyodide.http.pyfetch` routed through `sandbox_fetch`.                                                                                                                             | pygame needs to load sprites/fonts; plotly may need CSV data; the user already trusts the chat sandbox to read/write workdir.                                                                                                    |
| Stdout/stderr              | **Both** — live console pane at the bottom of the Workspace tab (collapsible, scrolling) AND mirrored into the tool result returned to the model.                                                                                                                                                             | Live console is essential for watching long-running programs (game-loop `print`s). Mirroring to tool result keeps the model informed without polling.                                                                            |
| Bundled wheels             | `pygame-ce`, `plotly`, `bokeh`, `altair` bundled via `scripts/fetch-pyodide.sh` and pre-installed at session start. Other packages on-demand via `install_package_in_tab`.                                                                                                                                    | Covers the headline interactive use cases offline. ~30-40 MB bundle growth (acceptable given the offline-first goal).                                                                                                            |
| Approval                   | **First-call prompt only.** `start_tab_session` prompts once per chat; subsequent `update_tab` calls auto-approve. Separate setting toggle to disable entirely.                                                                                                                                               | The user is approving the _capability_ for the chat, not each rendered frame. Matches the "approve once, iterate" model.                                                                                                         |
| Stop button                | Workspace tab has a "Stop session" button that calls `stop_tab_session` programmatically. Also reset/clear buttons.                                                                                                                                                                                           | Manual escape hatch when a runaway loop wedges the iframe.                                                                                                                                                                       |
| Audio                      | **Best-effort, no special support in v1.** pygame's SDL_mixer may or may not work depending on WebKitGTK's audio stack; document as a known limitation.                                                                                                                                                       | Reduces scope. Visual interactivity is the headline; audio is bonus.                                                                                                                                                             |
| Network                    | Reuse `sandbox_fetch`, including proxy-mode handling.                                                                                                                                                                                                                                                         | Plotly fetches Mapbox tiles, folium fetches OSM tiles, models may fetch datasets. Same proxy story as chat sandbox.                                                                                                              |
| Timeout                    | **No wall-clock timeout** on running programs (they're expected to be long-lived). `update_tab` calls themselves can take up to e.g. 60s before the tool returns; after that the call is killed and reported as timed out, but the session stays alive.                                                       | Different from `run_python`. Pygame loops should not be terminated for "running too long".                                                                                                                                       |
| Interrupt                  | Cooperative interrupt via `SharedArrayBuffer` if available (same as chat sandbox); otherwise terminate-iframe-and-respawn on stop.                                                                                                                                                                            | WebKitGTK Linux likely doesn't have `crossOriginIsolated` flipped → terminate path dominates. Acceptable; a stop is a stop.                                                                                                      |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Frontend (SvelteKit, main thread)                                    │
│  • Tab switcher: [ Chat | Workspace ]                                │
│  • WorkspaceTab.svelte: hosts the iframe, console pane, controls     │
│  • workspace.ts: public API (startSession, update, stop, snapshot)   │
│  • iframe lifecycle manager, message routing, snapshot/freeze        │
└──────────────────────────────────────────────────────────────────────┘
        │ postMessage                                  ▲
        ▼                                              │
┌──────────────────────────────────────────────────────────────────────┐
│ workspace iframe (same-origin, /workspace/index.html)                │
│  • Loads Pyodide                                                     │
│  • Pre-installs pygame-ce + plotly + bokeh + altair from bundled     │
│    wheels in static/pyodide/wheels/                                  │
│  • Exposes the stage: <div id="stage"> spanning the iframe body      │
│  • Python runs in iframe's main thread (so pygame sees real DOM)     │
│  • Captures stdout/stderr → postMessage to parent                    │
│  • Forwards FS/fetch requests via window.__TAURI__.invoke()          │
│    (same Rust commands as the chat sandbox)                          │
└──────────────────────────────────────────────────────────────────────┘
        │ invoke('sandbox_fetch' | 'sandbox_save' | ...)
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Rust Backend (Tauri commands — already exist from Phase 11)          │
│  • sandbox_fetch, sandbox_save, sandbox_delete_in_workdir            │
│  • sandbox_sync_workdir                                              │
└──────────────────────────────────────────────────────────────────────┘
```

**Why iframe + main-thread Python (not a worker):**

The chat sandbox uses a Web Worker because that lets the main thread stay responsive while compute-heavy Python runs. The workspace deliberately runs Python on the **iframe's main thread** because:

1. pygame-ce / SDL2 / Emscripten expect a real `document.getElementById('canvas')` and DOM event listeners. OffscreenCanvas in a worker partially supports this but pygame's event loop wiring expects synchronous access to `document`.
2. Plotly / bokeh / altair generate HTML+JS that needs to be injected into a DOM, and their interactivity hooks expect to run in the same global as the DOM they wrote.
3. The iframe is _already_ isolated from the main SvelteKit thread — it has its own event loop, its own crash domain, its own memory. So putting Python on its main thread doesn't block the chat UI.

The Python `time.sleep(...)` will block the iframe's event loop. Game-loop code must use `await asyncio.sleep(0)` to yield. We document this in the `run_in_tab` tool description.

---

## Tools (model-facing)

Tool registration uses the standard patterns from `maintenance.md` §4 — `category: 'sandbox'` (gated by the existing `settings.sandboxEnabled` toggle; we're not adding a fourth setting), `labelArg()` for `displayLabel` where applicable, `toolInvokeError()` for failure paths, side-effect import added to `tools/index.ts`.

### `start_tab_session`

```typescript
{
  type: 'function',
  function: {
    name: 'start_tab_session',
    description: 'Open the Workspace tab and boot a Python+HTML rendering session. Loads pygame-ce, plotly, bokeh, altair, matplotlib pre-installed. Subsequent update_tab calls share Python state. Only one session per chat at a time; calling again resets the existing session. The user is prompted for approval on first call per chat.',
    parameters: { type: 'object', properties: {} }
  }
}
```

Result: `{ status: 'started' | 'already_running', notes: string[] }`. Failure on user denial.

### `update_tab`

```typescript
{
  type: 'function',
  function: {
    name: 'update_tab',
    description: 'Push content into the active workspace session. kind="python" runs Python in the iframe (top-level await supported; for game loops use `await asyncio.sleep(0)` to yield between frames — `time.sleep` will freeze the iframe). kind="html" replaces the stage with raw HTML. Both kinds can be interleaved; Python state persists across kind="python" calls. To render plotly/bokeh/altair: in Python, generate the figure HTML and inject via `js.document.getElementById("stage").innerHTML = fig_html`.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Python source OR raw HTML, depending on kind.' },
        kind:    { type: 'string', enum: ['python', 'html'], description: 'How to interpret content.' }
      },
      required: ['content', 'kind']
    }
  }
}
```

Result mirrors `run_python` shape: `{ stdout, stderr, result, error, duration_ms }`. No `artifacts` field — the artifacts ARE the live tab, not return values.

### `stop_tab_session`

```typescript
{
  type: 'function',
  function: {
    name: 'stop_tab_session',
    description: 'Tear down the workspace session: kill the iframe and Pyodide. Does not switch tabs. Use when the user has asked to end the visualization, or before starting an unrelated new session.',
    parameters: { type: 'object', properties: {} }
  }
}
```

### `install_package_in_tab`

```typescript
{
  type: 'function',
  function: {
    name: 'install_package_in_tab',
    description: 'Install a Python package into the workspace iframe via micropip. Pygame-ce, plotly, bokeh, altair, matplotlib are pre-installed — do not reinstall. Use for folium, pyvis, sympy, etc.',
    parameters: {
      type: 'object',
      properties: {
        package: { type: 'string' }
      },
      required: ['package']
    }
  }
}
```

(Deliberately split from the chat-sandbox `install_package` — different Pyodide instance, different state.)

---

## Iframe ↔ Parent Protocol

### Parent → iframe

```typescript
type ParentToIframe =
	| { kind: 'init'; workdirAbs: string | null; proxyMode: string; bundledWheelsUrl: string }
	| { kind: 'run'; id: string; content: string; contentKind: 'python' | 'html' }
	| { kind: 'install'; id: string; package: string }
	| { kind: 'stop' }
	| { kind: 'capture_snapshot'; request_id: string };
```

### Iframe → parent

```typescript
type IframeToParent =
	| { kind: 'ready' }
	| { kind: 'load_error'; error: string }
	| { kind: 'stdout'; id: string; data: string }
	| { kind: 'stderr'; id: string; data: string }
	| {
			kind: 'done';
			id: string;
			result: {
				stdout: string;
				stderr: string;
				result: string;
				error: string | null;
				duration_ms: number;
			};
	  }
	| { kind: 'snapshot'; request_id: string; mime: 'image/png' | 'text/html'; payload: string };
```

The iframe handles its own Tauri `invoke` calls for FS and fetch (those don't need to round-trip through the parent). This is verified to work in Tauri 2.x because `window.__TAURI_INTERNALS__` is injected into all same-origin frames.

### `kind='html'` flow

Parent sends `{ kind: 'run', content: '<...>', contentKind: 'html' }`. Iframe replaces the stage:

```javascript
document.getElementById('stage').innerHTML = content;
```

Any `<script>` tags inside `content` are extracted and re-executed via `new Function(...)()` so HTML+JS dashboards work. Style is not stripped.

### `kind='python'` flow

Parent sends `{ kind: 'run', content: 'import pygame\n...', contentKind: 'python' }`. Iframe calls `pyodide.runPythonAsync(content)`, capturing stdout/stderr via the same `setStdout(batched:...)` pattern as the chat sandbox worker. Errors bubble back as `done` with `error: traceback`.

---

## Filesystem Bridge

Reused wholesale from Phase 11. The iframe's Python init script installs `haruspex.save`, `haruspex.delete`, and patches `pyodide.http.pyfetch` exactly like the chat sandbox worker does. The differences are:

- **Sync timing**: On `start_tab_session`, the parent invokes `sandbox_sync_workdir` and posts the file list to the iframe in the `init` message. Subsequent `update_tab` calls trigger an incremental re-sync (post-message-driven, same as `WorkerManager.syncWorkdir`).
- **Drain timing**: After every `kind='python'` run, the iframe calls `_haruspex_drain_pending_saves()` as the chat sandbox does, mirroring MEMFS changes back to host.
- **Long-running programs**: For pygame loops, the drain runs only on session stop or explicit `clear_tab`. Mid-loop writes via `haruspex.save` still propagate immediately because they go through the explicit JS bridge.

This is a deliberate choice: a long-running game shouldn't pay drain cost every frame.

---

## Snapshot + Freeze (chat switch behavior)

When the active chat changes while a workspace session exists:

1. Parent posts `{ kind: 'capture_snapshot' }` to the iframe.
2. Iframe inspects its stage:
   - If a `<canvas>` is the dominant child (pygame, py5, etc.) → `canvas.toDataURL('image/png')`, post back as `mime='image/png'`.
   - Otherwise → `document.body.outerHTML`, post back as `mime='text/html'`.
3. Parent stores the snapshot in the chat's persistence (alongside chat messages — new field on the conversation).
4. Parent tears down the iframe (`<iframe>.remove()`).
5. New chat is loaded. If it has a stored snapshot, the workspace tab renders it as a static image (for canvas snapshots) or as an `iframe srcdoc` with scripts disabled (for HTML — to avoid re-executing untrusted JS without explicit user opt-in).
6. A "Restart session" button is shown over the snapshot. Clicking it (or any model call to `start_tab_session` on this chat) tears down the snapshot and boots a fresh iframe.

Per-chat persistence schema addition (per `maintenance.md` §11, this routes through `db.ts` — a new persistent record on the conversation):

```typescript
interface Conversation {
	// ...existing fields...
	workspaceSnapshot?: {
		mime: 'image/png' | 'text/html';
		payload: string; // data URL for png, raw HTML string for html
		capturedAt: number;
	};
	workspaceApproved?: boolean; // analogous to sandboxApproved (in-memory store, not persisted)
}
```

Concretely: `workspaceSnapshot` becomes a new TEXT column on the `conversations` table (or its own row in a `conversation_meta` table — pick whichever fits the existing `db.ts` shape). `workspaceApproved` stays on the `Conversation` runes-store record only, same as `sandboxApproved`.

---

## UI Integration

### Tab switcher

Add to `+page.svelte`: a two-tab bar at the top of the main pane (`[Chat] [Workspace]`). Default tab is `Chat`. When a workspace session starts (model called `start_tab_session`), auto-switch to `Workspace` once per session — don't repeatedly steal focus on every `update_tab`. A small "●" indicator on the Chat tab when a workspace session is active.

### Workspace tab layout

```
┌──────────────────────────────────────────────────────────┐
│ Workspace                                                │
│ ┌──────────────────────────────────────────────────────┐ │
│ │                                                      │ │
│ │            iframe (the stage)                        │ │
│ │            grows to fill available space             │ │
│ │                                                      │ │
│ └──────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ Console (collapsible, default open, max-height ~30%) │ │
│ │ > game started                                       │ │
│ │ > frame 0                                            │ │
│ └──────────────────────────────────────────────────────┘ │
│ [ Stop session ] [ Clear stage ] [ Reset kernel ]        │
└──────────────────────────────────────────────────────────┘
```

When no session is running: the iframe area shows a placeholder ("The model can render Python or HTML here. It will start a session when needed.") and the controls are hidden except for one "Snapshot (none)" hint if there's a stored snapshot.

### New components

- `src/lib/components/WorkspaceTab.svelte` — the entire tab body (iframe + console + controls).
- `src/lib/components/WorkspaceConsole.svelte` — the stdout/stderr log pane, virtualized if log lines exceed a cap (e.g. 5000 lines, oldest evicted).
- A tab switcher inside `+page.svelte` (probably inline rather than a separate component).

Any approval-confirmation dialog reuses `Modal.svelte` + `ModalButton.svelte` per `maintenance.md` §9. Do not hand-roll a backdrop / focus trap.

---

## File Structure

```
src/lib/workspace/
  protocol.ts           # ParentToIframe / IframeToParent types (analog of sandbox/protocol.ts)
  iframe-manager.ts     # lifecycle: create iframe, init, run, stop, snapshot (analog of worker-manager.ts)
  workspace.ts          # public API surface (startSession, update, stop, snapshot)
  workspace.test.ts

src/lib/agent/tools/
  workspace.ts          # registers start_tab_session, update_tab, stop_tab_session, install_package_in_tab

src/lib/components/
  WorkspaceTab.svelte
  WorkspaceConsole.svelte

static/workspace/
  index.html            # iframe entry — loads Pyodide, sets up message router
  init.py               # Python init script (separated for readability; baked into JS at build time or fetched)

static/pyodide/wheels/   # existing dir; add:
  pygame_ce-*.whl
  plotly-*.whl
  bokeh-*.whl
  altair-*.whl
  (transitive pure-Python deps)

scripts/fetch-pyodide.sh # extend to download the new wheels
```

---

## Implementation Steps

### Step 1 — Spike: pygame in a Tauri iframe (1 day)

Goal: prove the basic mechanism works before committing to the larger build.

- Hand-roll a static `static/workspace/index.html` with inline Pyodide loader.
- Load `pygame-ce` from CDN at runtime (skip bundling for the spike).
- Run a hardcoded "moving circle" pygame demo.
- Load it directly via a temporary route `/workspace/spike` and confirm:
  - Pygame renders to canvas.
  - Keyboard / mouse events reach Python.
  - `window.__TAURI_INTERNALS__.invoke('sandbox_fetch', ...)` works from inside the iframe.

If pygame doesn't render or events don't reach Python on WebKitGTK Linux, escalate before doing the rest of the plan. Possible escapes:

- Try a different SDL backend if pygame-ce offers one.
- Fall back to a Python-canvas drawing helper that wraps `pyodide`'s `js.document` directly (less ergonomic for the model but reliable).
- Reconsider the OffscreenCanvas-in-worker path.

### Step 2 — Bundle the wheels (half day)

- Identify exact wheel filenames + pure-Python transitive deps for `pygame-ce`, `plotly`, `bokeh`, `altair`.
- Add them to `scripts/fetch-pyodide.sh`.
- Confirm wheel sizes; if total bundle > ~50 MB, reconsider what to bundle.
- Test offline install in the spike iframe.

### Step 3 — Iframe protocol + manager (1-2 days)

- Write `src/lib/workspace/protocol.ts` modeled on `sandbox/protocol.ts`.
- Write `src/lib/workspace/iframe-manager.ts`: creates the iframe, posts `init`, queues `run` calls, routes responses. Handles stdout/stderr streaming, stop/teardown, snapshot capture. Use `logDebug('workspace', ...)` per `maintenance.md` §10 (don't reach for `console.*`).
- Write `static/workspace/index.html` + iframe-side runtime: Pyodide load, message router, `pyodide.runPythonAsync` for `kind='python'`, DOM injection for `kind='html'`.
- Unit-test the manager with a mocked iframe factory (analog of the existing `WorkerManager` test pattern).

### Step 4 — Reuse FS bridge in iframe (1 day)

- Port the Python init script's `haruspex` module, `pyodide.http.pyfetch` override, MEMFS drain logic from `python.worker.ts` to the iframe. Keep them in `static/workspace/init.py` as a separate file (or inline string) — they're mostly identical.
- Confirm `invoke` calls from the iframe land on the existing Rust commands. Watch for any `getWorkingDir()` indirection that assumes main-thread context.

### Step 5 — Tools (half day)

- Write `src/lib/agent/tools/workspace.ts` registering the four tools.
- Wire up approval prompt: reuse the `askApproval` flow but gate on a separate `workspaceApproved` chat field.
- Hook `start_tab_session` to also auto-switch the active tab to "Workspace" the first time per session.

### Step 6 — UI integration (1-2 days)

- Tab switcher in `+page.svelte`.
- `WorkspaceTab.svelte` hosting iframe + console + controls.
- `WorkspaceConsole.svelte` with virtualized log lines.
- Hide/show iframe based on tab visibility (use `visibility: hidden` rather than unmount, so the running game doesn't get reaped by a tab switch within the same chat).

### Step 7 — Snapshot + freeze (1 day)

- Add `workspaceSnapshot` to the conversation persistence schema.
- On active-conversation change in the store, post `capture_snapshot` to the running iframe (if any), await the result, store it, then tear down.
- On loading a conversation with a stored snapshot: render it as a static image or sandboxed `<iframe sandbox="">`. Show "Restart session" affordance.

### Step 8 — Polish + system prompt (half day)

- Lean addition to `src/lib/agent/system-prompt.ts` describing the workspace tools — one or two sentences. Per the [[feedback_lean_system_prompts]] note: don't enumerate edge cases here; the tool descriptions carry the load.
- Tests: end-to-end through the manager with mocked Pyodide; integration test that exercises tab switching + snapshot store/restore.
- Docs: short README section + a one-line addition to `maintenance.md` §1 (repo layout) under `src/lib/` and `static/`.

### Step 9 — Build gates + commit hygiene (per-commit, not a phase)

Run the full matrix from `maintenance.md` §13 before each commit:

```bash
npm run format
npm run check
npm run lint
npm run test
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Conventional Commits scope: `feat(workspace): …` for new functionality, `refactor(workspace): …` for follow-up cleanups. The pre-commit hook runs `npm run format:check`; run `npm run format` before staging.

**Total estimate**: 6-9 days of focused work, weighted heavily toward step 1 (the spike) and step 3 (the manager). If step 1 reveals pygame doesn't work on WebKitGTK, scope shrinks to HTML + non-pygame Python (plotly etc.) — still useful.

---

## Risks & Open Questions

- **pygame-ce on WebKitGTK** — unverified. The spike in step 1 is the gate. If it fails, the plan still has value for plotly/HTML/bokeh use cases; pygame would be deferred or scoped down.
- **Tauri `invoke` from iframe** — believed to work in Tauri 2.x (same-origin, `__TAURI_INTERNALS__` injected) but unverified for _child iframes specifically_. Verify in step 1. If it doesn't work, fall back to bridging via parent `postMessage` → parent `invoke` → `postMessage` back.
- **Audio** — pygame's SDL_mixer relies on the browser's audio context. WebKitGTK audio is historically fragile. Document as known limitation; revisit if users ask.
- **Memory growth** — two Pyodide instances (chat sandbox + workspace) each cost ~50-100 MB resident. Acceptable on modern hardware but worth tracking.
- **Snapshot fidelity for HTML mode** — `outerHTML` of an iframe body misses canvas state, video positions, scroll position. Acceptable for v1 (it's a snapshot, not a state save) but document.
- **Crash recovery** — if the iframe crashes (OOM in pygame, etc.), we should detect via `error` event on the iframe element and surface "Workspace crashed; restart?" to the user.
- **No replay** — by design. If the user wants a chat-A pygame game back, they explicitly restart. Document this so it's not surprising.

### ESLint complexity ceilings (`maintenance.md` §14)

The new code will brush against the warn-level rules. Plan for it:

- `iframe-manager.ts` is a near-clone of `worker-manager.ts` (currently 490 LOC, already in the exemption list). Expect this to land at ~400-500 LOC. **Goal**: keep it under 400 if possible by extracting (a) message dispatch, (b) snapshot capture, (c) FS bridge handlers into separate files. If it ends up exempted, justify in the PR description.
- `static/workspace/init.py` mirrors a chunk of `python.worker.ts` (846 LOC, exempted). It's Python so ESLint doesn't gate it, but keep it tractable.
- `WorkspaceTab.svelte` is markup-heavy → exempted by file type. Still aim for <400 LOC.
- New functions stay under 80 LOC. The protocol dispatch in `iframe-manager.ts` is the highest risk for a fat function — split it into per-`kind` handlers from the start.
- Do not regress already-warning files. `+page.svelte` (662 LOC) gets the tab switcher; add it carefully and consider whether the switcher becomes its own component if it grows past ~30 LOC.

### No new Rust commands

This plan deliberately reuses the existing `sandbox_*` Tauri commands. If anything forces us to add a new one (e.g. a workspace-specific FS scope), follow `maintenance.md` §6: register it via the full module path in `generate_handler!`. Don't add a `pub use` re-export — the macro can't see through it.
