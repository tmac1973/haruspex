# Phase 13: Inline Interactive Plots (revised)

## Goal

Make `run_python` produce interactive plots (plotly, bokeh, altair, raw HTML) that hover/zoom/pan **inline in the chat message**, with no separate tab and no per-message UI mode-switching for the model. Pure-compute use cases (math, parsing, DataFrames, document generation) keep working exactly as in the pre-phase-13 chat sandbox.

### How we got here

This plan went through three shapes:

1. **First attempt** (original phase-13): a separate Workspace tab with its own Pyodide instance and a parallel set of tools (`start_tab_session`, `update_tab`, etc.). Implementation revealed the model could not reliably choose between `run_python` and `update_tab`.

2. **Unified iframe attempt** (most of `feat/unified-python-sandbox`): collapse to one `run_python` tool, one Pyodide per chat in an iframe, with a persistent Workspace tab that hosted the iframes. Got everything working end-to-end (plotly, matplotlib, DataFrames, pygame). But pygame in a same-origin iframe shares the parent's event loop on WebKitGTK — a blocking game loop freezes the whole app, needing an AST transform + `pygame.time.Clock.tick` monkey-patch + bundled wheels (~30MB) just to work somewhat.

3. **Current plan**: drop pygame. Without pygame's need for a real `document` + `<canvas>`, the iframe runtime brings nothing the Web Worker doesn't bring more cheaply. Plotly/bokeh/altair output is just HTML+JS; render each plot as a `<iframe srcdoc>` inside the chat message and the browser handles script execution natively. Python runs in a Web Worker (per chat, LRU cap 3), which gives heavy-compute insulation from the UI thread that the iframe approach actually didn't.

## Prerequisites

- Phase 11 (code sandbox): we keep the Rust FS/fetch commands (`sandbox_sync_workdir`, `sandbox_save`, `sandbox_delete_in_workdir`, `sandbox_fetch`) and the wheel-bundling pattern (`scripts/fetch-pyodide.sh`). Most of what's there carries over verbatim.
- Familiarity with `maintenance.md` sections 4 (tool system), 10 (logging), 11 (persistence), 13 (build gates).

## Deliverables

- **User-testable**: "compute the mean of [1,2,3,4]". `run_python` returns `2.5` inline in chat. Unchanged from today.
- **User-testable**: "plot the last 12 months of S&P 500 closes with plotly so I can hover for values". Model writes `fig = px.line(...)`, leaves `fig` as the last expression. Chat message renders an interactive plotly chart inside an iframe — hovering shows tooltips, pan/zoom work.
- **User-testable**: matplotlib `plt.show()` still emits a PNG artifact inline in chat (unchanged).
- **User-testable**: a pandas DataFrame as the last expression renders as an HTML table inline in chat (unchanged).
- **User-testable**: a `run_python` call that times out (model wrote a bad infinite loop) gets `▶ Run again` button in the chat — clicking respawns the Worker for that chat and re-runs the code.
- **User-testable**: while a `run_python` call is in flight, `⏸ Cancel` button appears. Clicking terminates the Worker, surfaces a cancel-error result with the Run-again button.

---

## Design Decisions (locked-in)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Tool surface | **`run_python`, `install_package`, `reset_python`** — single Python tool surface, exactly today's shape. | The unification benefit (model never picks the wrong Python tool) is achieved by having one tool. Runtime is a separate concern. |
| Python runtime | **Web Worker, one per chat, LRU cap 3.** | Worker isolates Python compute from the UI thread (the iframe couldn't do this — same-origin iframes share the parent's event loop on WebKitGTK). Per-chat preserves "ask a follow-up after switching chats and your variables are still there". |
| pygame | **Dropped.** No bundled wheel, no AST transform, no tick patch. | Was the sole justification for an iframe-based runtime; without it, the Worker is strictly cheaper. The visual-game use case is out of scope. |
| Plot rendering | **Per-message `<iframe srcdoc>`.** Each script-bearing HTML artifact gets its own sandboxed iframe in the chat message. `sandbox="allow-scripts"` (no allow-same-origin → plot can't reach parent). | Browser loads `srcdoc` as a normal document, so external `<script src="...">` tags + inline scripts execute in the right order natively. No manual script re-execution gymnastics. Each plot is independent — scroll up to a chart from 50 messages ago and it's still interactive. |
| HTML artifact distinction | Existing `kind: 'html'` artifact gains an optional `interactive: boolean` flag. `true` → renders as `<iframe srcdoc>`. `false`/absent → renders as `{@html ...}` (DataFrame tables, simple HTML, no scripts). | Backwards compatible: DataFrame artifacts unchanged. The Python postprocess sets `interactive: true` when the HTML contains a `<script>` tag. |
| Run-again | Button on tool result if it errored or timed out. Replays the original code from the tool call args; replaces the prior tool result inline. | Cheap escape hatch when a transient issue (slow first install, sluggish startup) kills a run. No state lost — the per-chat Worker survives. |
| Cancel | Button visible while a `run_python` call is in flight. Terminates the Worker (which respawns lazily next time), returns a cancel-error result with Run-again. | Lets the user abort an unexpectedly slow run without waiting for the timeout. |
| Approval | **Unchanged.** `sandboxApproval` setting + per-chat `sandboxApproved` flag covers everything. | No new trust boundaries. |
| Timeout | Existing `sandboxTimeoutSeconds` setting (default 30s) applies per Worker run. | Same as today. |
| Long-running tasks | **Not supported.** Every `run_python` call must complete within the timeout. No `haruspex.spawn`, no `asyncio.ensure_future` encouragement. | With pygame gone there's no use case that needs detached tasks. |
| Filesystem bridge | **Reused wholesale** from the legacy worker. `haruspex.save`, `haruspex.delete`, `pyodide.http.pyfetch` override, urllib patch, builtins.open + workdir drain. | Already battle-tested in the chat sandbox; no reason to change. |
| Bundled wheels | **Keep** fpdf2, python-pptx, xlsxwriter, defusedxml, fonttools (doc-creation) + bokeh, altair and their pure-Python deps (PyPI lockfile resolution). **Drop** pygame_ce. | bokeh / altair want offline parity with matplotlib / pandas. pygame is dead weight after this plan. |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Frontend (SvelteKit, main thread)                                    │
│  • Tab bar: [ Chat | Jobs ]   (no Workspace tab)                     │
│  • ChatView renders messages including:                              │
│      - run_python tool results, with                                 │
│      - Run again / Cancel buttons                                    │
│      - inline image artifacts (matplotlib PNGs)                      │
│      - inline HTML artifacts:                                        │
│          - interactive=true → <iframe srcdoc> (plotly etc.)          │
│          - interactive=false → {@html ...} (DataFrames)              │
│  • WorkerPool (one per app):                                         │
│      - one WorkerManager per chat, LRU cap 3                         │
│      - public: runPython(chatId,...), installPackage(chatId,...),    │
│        reset(chatId), cancel(chatId)                                 │
│      - per-chat workdir sync, FS bridge, fetch bridge                │
└──────────────────────────────────────────────────────────────────────┘
        │ postMessage                                  ▲
        ▼                                              │
┌──────────────────────────────────────────────────────────────────────┐
│ Web Worker (one per chat — Pyodide)                                  │
│  • init.py:                                                          │
│      - haruspex.save / haruspex.delete (FS bridge)                   │
│      - pyodide.http.pyfetch override                                 │
│      - urllib / requests / httpx routing                             │
│      - matplotlib plt.show hook (PNG artifact)                       │
│      - _haruspex_postprocess: emit interactive=true for              │
│        script-bearing _repr_html_                                    │
│      - builtins.open patch + workdir drain                           │
│      - doc-creation wheel install (fpdf2 etc)                        │
└──────────────────────────────────────────────────────────────────────┘
        │ invoke('sandbox_fetch' | 'sandbox_save' | ...) — direct,
        │ via @tauri-apps/api/core; the Worker reaches __TAURI_INTERNALS__
        │ on the main window through the existing import.
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Rust Backend (Tauri commands — unchanged from Phase 11)              │
│  • sandbox_fetch, sandbox_save, sandbox_delete_in_workdir            │
│  • sandbox_sync_workdir                                              │
└──────────────────────────────────────────────────────────────────────┘
```

**Why Web Worker, not iframe**:

Heavy synchronous Python (a 100k-row pandas op, scipy fitting, matplotlib rendering) runs on the Worker thread, leaving the main UI fully responsive. Iframes share the parent's event loop on WebKitGTK (verified during the iframe attempt), so a blocking Python call would freeze chat scrolling, typing, animations — the same class of bug pygame was hitting.

The Worker has no DOM. That's fine: plot HTML is generated in Python (e.g. `fig.to_html()`) as a string, shipped to the main thread as an artifact, and rendered there inside an `<iframe srcdoc>` where the browser handles script execution as part of a normal document load.

---

## Tool Surface (model-facing)

Three tools, unchanged from the previous attempt's structure but with simplified descriptions:

### `run_python`

```typescript
{
  type: 'function',
  function: {
    name: 'run_python',
    description:
      'Execute Python code in a persistent sandbox. Variables, imports, and installed packages persist across calls in the current chat. Top-level await is supported. The final expression value is returned alongside captured stdout/stderr. ' +
      'OUTPUT: ' +
      '(1) Text — stdout + final expression `repr`. ' +
      '(2) Inline images — `matplotlib.pyplot.plt.show()` emits the figure as a PNG in chat. ' +
      '(3) Inline interactive plots — plotly / bokeh / altair / folium figures returned as the last expression render in chat as an interactive HTML iframe (hover, pan, zoom). Tip for plotly: `fig.to_html(include_plotlyjs="cdn")` if you need the full HTML doc explicitly. ' +
      '(4) Inline DataFrames — a pandas DataFrame as the last expression renders as an HTML table. ' +
      'Each call must complete within the timeout; there is no `ensure_future` / background-task pattern. Bundled offline: matplotlib, numpy, pandas, scipy, scikit-learn, sympy, pillow, beautifulsoup4 (Pyodide built-ins), plus fpdf2, python-pptx, xlsxwriter, bokeh, altair. Other packages (plotly, folium, …): `install_package` first.',
    parameters: { ... }
  }
}
```

### `install_package`, `reset_python`

Same shape as today. `reset_python` tears down the active chat's Worker.

---

## Per-message iframe rendering

### Artifact protocol change

```diff
 export type Artifact =
   | { kind: 'image'; mime: string; dataUrl: string; alt?: string }
-  | { kind: 'html'; html: string; truncated?: { shown: number; total: number } };
+  | { kind: 'html'; html: string; truncated?: { shown: number; total: number }; interactive?: boolean };
```

`interactive: true` → the chat renders this artifact as `<iframe srcdoc>`. False / absent → renders via `{@html ...}`.

### Python postprocess

Existing `_haruspex_postprocess` in the worker's init script gains a small branch:

```python
if hasattr(value, '_repr_html_'):
    html = value._repr_html_()
    if html:
        if '<script' in html.lower():
            _haruspex_emit_html(html, None, None, interactive=True)
            return '(rendered as interactive HTML in chat)'
        _haruspex_emit_html(html, None, None)
        return '(rendered as HTML in chat)'
```

Plus a public `haruspex.render_interactive_html(html)` if the model needs to emit interactive HTML explicitly (not always a `_repr_html_`).

### Chat rendering (SearchStep.svelte or equivalent)

```svelte
{#each step.artifacts as a, i (i)}
    {#if a.kind === 'image'}
        <img class="artifact-image" src={a.dataUrl} alt={a.alt ?? 'plot'} />
    {:else if a.kind === 'html' && a.interactive}
        <iframe
            class="artifact-iframe"
            srcdoc={a.html}
            sandbox="allow-scripts"
            title="interactive plot"
        ></iframe>
    {:else if a.kind === 'html'}
        <div class="artifact-html">
            {#if a.truncated}<div class="artifact-truncation-note">…</div>{/if}
            {@html a.html}
        </div>
    {/if}
{/each}
```

Iframe styling:

```css
.artifact-iframe {
    width: 100%;
    height: 480px;
    border: 1px solid var(--border);
    border-radius: 4px;
}
```

(Default 480px; if a chart wants a taller default we can sniff the plotly height attribute, but 480 is the standard plotly default.)

---

## Worker pool (per-chat, LRU cap 3)

Same shape as the iframe pool we already built, but holds Workers instead of iframes. WorkerManager is mostly a port of the legacy `worker-manager.ts` from before the iframe rewrite — that file is still in the repo unmodified, so it's the obvious starting point.

```typescript
class WorkerPool {
    private readonly cap = 3;
    private readonly mgrs = new Map<string, WorkerManager>();
    private readonly order: string[] = [];

    async runPython(chatId: string, code: string, opts?: RunOptions): Promise<ToolResult>
    async installPackage(chatId: string, pkg: string, opts?: RunOptions): Promise<ToolResult>
    async reset(chatId: string): Promise<void>
    cancel(chatId: string): void   // terminate Worker, respawn lazily next call

    // LRU mechanics
    private touch(chatId: string): void
    private async evictIfOver(): Promise<void>
}
```

Eviction is simpler than the iframe pool: no snapshot to take (Workers have no visible state). Just terminate.

---

## Run-again / Cancel UX

### Cancel (during execution)

While a `run_python` call is in flight (the tool spinner is visible), the tool-result card shows a `⏸ Cancel` button. Clicking calls `WorkerPool.cancel(chatId)` which terminates the Worker. The agent loop sees a cancel error, surfaces it as the tool result, and the chat-side card now shows a `▶ Run again` button.

### Run again (after error / timeout / cancel)

If a `run_python` tool result has an error (including timeout and cancel), the result card shows `▶ Run again`. Clicking:

1. Re-extracts the code from the tool call's `arguments` JSON.
2. Calls the same approval-gate path the tool would (skip if `sandboxApproved`).
3. Calls `WorkerPool.runPython(chatId, code)`.
4. Replaces the prior tool result with the new one in chat history.

The model doesn't see this as a new tool call (no new tool_call_id) — the existing tool result message just gets its content updated. From the model's POV when it next reads the conversation, the call succeeded.

Replacing vs appending: replace is cleaner UX but loses the audit trail. We'll replace and surface the prior failure in `chat.svelte.ts` debug log only.

---

## File Structure

```
src/lib/sandbox/                       # the only home for sandbox stuff
  protocol.ts                          # MainToWorker / WorkerToMain (existing)
  python.worker.ts                     # the Pyodide worker (existing, simplified)
  worker-manager.ts                    # one-worker manager (existing, restored)
  worker-pool.ts                       # NEW — per-chat cap-3 LRU
  sandbox.ts                           # public API, dispatches to pool
  sandbox.test.ts                      # existing tests, adjusted

src/lib/agent/tools/sandbox.ts         # tool registration, descriptions

src/lib/components/
  SearchStep.svelte (or similar)       # render image / interactive iframe / html artifacts
  + a small ToolResultControls.svelte  # Run again / Cancel button

# Deleted in this phase:
#   src/lib/workspace/ (all of it)
#   src/lib/components/workspace/ (all of it)
#   static/workspace/ (all of it)
#   src/routes/workspace-spike/
#   the Workspace entry from ActiveTab + TabBar
#   pygame_ce wheel from scripts/fetch-pyodide.sh
```

---

## Implementation Steps

### Step A — Demolition (half day)

Delete the iframe / workspace-tab code. With nothing wired up, the chat falls back to the legacy worker that's still in the repo. The tools currently call IframePool — they'll need a temporary stub until step C lands, but the build should stay green.

### Step B — Restore Web Worker for Python (half day)

Take the existing `python.worker.ts` (untouched since before phase 13). Strip out: any iframe-specific bits if any leaked back. Add: the `interactive: true` flag emission in `_haruspex_postprocess` for script-bearing HTML.

### Step C — Worker pool (half day)

Adapt `worker-manager.ts` to be poolable (similar to how we adapted IframeManager — small additions: `terminate()` without respawn, an `id` getter). Write `worker-pool.ts` modeled on `iframe-pool.ts` but for Workers.

### Step D — Wire sandbox.ts to the pool (15 min)

Update `sandbox.ts` to dispatch `runPython`/`installPackage`/`resetSandbox` to the pool, scoped to `getActiveConversationId()`. Same shape as the current sandbox.ts.

### Step E — Artifact iframe rendering (half day)

Update `SearchStep.svelte` (or wherever artifacts render) to handle `interactive: true` HTML artifacts as `<iframe srcdoc sandbox="allow-scripts">`. Default height 480px.

### Step F — Run-again / Cancel UX (half day)

Add a small `ToolResultControls.svelte` component that:
- Shows `⏸ Cancel` while the tool call is in flight.
- Shows `▶ Run again` when the tool result has an error.
- Cancel calls `WorkerPool.cancel(chatId)` and the agent loop's existing cancellation path.
- Run-again invokes the tool's execute() path with the original args; replaces the tool result inline.

### Step G — Tool descriptions + system-prompt audit (15 min)

Update `run_python` description to document the four output channels. Remove any lingering `asyncio.ensure_future` / `haruspex.spawn` language. Per [[feedback_lean_system_prompts]], leave the system prompt alone — the tool description carries the load.

### Step H — Drop pygame wheel + build gates

Remove `pygame_ce-*.whl` from `scripts/fetch-pyodide.sh`'s `WORKSPACE_WHEELS` (rename block — it's not workspace anymore, just "lockfile-resident wheels" or fold into the doc-wheels). Run the full build matrix from `maintenance.md` §13.

**Total estimate**: 2-3 days of focused work.

---

## Risks & Open Questions

- **Iframe height tuning** — 480px works for plotly's default figure size, but bokeh / altair figures with different aspect ratios may need a knob. Defer; collect feedback.
- **CSP and `sandbox="allow-scripts"`** — Tauri's default CSP may block inline scripts inside the srcdoc iframe. Verify on first plotly test. If blocked, may need to relax CSP for the `srcdoc:` document scheme or use a different rendering path.
- **Plotly CDN load** — `include_plotlyjs="cdn"` makes plotly.js a CDN fetch (~3MB once, then browser-cached). Offline use breaks for plotly's first call. Acceptable; matches the chat sandbox's existing first-package install posture.
- **Memory growth** — three Workers per chat scope, plus iframes per chart in chat. Iframes per chart are sandboxed but each holds a copy of plotly.js (~few MB). For a chat with 20 plots, that's ~60MB of duplicated bundle. Browser caches script bytes but each iframe still has its own JS context. Watch for this in real use.
- **Run-again races** — if the user clicks Run-again while another tool call is mid-flight, we need to either queue or refuse. Simplest: refuse with a toast ("waiting on another run").
- **Cancel from inside a long fetch** — terminating the Worker mid-`sandbox_fetch` leaves the Rust side fetching; the response will be discarded on return. Wasted bandwidth but harmless. The legacy worker has this same posture.
