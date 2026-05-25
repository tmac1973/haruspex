# Phase 13: Unified Python Sandbox + Workspace Tab

## Goal

Merge the existing chat-side `run_python` sandbox and the proposed standalone "workspace" interactive tab into **one** Python runtime backed by a single Pyodide instance per chat, running in a same-origin iframe. The model sees one Python tool. Pure-compute use cases (math, parsing, document generation, matplotlib screenshots) keep working exactly as today, with output rendered inline in the chat. Interactive use cases (pygame games, plotly figures, raw HTML dashboards, folium maps, custom animations) light up the Workspace tab automatically when the model writes to the iframe stage. No model-facing routing decision — the model just runs Python.

### Why we are rewriting the original phase 13 plan

The original phase 13 (now superseded by this document) introduced a **second** Pyodide instance and a parallel set of tools (`start_tab_session`, `update_tab`, `stop_tab_session`, `install_package_in_tab`). The implementation attempt revealed that the model could not reliably choose between `run_python` and `update_tab`: it would try to run pygame in the headless worker, attempt interactive plotly with `run_python`, or call `update_tab` for plain math. The split was a tool-selection failure mode. This plan collapses everything into one Python surface; the tab is a passive display, not a separate sandbox.

## Prerequisites

- Phase 11 (code sandbox) — we reuse the Rust FS/fetch commands (`sandbox_sync_workdir`, `sandbox_save`, `sandbox_delete_in_workdir`, `sandbox_fetch`) and the wheel-bundling pattern (`scripts/fetch-pyodide.sh`).
- Familiarity with `maintenance.md` sections 4 (tool system), 6 (Tauri command registration), 10 (logging), 11 (persistence), 13 (build gates), 14 (ESLint complexity gates).
- Understanding that this plan **replaces** the existing Web Worker-based sandbox (`src/lib/sandbox/python.worker.ts` + `worker-manager.ts`) with an iframe-hosted Pyodide. The protocol shape (artifacts, fetch bridge, FS bridge, sync) is preserved; the transport changes from `Worker.postMessage` to `iframe.contentWindow.postMessage`.

## Deliverables

- **User-testable**: Ask "compute the mean of [1,2,3,4]". Model calls `run_python(code='import statistics; print(statistics.mean([1,2,3,4]))')` → tool returns `2.5` exactly as today. Workspace tab stays empty; Chat tab stays focused.
- **User-testable**: Ask "render Snake in pygame I can play". Model calls `run_python` with pygame code wrapped in `asyncio.ensure_future(game())`. Tab auto-switches to Workspace on first canvas write; keyboard input works; the tool call returns to the model promptly (the game runs as a detached task).
- **User-testable**: Ask "plot the last 12 months of S&P 500 closes with plotly so I can hover for values". Model calls `run_python` once: fetch data via `pyodide.http.pyfetch`, generate the plotly figure, call `haruspex.show_html(fig.to_html(include_plotlyjs='cdn'))`. Hovering shows tooltips in the Workspace tab.
- **User-testable**: Ask "show me an HTML form to collect three numbers". Model calls `run_python` with a one-liner that calls `haruspex.show_html("<form>…</form>")`. Form is interactive in the iframe.
- **User-testable**: Switch to a different chat while a pygame game is running. The game keeps running in the background (up to LRU cap of 3 iframes). Switch back → same game, same state. Switch to a 4th chat → the LRU-evicted chat's stage is snapshotted, iframe destroyed; returning to it shows the frozen snapshot with a "Resume session" affordance.
- **User-testable**: Matplotlib `plt.show()` still renders the figure inline in the **chat** message (not the workspace), exactly as today.
- **User-testable**: A pandas DataFrame as the last expression still renders inline in chat as today.

---

## Design Decisions (locked-in via Q&A)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Tool surface | **One tool**: `run_python(code)` (+ `install_package`, `reset_python`). All visual output is a side effect of running Python. | Removes the tool-selection failure mode that broke the original phase 13. The model can never pick wrong because there is only one Python tool. |
| Runtime | **One Pyodide instance, hosted in a same-origin iframe**, on the iframe's main thread. **Per chat**. | pygame-ce / SDL / Emscripten need a real `document` + canvas + DOM event listeners. Plotly/bokeh/altair generate HTML+JS that must run in the same global as the DOM they write. An iframe gives that without polluting the main SvelteKit DOM, and the iframe is already isolated from the main thread so heavy Python doesn't freeze the chat UI. |
| Long-running code | **Model wraps in `asyncio.ensure_future(...)`** to detach. Tool returns when the submitted top-level code completes. | Idiomatic Python. The tool runtime stays simple (no timeout-to-detach state machine). A pygame game looks like: `task = asyncio.ensure_future(run_game())` — top-level finishes instantly, tool returns, game keeps running. We document this in the `run_python` description and add a one-line example. |
| Tab visibility | **Tab bar always visible** (`[Chat \| Workspace]`). Auto-switch to Workspace **the first time the stage receives content** in a chat turn; subsequent writes in the same turn don't re-steal focus. Indicator dot on the Workspace tab when stage has fresh content the user hasn't viewed. | Discoverable, minimally jarring. The user can always click back to Chat. |
| HTML rendering surface | **`haruspex.show_html(html)` helper module function**, plus `haruspex.clear_stage()`. Raw `js.document` access remains available as an escape hatch but is not the documented path. | Discoverable via `dir(haruspex)`; the helper centralizes `<script>` re-execution so dashboard HTML works without each model having to remember to handle script tags manually. |
| Bundled wheels | **pygame-ce + bokeh + altair** (in Pyodide 0.29.4's lockfile — bundle their wheels + transitive deps at `static/pyodide/` root, resolve via `loadPackage` with `indexURL='/pyodide/'`). **Plotly is not in the lockfile**, so it defers to `install_package` on first use (one PyPI roundtrip per chat, then cached). Plus the existing fpdf2 / python-pptx / xlsxwriter / defusedxml / fonttools. ~30 MB net bundle growth. | Lockfile-resident packages bundle for ~zero ergonomic cost. Plotly out-of-lockfile would require a PyPI snapshot or a built wheel, which is more maintenance burden than the offline-first benefit justifies. |
| Chat-switch behavior | **Persistent per-chat iframes**, LRU cap of 3. Active chat's iframe stays alive; on switch, the previous chat's iframe stays hidden (`visibility: hidden`) but running. When a 4th chat becomes active, the least-recently-used iframe is **evicted**: capture stage snapshot, store with conversation, destroy iframe. Returning to an evicted chat: boot fresh iframe, render snapshot statically with "Resume session" button, replay history on demand. | Best UX for "ask follow-up after switching back" without keeping ten Pyodide instances live. The LRU also bounds memory growth to ~3 × 50–100 MB. |
| Aux tools | **None beyond `reset_python`**. Stage clearing, task cancellation, etc. happen via the `haruspex` Python helper module (`haruspex.clear_stage()`, `haruspex.stop_tasks()`). | Keeps the model-facing tool surface narrow. Reset is the only kill-switch the model needs at the tool level. |
| Approval | **Unchanged from today**. The existing `sandboxApproval` setting (`every-run` / `once-per-chat` / `off`) and per-chat `sandboxApproved` flag cover everything; one approval per chat governs all Python (compute OR visual). No separate workspace approval. | Unification's main benefit — one trust boundary. |
| Stdout/stderr | **Both inline-in-chat (existing artifact UI) AND a live console pane in the Workspace tab.** For long-running tasks, the console keeps streaming after the tool call returns. | Pure-compute outputs stay where they are today. Long-running task `print()`s need somewhere to land — they can't go back into a tool result that already returned. The console pane is the answer. |
| Network | Reuse `sandbox_fetch` exactly as today. Proxy-mode aware (manual proxy gates urllib patch off). | No-op change. |
| Timeout | **Per-call configurable** (current `sandboxTimeoutSeconds` setting, default 30s). Applies to the submitted code's top-level execution. Background tasks the model detached are **not subject** to this timeout — they live until the iframe is reset. | Preserves today's safety net for compute; doesn't strangle game loops. |
| Interrupt | Cooperative interrupt via `SharedArrayBuffer` if `crossOriginIsolated` is true; otherwise terminate-iframe-and-respawn (matches today's worker behavior). | No regression vs. today; same `SAB`-only-on-macOS/Windows posture. |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Frontend (SvelteKit, main thread)                                    │
│  • Tab switcher: [ Chat | Workspace ]                                │
│  • +page.svelte: hosts both tabs; conditional visibility             │
│  • WorkspaceTab.svelte: shows iframe + console + controls            │
│  • IframeManager (replaces WorkerManager):                           │
│      - one iframe per chat, LRU-capped at 3                          │
│      - lifecycle: spawn, hide/show on switch, snapshot, evict        │
│      - message routing                                               │
│      - FS-bridge / fetch-bridge / save-bridge / sync-bridge          │
└──────────────────────────────────────────────────────────────────────┘
        │ postMessage                                  ▲
        ▼                                              │
┌──────────────────────────────────────────────────────────────────────┐
│ Workspace iframe (one per chat, same-origin, /workspace/index.html)  │
│  • Loads Pyodide                                                     │
│  • Pre-installs (offline): fpdf2, python-pptx, xlsxwriter,           │
│    pygame-ce, bokeh, altair. Plotly: install_package on demand.      │
│  • Exposes:                                                          │
│      - <div id="stage"> — visible canvas / HTML region               │
│      - haruspex.show_html / clear_stage / stop_tasks (Python helpers)│
│      - matplotlib plt.show capture → inline-chat artifact            │
│      - DataFrame _repr_html_ → inline-chat artifact                  │
│      - haruspex.save / delete (FS bridge to host)                    │
│      - pyodide.http.pyfetch override (routed through sandbox_fetch)  │
│  • Python runs in iframe's main thread (real DOM access)             │
│  • Captures stdout/stderr → postMessage to parent (live)             │
└──────────────────────────────────────────────────────────────────────┘
        │ invoke('sandbox_fetch' | 'sandbox_save' | ...)
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Rust Backend (Tauri commands — unchanged from Phase 11)              │
│  • sandbox_fetch, sandbox_save, sandbox_delete_in_workdir            │
│  • sandbox_sync_workdir                                              │
└──────────────────────────────────────────────────────────────────────┘
```

**Why iframe main thread, not a worker**:

The Web Worker has no `document`, no canvas, no DOM event listeners. pygame-ce / SDL2 / Emscripten require all three. Plotly / bokeh / altair generate HTML+JS that needs to run in the global it was injected into. The iframe is **already** isolated from the main SvelteKit thread — it has its own event loop, its own crash domain, its own memory — so putting Python on the iframe's main thread does not block the chat UI.

The trade-off: a synchronous `time.sleep(5)` in Python blocks the iframe's own event loop, which means a concurrently-running pygame loop will drop frames during that sleep. Documented in the tool description and in the `haruspex` module docstring; game-loop code uses `await asyncio.sleep(0)` instead.

### Load-bearing facts from the prior spike (Tauri 2.x / WebKitGTK)

These are not assumptions; they were verified on the prior `feat/phase-13-workspace-tab` branch and must be honored by this implementation:

1. **`window.__TAURI_INTERNALS__` is NOT injected into child iframes**. It exists in the parent window but not in the iframe's `contentWindow`. The iframe therefore CANNOT call `invoke('sandbox_fetch', ...)` directly. All Rust-Tauri calls (`sandbox_fetch`, `sandbox_save`, `sandbox_delete_in_workdir`, `sandbox_sync_workdir`) must be **routed through the parent** via `postMessage`: iframe asks → parent invokes Rust → parent posts response back. This is the same shape as today's worker bridge — the protocol's `fetch_request`/`fetch_response`/`save_request`/`save_response`/`delete_request`/`delete_response`/`sync_workdir_files`/`sync_workdir_ack` pairs carry over unchanged.
2. **`pyodide.canvas.setCanvas2D(canvasEl)` MUST be called before `pygame.init()`**. SDL2 looks at Emscripten's `Module.canvas` to find where to draw. Without this call, `pygame.display.set_mode()` raises `SDL2.ctx is undefined` inside SDL_image's `createImageData`. The init script provisions a `<canvas id="canvas">` inside the stage and calls `pyodide.canvas.setCanvas2D` at boot, so user code can call `pygame.init()` freely.
3. **Iframe-side canvas needs `tabindex` and explicit focus** to receive keyboard events. The init script gives the canvas `tabindex="0"` and focuses it the first time pygame draws.
4. **Pyodide 0.29.4 lockfile** ships `pygame-ce`, `bokeh`, `altair`, plus matplotlib/numpy/pandas/etc. as already-built Pyodide wheels. We drop their `.whl` files at `static/pyodide/` root (not in `wheels/`) and load via `pyodide.loadPackage(['pygame-ce', 'bokeh', 'altair'])` with `indexURL='/pyodide/'`. Loads in ~160ms vs ~3+s for PyPI install.

---

## Tool Surface (model-facing)

Three tools total. Tool registration uses the standard patterns from `maintenance.md` §4 — `category: 'sandbox'` (gated by existing `settings.sandboxEnabled`), `labelArg()` where applicable, `toolInvokeError()` for failure paths, side-effect import in `tools/index.ts`.

### `run_python`

```typescript
{
  type: 'function',
  function: {
    name: 'run_python',
    description:
      'Execute Python code in a persistent sandbox running in this app. Variables, imports, and installed packages persist across calls in the current chat. Use this for math, data analysis, parsing, plotting, document creation (PDFs via fpdf2, PowerPoints via python-pptx), or interactive content (pygame games, plotly/bokeh/altair figures, HTML dashboards). Top-level await is supported. ' +
      'OUTPUT CHANNELS: ' +
      '(1) Inline-in-chat: matplotlib `plt.show()`, a pandas DataFrame as the last expression, and any value with `_repr_html_` are rendered as artifacts in the chat message. ' +
      '(2) Workspace tab: import `haruspex` and call `haruspex.show_html(html_string)` to render interactive HTML (e.g. plotly: `haruspex.show_html(fig.to_html(include_plotlyjs="cdn"))`). pygame draws to a canvas inside the workspace tab automatically. ' +
      'LONG-RUNNING CODE: for game loops, animations, or anything that runs indefinitely, wrap in `asyncio.ensure_future`: ```python\nasync def game(): ...\ntask = asyncio.ensure_future(game())``` — the tool call returns immediately, the task keeps running in the background, and the next `run_python` call shares the same Python state (you can cancel via `task.cancel()` or call `haruspex.stop_tasks()`). Do NOT use `while True:` at the top level without yielding or detaching; it will hang the tool. ' +
      'Bundled offline: matplotlib, numpy, pandas, scipy, scikit-learn, sympy, pillow, beautifulsoup4 (Pyodide built-ins), plus fpdf2, python-pptx, xlsxwriter, pygame-ce, bokeh, altair. Plotly and other PyPI packages: `install_package` first (downloads once, then cached).',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Python source to execute. Multiple statements are fine. Top-level await supported.'
        }
      },
      required: ['code']
    }
  }
}
```

Result mirrors today's `ToolResult`: `{ stdout, stderr, result, error, artifacts, artifactsList, notes, duration_ms }`. Workspace stage content is **not** in the tool result — it's the live tab, and the model is told (via tool description) to assume the user can see it.

### `install_package`

```typescript
{
  type: 'function',
  function: {
    name: 'install_package',
    description:
      'Install a Python package into the sandbox via micropip. Pre-built Pyodide packages (numpy, pandas, matplotlib, scipy, scikit-learn, sympy, pillow, beautifulsoup4) work out of the box. Pure-Python wheels from PyPI also work; packages with C extensions that have not been pre-built for Pyodide will fail. Pre-installed: fpdf2, python-pptx, xlsxwriter, pygame-ce, bokeh, altair — do not reinstall. Plotly is NOT pre-installed (not in Pyodide lockfile); use install_package(\'plotly\') first. Installs persist for the current chat.',
    parameters: {
      type: 'object',
      properties: {
        package: { type: 'string', description: "Package name, optionally with a version: 'folium' or 'folium==0.15.0'." }
      },
      required: ['package']
    }
  }
}
```

### `reset_python`

```typescript
{
  type: 'function',
  function: {
    name: 'reset_python',
    description:
      'Wipe the Python sandbox for the current chat: tear down the iframe, kill all background tasks, clear all variables/imports/installed packages, clear the workspace stage. Use after poisoned state (hung import, runaway loop, irrecoverable error) or to stop a long-running interactive session. Does not affect chat history.',
    parameters: { type: 'object', properties: {} }
  }
}
```

### Removed from the original phase-13 plan

- `start_tab_session` — implicit; `run_python` boots the iframe lazily on first call per chat.
- `update_tab` — folded into `run_python`. `kind='python'` → just write Python. `kind='html'` → `haruspex.show_html(...)`.
- `stop_tab_session` — covered by `reset_python` and `haruspex.stop_tasks()`.
- `install_package_in_tab` — there is no separate tab sandbox; `install_package` covers everything.

---

## Python-side helper module

Extends the existing `haruspex` module (today: `save`, `delete`) with three new functions. Lives in the iframe's init script, replacing the equivalent block in today's worker.

```python
async def save(filename, content):  # unchanged
async def delete(filename):  # unchanged

def show_html(html):
    """Replace the workspace stage with raw HTML.

    Re-executes any <script> tags inside `html` so plotly / bokeh / altair
    dashboard HTML works as expected. Auto-switches the user's view to
    the Workspace tab the first time the stage is written in a turn.
    """

def clear_stage():
    """Empty the workspace stage (remove canvas, child elements, listeners)."""

def stop_tasks():
    """Cancel every asyncio task launched from prior run_python calls in
    this chat. Use to stop a pygame loop or animation without resetting
    the whole sandbox."""
```

Internally `show_html` posts a `stage_write` message to the parent so the tab manager can update its "has-content" state for auto-switching. `clear_stage` posts a `stage_clear` message. `stop_tasks` enumerates the asyncio task registry the iframe maintains for tasks launched via `asyncio.ensure_future` and cancels them.

---

## Iframe ↔ Parent Protocol

The protocol is a rebrand of the existing `MainToWorker` / `WorkerToMain` types. Names and field shapes carry over directly except for the additions for stage events.

### Parent → Iframe (`MainToIframe`)

```typescript
type MainToIframe =
  | { kind: 'set_interrupt_buffer'; buffer: SharedArrayBuffer }
  | { kind: 'proxy_mode'; mode: string; workingDirSet: boolean }
  | { kind: 'sync_workdir_files'; sync_id: string; workdir_abs: string;
      to_sync: SyncFile[]; deleted: string[]; skipped: SyncSkipped[] }
  | { kind: 'run'; id: string; code: string }
  | { kind: 'install'; id: string; package: string }
  | { kind: 'reset'; id: string }
  | { kind: 'interrupt'; id: string }
  | { kind: 'capture_snapshot'; request_id: string }
  | { kind: 'restore_snapshot'; mime: 'image/png' | 'text/html'; payload: string }
  | { kind: 'fetch_response'; ... }     // same as today
  | { kind: 'save_response'; ... }      // same as today
  | { kind: 'delete_response'; ... };   // same as today
```

### Iframe → Parent (`IframeToMain`)

```typescript
type IframeToMain =
  | { kind: 'ready' }
  | { kind: 'load_error'; error: string }
  | { kind: 'get_proxy_mode' }
  | { kind: 'sync_workdir_ack'; sync_id: string; error?: string }
  | { kind: 'stdout'; id: string; data: string }     // includes "post-return" output from detached tasks (id stays the same as the call that launched the task)
  | { kind: 'stderr'; id: string; data: string }
  | { kind: 'artifact'; ... }       // same as today — matplotlib / dataframe inline-in-chat
  | { kind: 'stage_write' }         // new: stage just received content (triggers auto-switch & indicator)
  | { kind: 'stage_clear' }         // new: stage was emptied
  | { kind: 'install_progress'; id: string; package: string; phase: InstallPhase }
  | { kind: 'done'; id: string; result: ToolResult }
  | { kind: 'snapshot'; request_id: string; mime: 'image/png' | 'text/html'; payload: string }
  | { kind: 'fetch_request'; ... }
  | { kind: 'save_request'; ... }
  | { kind: 'delete_request'; ... };
```

Note `IframeToMain.stage_write` is also emitted by the MutationObserver running inside the iframe — covers cases where pygame's Emscripten layer appends a canvas to `document.body` outside of `haruspex.show_html`.

---

## Filesystem Bridge

Reused wholesale from Phase 11. The iframe's Python init script installs `haruspex.save`, `haruspex.delete`, and the `pyodide.http.pyfetch` override exactly like today's worker. The pre-run workdir sync (`sandbox_sync_workdir`) and post-run drain logic move into the iframe unchanged.

One small change: long-running background tasks. The drain runs after each `pyodide.runPythonAsync(submitted_code)` finishes. If the submitted code only kicks off `asyncio.ensure_future(...)`, the drain runs immediately when the synchronous top-level completes — that's fine; nothing was written yet. Subsequent task-side `haruspex.save()` calls go through the explicit JS bridge and write through immediately. Task-side writes through `builtins.open` won't be auto-drained (no drain runs after the synchronous top-level returns); document this — long-running tasks should use `haruspex.save()` explicitly.

---

## Per-chat iframe lifecycle (LRU cap 3)

### IframeManager (replaces WorkerManager)

```typescript
class IframeManager {
  private iframes = new Map<string, ChatIframe>(); // chatId → iframe state
  private order: string[] = []; // LRU order, most-recent-first
  private readonly cap = 3;

  async ensureFor(chatId: string): Promise<ChatIframe> { ... }
  async snapshotAndEvict(chatId: string): Promise<void> { ... }
  setActive(chatId: string): void { ... }     // bring iframe to front, hide others
  async reset(chatId: string): Promise<void> { ... }    // tear down + respawn
}

interface ChatIframe {
  chatId: string;
  el: HTMLIFrameElement;
  ready: boolean;
  syncedFiles: Map<string, number>;
  pending: Map<string, PendingRun>;
  // ...
}
```

### Activation flow

When the active chat changes from `A` to `B`:

1. `iframes.get(A).el.style.visibility = 'hidden'` (keep it running in the background — pygame games keep their state and continue rendering frames; they just aren't shown).
2. If `iframes.has(B)`:
   - `iframes.get(B).el.style.visibility = 'visible'`.
   - Move `B` to front of LRU order.
   - If `iframes.size > cap`, snapshot-and-evict the tail of the LRU list.
3. If `!iframes.has(B)`:
   - Check whether `B` has a stored `workspaceSnapshot`. If yes, render the snapshot statically in the Workspace tab (image for canvas snapshots; sandboxed `<iframe srcdoc=...>` for HTML snapshots) and show a "Resume session" button. Booting Pyodide is deferred until the user clicks Resume or the model calls `run_python` (whichever is first).
   - If no snapshot: render the empty-state placeholder. Boot Pyodide lazily on first `run_python` call.
4. On boot: trigger the existing session-restore replay path (`restoreSandboxSession` in `chat.svelte.ts`), with one change — **skip lines that contain `asyncio.ensure_future` or `asyncio.create_task`** so replay doesn't relaunch every prior game.

### Snapshot

When a chat's iframe is being evicted (or the user is leaving and we want to preserve a final frame even without eviction — e.g. to display on next chat-load on a different device — TBD; v1 only snapshots on eviction):

1. Parent posts `capture_snapshot` to the iframe.
2. Iframe inspects its stage:
   - If a `<canvas>` is dominant → `canvas.toDataURL('image/png')` → `mime: 'image/png'`.
   - Else → `document.getElementById('stage').outerHTML` → `mime: 'text/html'`.
3. Parent stores in conversation persistence (`db.ts`).
4. Iframe is removed from the DOM.

### Restore

On loading a conversation with a stored snapshot:

- Canvas snapshot → render `<img src=dataURL>` in the Workspace tab.
- HTML snapshot → render `<iframe sandbox="" srcdoc=html>` so any inline JS from the snapshot doesn't re-execute without explicit user opt-in.
- Show a "Resume session" button. Clicking boots a fresh Pyodide iframe and runs the replay path.

### Per-chat persistence schema addition

```typescript
interface Conversation {
  // ...existing fields...
  workspaceSnapshot?: {
    mime: 'image/png' | 'text/html';
    payload: string; // data URL for png, raw HTML string for html
    capturedAt: number;
  };
  // sandboxApproved stays as today — unified approval, no separate field
}
```

`workspaceSnapshot` becomes a new TEXT column on the `conversations` table (or its own row in a `conversation_meta` table — pick whichever fits the existing `db.ts` shape).

---

## UI Integration

### Tab switcher

Add to `+page.svelte`: a two-tab bar at the top of the main pane (`[Chat] [Workspace]`). Default is Chat. The Workspace tab shows an indicator dot (`●`) when the active chat's iframe has fresh stage content the user hasn't viewed since their last visit.

**Auto-switch policy**: on receipt of a `stage_write` message AND the user is currently on the Chat tab AND we haven't already auto-switched during this turn, switch to Workspace. Reset the per-turn flag on each new user message.

**Visibility, not unmount**: switching tabs sets `visibility: hidden` on the inactive tab's container, not `display: none` or unmount, so a pygame game keeps running and its iframe's event loop keeps ticking.

### Workspace tab layout

```
┌──────────────────────────────────────────────────────────┐
│ Workspace                            [Reset] [Resume]    │
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
└──────────────────────────────────────────────────────────┘
```

- **Reset** button → calls `reset_python` programmatically. Confirms first when a task is running.
- **Resume** button → only shown when looking at a stored snapshot. Boots a fresh iframe + triggers replay.
- **Console pane** → live `stdout`/`stderr` from the active iframe. Virtualized at ~5000 lines, oldest evicted.
- **Empty state** → "The model can render Python or HTML here. It will appear when the model writes content."

### New components

- `src/lib/components/WorkspaceTab.svelte` — the tab body (iframe-host + console + controls).
- `src/lib/components/WorkspaceConsole.svelte` — virtualized stdout/stderr pane.
- Tab switcher likely inline in `+page.svelte` unless it grows past ~30 LOC, in which case extract.

Approval-confirmation dialogs continue to use `Modal.svelte` + `ModalButton.svelte` (`maintenance.md` §9).

---

## File Structure (after the rewrite)

```
src/lib/sandbox/                       # renamed from "worker-based" to "iframe-based" internally
  protocol.ts                          # MainToIframe / IframeToMain (renamed from MainToWorker / WorkerToMain)
  iframe-manager.ts                    # NEW — replaces worker-manager.ts; LRU cache of per-chat iframes
  sandbox.ts                           # public API (runPython, installPackage, resetSandbox) — surface unchanged
  sandbox.test.ts                      # ported tests
  # python.worker.ts → DELETED (its logic moves into static/workspace/init.py + index.html)

src/lib/agent/tools/
  sandbox.ts                           # registers run_python, install_package, reset_python (essentially as today, with updated descriptions)
  # NO workspace.ts — the original phase-13 tools are deleted/merged

src/lib/components/
  WorkspaceTab.svelte
  WorkspaceConsole.svelte
  # plus the inline tab switcher in +page.svelte

static/workspace/
  index.html                           # iframe entry — Pyodide loader, message router, stage <div id="stage">
  init.py                              # Python init: haruspex.save/delete/show_html/clear_stage/stop_tasks,
                                       # pyfetch override, urllib patch, matplotlib hook, postprocess, drain
                                       # (composed from today's HARUSPEX_INIT_PY block)

static/pyodide/                        # NEW: workspace wheels at root (loaded by indexURL='/pyodide/'):
  pygame_ce-*.whl                      #   in Pyodide 0.29.4 lockfile, loaded via pyodide.loadPackage
  bokeh-*.whl
  altair-*.whl
  <transitive deps>                    # numpy, pandas, narwhals, jinja2, jsonschema, pyyaml, etc.
                                       # (~23 wheels, ~18 MB, fetched by scripts/fetch-pyodide.sh
                                       #  from the Pyodide CDN; same set as derived from
                                       #  static/pyodide/pyodide-lock.json)

static/pyodide/wheels/                 # existing dir (chat-sandbox doc wheels — unchanged):
  fpdf2-*.whl
  python_pptx-*.whl
  defusedxml-*.whl
  fonttools-*.whl
  xlsxwriter-*.whl

scripts/fetch-pyodide.sh               # extends to download the workspace wheels at /pyodide/ root
```

The `static/pyodide/` dir is already used by the worker; the iframe loads from the same place.

---

## Implementation Steps

### Step 1 — Re-confirm the spike on this branch (half day)

The prior branch already proved pygame-ce renders in a Tauri iframe on WebKitGTK and surfaced two load-bearing findings (recorded under "Load-bearing facts from the prior spike" above). This step is a smaller re-confirmation on a clean branch: rebuild a minimal `static/workspace/spike.html`, a wrapper route, run dev, and verify the bouncing-circle pygame demo renders, accepts keyboard input, and runs `pyodide.canvas.setCanvas2D` cleanly. **Do not delete the worker yet.**

- `static/workspace/spike.html`: minimal Pyodide loader, `<canvas id="canvas" tabindex="0">`, `pyodide.canvas.setCanvas2D(canvas)`, then a hardcoded bouncing-circle pygame demo wrapped in `asyncio.ensure_future`. ~150 LOC, leaner than the prior version.
- `src/routes/workspace-spike/+page.svelte`: thin wrapper that just embeds `/workspace/spike.html` in an iframe. No "manager mode" — that's step 4.
- Run `npm run tauri dev`, navigate to `/workspace-spike`, confirm: pygame renders, ←/→ keys move the ball, no SDL errors.
- DO NOT test `window.__TAURI_INTERNALS__.invoke` in the iframe — we already know it's absent. The spike's job is only to re-confirm pygame + canvas + key events on the current main.
- Once confirmed, delete the spike artifacts in step 9 (after the production iframe lands).

### Step 2 — Bundle the wheels (half day)

- pygame-ce, bokeh, altair (+ their transitive deps) all ship in Pyodide 0.29.4's lockfile. Drop them at `static/pyodide/` root (NOT in `wheels/`); the iframe loads them via `pyodide.loadPackage([...])` with `indexURL='/pyodide/'`. ~18 MB for the full set.
- Plotly is NOT in the lockfile — it stays an `install_package` first-use download (~5 MB from PyPI, then browser-cached).
- Extend `scripts/fetch-pyodide.sh` to download the workspace wheel set from `https://cdn.jsdelivr.net/pyodide/v0.29.4/full/<wheel>`. Mirror the marker-file idempotency used for the doc-creation wheels.
- The exact wheel list is derivable from `static/pyodide/pyodide-lock.json`; the working set on the prior branch was 23 wheels including transitive deps (numpy, pandas, narwhals, jinja2, jsonschema, pyrsistent, rpds_py, pyyaml, etc.).
- Test offline install in the spike iframe (`pyodide.loadPackage(['pygame-ce', 'bokeh', 'altair'])` from disk, no network).

### Step 3 — Build the new iframe runtime (2 days)

- Write `static/workspace/index.html` + `static/workspace/init.py`:
  - Inline Pyodide load, message router.
  - Port the existing Python init from `HARUSPEX_INIT_PY` in `python.worker.ts` verbatim. Add `show_html`, `clear_stage`, `stop_tasks` to the `haruspex` module.
  - Stage `<div id="stage">`. Internal MutationObserver to emit `stage_write` / `stage_clear` events.
  - Task registry: every `asyncio.ensure_future(...)` users launch should be trackable for `haruspex.stop_tasks()`. (Hook via a simple `asyncio.all_tasks()` filter, or wrap `ensure_future` in our own helper that records into a set. Pick whichever is more reliable.)
  - Stdout/stderr capture for **detached tasks** too — Pyodide's `setStdout` is global, so all `print()`s (whether from the awaited top-level code or from a background task) flow through. We forward all of them with the most recent `run_python` call's `id` so the console pane keeps streaming.

### Step 4 — Build the IframeManager (2 days)

- Rename `src/lib/sandbox/worker-manager.ts` → `iframe-manager.ts`. Take it line-by-line and replace `Worker` with `HTMLIFrameElement.contentWindow`.
- Refactor for the LRU per-chat cache. Public API remains `runPython(code)` / `installPackage(name)` / `resetSandbox()` (now per-active-chat). Tests in `sandbox.test.ts` get a new fixture for the iframe-mock factory.
- Wire up snapshot + restore. Snapshot capture only triggers on LRU eviction in v1; restore is the deferred fresh-iframe-plus-replay path.
- Use `logDebug('sandbox', ...)` for all internal logs (not `console.*`).

### Step 5 — Wire up active-chat tracking (half day)

- The store needs to call `iframeManager.setActive(chatId)` when the active chat changes. Replaces today's call to `restoreSandboxSession`.
- Modify `restoreSandboxSession`: it's still needed for the case where an LRU-evicted chat is re-entered. But it must skip `asyncio.ensure_future` / `asyncio.create_task` lines so a chat with a prior game doesn't auto-relaunch the game on replay. Add a one-line heuristic, document it.

### Step 6 — Tool registration (half day)

- Update `src/lib/agent/tools/sandbox.ts` with the new tool descriptions (the long `run_python` description that documents both output channels and the `asyncio.ensure_future` pattern).
- No new tools, no new categories. `sandboxEnabled` setting still gates everything.

### Step 7 — UI integration (1–2 days)

- Tab switcher in `+page.svelte`.
- `WorkspaceTab.svelte` hosting the iframe-host div + console + Reset/Resume buttons.
- `WorkspaceConsole.svelte` with virtualized log lines.
- Active-tab visibility via `visibility: hidden`, not unmount.
- Auto-switch + indicator-dot logic on `stage_write`.

### Step 8 — Snapshot + persistence (1 day)

- `workspaceSnapshot` column / row on conversations table.
- On LRU eviction: parent posts `capture_snapshot`, awaits, stores.
- On loading a snapshot-bearing chat: render statically (image or sandboxed iframe), show Resume button.

### Step 9 — Delete the worker (half day)

- Remove `src/lib/sandbox/python.worker.ts`.
- Remove worker-specific code paths from `worker-manager.ts` (now `iframe-manager.ts`).
- Ensure no remaining `new Worker(...)` references.
- `npm run lint` / `npm run check` should pass.

### Step 10 — System prompt nudge (15 min)

- A lean addition to `src/lib/agent/system-prompt.ts`: one or two sentences about the workspace tab and the `asyncio.ensure_future` pattern. Per the `[[feedback_lean_system_prompts]]` memory — don't enumerate edge cases here; tool descriptions carry the load.

### Step 11 — Build gates + commit hygiene (per-commit, ongoing)

`maintenance.md` §13:

```bash
npm run format
npm run check
npm run lint
npm run test
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Conventional Commits scope: `feat(sandbox): unify worker/workspace into iframe runtime`, `refactor(sandbox): …` for follow-ups.

**Total estimate**: 7–10 days of focused work, weighted toward steps 3 (iframe runtime), 4 (manager), and 7 (UI). If step 1 reveals pygame doesn't work on WebKitGTK, scope shrinks to "everything except pygame" — plotly/bokeh/altair/HTML still work, and the unified surface is still a win over today's two-tool split.

---

## Risks & Open Questions

- **pygame-ce on WebKitGTK** — verified on the prior branch; re-confirmed in step 1 on this branch.
- **Tauri `invoke` from child iframes** — verified absent on the prior branch (`__TAURI_INTERNALS__` is not injected into child iframes). The plan adopts the parent-postMessage bridge as the design, NOT as a fallback. Protocol carries the bridge messages, same shape as today's worker bridge.
- **Stdout from detached tasks** — Pyodide's `setStdout` is process-global, so background-task `print()`s will route to *whichever* `currentRunId` was last set. We need to be more careful than today: if a tool call returns and 30 seconds later a background task prints, we still want that print in the console pane, just not in any returned tool result. Buffer it with `id: null` or with a synthetic "background" id.
- **Replay skipping `asyncio.ensure_future`** — the heuristic ("substring match") is fragile. If a model writes `task = asyncio.ensure_future(compute_a_sum())` (a normal compute that just happens to use a coroutine), replay will skip it and the model loses the result. Document, and consider a more reliable signal long-term (e.g. a per-call "is-long-running" hint the model can pass, OR an AST check).
- **Memory growth** — three iframes ≈ 150–300 MB of Pyodide state. Cap of 3 is a defensive guess; revisit based on real usage.
- **Snapshot fidelity for HTML mode** — `outerHTML` misses canvas state, video positions, scroll position. Acceptable for v1 (it's a snapshot, not a state save). Document.
- **Iframe crash recovery** — if an iframe crashes (OOM, pygame error), detect via `error` event on the iframe element and surface "Sandbox crashed for chat <name>; reset?" in the Workspace tab.
- **`time.sleep` blocks the iframe** — if the model uses `time.sleep` instead of `await asyncio.sleep`, the pygame loop freezes. The `run_python` description warns; consider also adding a runtime detection that prints a stderr warning when `time.sleep` is called on the iframe main thread.
- **Auto-switch fights the user** — if the user is reading chat and the model writes to the stage, we steal focus. Mitigation: only auto-switch *once per turn*, and only if the user hasn't manually switched to Chat *during* this turn. Test this carefully.
- **Replay during boot from snapshot** — a chat with many prior `run_python` calls plus a stored snapshot: clicking Resume triggers replay, which can take 10+ seconds. Show a progress indicator; respect the existing `SESSION_REPLAY_CAP = 50`.

### ESLint complexity ceilings (`maintenance.md` §14)

- `iframe-manager.ts` will start as a clone of `worker-manager.ts` (currently 575 LOC, already in the exemption list) plus the LRU + snapshot logic. Target: stay under 600 LOC by extracting (a) LRU bookkeeping, (b) snapshot capture/restore, (c) FS bridge handlers into separate files if needed.
- `static/workspace/init.py` is Python so ESLint doesn't gate it. Keep tractable.
- `WorkspaceTab.svelte` is markup-heavy → file-type exempted. Aim for <400 LOC.
- New functions stay under 80 LOC. Protocol dispatch in `iframe-manager.ts` is the highest fat-function risk — split into per-`kind` handlers from the start.
- Watch `+page.svelte` (currently 662 LOC) — extract the tab switcher if it grows past ~30 LOC.

### No new Rust commands

Same as today's chat sandbox — we reuse `sandbox_fetch`, `sandbox_save`, `sandbox_delete_in_workdir`, `sandbox_sync_workdir`. If something forces a new Tauri command, follow `maintenance.md` §6: register via full module path in `generate_handler!`; no `pub use` re-export.

---

## Migration notes (handover from the failed first attempt)

If the user has a partially-implemented branch from the original phase 13 plan (with `start_tab_session` / `update_tab` tools and a separate workspace Pyodide), the migration path is:

1. Delete the new tools (`start_tab_session`, `update_tab`, `stop_tab_session`, `install_package_in_tab`).
2. Keep any work on `WorkspaceTab.svelte` / `WorkspaceConsole.svelte` — those are reused here.
3. Keep any work on bundled wheels (pygame-ce/bokeh/altair + transitive deps at `static/pyodide/` root) — reused. Plotly stays as install_package, not bundled.
4. Discard the second Pyodide instance / second worker / parallel iframe-manager — the unified iframe is per-chat, not per-purpose.
5. Discard `workspaceApproved` field — unified under `sandboxApproved`.

The replay-on-chat-switch policy is the biggest behavioral change vs. today's chat sandbox: today there is one global worker that gets reset+replayed on every chat switch. The new model is per-chat iframes with LRU. Code that today assumes "the single worker is gone after chat switch" will not hold. Audit anything in `chat.svelte.ts` that touches sandbox state on activeConversation changes.
