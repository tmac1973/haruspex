# Phase 11: Code Sandbox (Python via Pyodide)

## Goal

Add a Python code execution tool to the agent loop, powered by Pyodide running in a Web Worker inside the WebView. The model can write and run Python to do math, parse data, analyze content the user has authorized via the FS tool, and produce rich artifacts (matplotlib plots, pandas tables) that render inline in the chat. State persists for the duration of a chat session, with a single shared worker that resets on chat switch and rebuilds prior session state by replaying the chat's code history.

## Prerequisites

- Phase 5 (agent loop / tool calls) complete — needed to register the three new tools.
- Phase 9 (local filesystem) complete — file content reaches the sandbox via the existing FS tool, not via a sandbox-side mount.
- A code-block renderer (syntax highlighter) chosen for the chat UI; Shiki is recommended (already common in SvelteKit apps).

## Deliverables

- **User-testable**: Ask "compute the SHA-256 of the string 'haruspex' and show me intermediate hex digests every 1000 iterations". Model calls `run_python`, the chat shows the syntax-highlighted code, stdout streams in live, the final result returns to the model, and the model summarizes.
- **User-testable**: Select a working directory containing a CSV. Ask "load orders.csv with pandas and plot revenue by month". Model uses the FS tool to read the CSV, calls `install_package('pandas')` (UI shows "Installing pandas…"), then `install_package('matplotlib')`, then `run_python` with the analysis code. A PNG of the plot renders inline in chat. The model gets text output but not the image (image-to-model toggle is off by default).
- **User-testable**: After the analysis above, switch to another chat and back. Sandbox shows "Restoring session…", replays the prior code calls, and the model can immediately reference the `df` variable in a follow-up.
- **User-testable**: First `run_python` in a new chat triggers an "Allow code execution in this chat?" approval prompt; subsequent runs in that chat are automatic.

---

## Design Decisions

These were decided during planning:

| Decision | Choice |
|---|---|
| Primary user | LLM-driven (tool call). No user-facing notebook/REPL UI in v1. |
| Session lifetime | Persistent per chat session. Variables/imports survive across `run_python` calls in the same chat. |
| Languages | Python only. JavaScript sandbox deferred. |
| Package install | Stdlib baseline; `install_package` tool wraps `micropip.install()` for runtime installs from the Pyodide CDN. |
| Filesystem access | None directly for reads. File content reaches the sandbox as string args to `run_python`, sourced from the existing FS tool (Phase 9). |
| Worker → disk side channel | A `haruspex` Python module exposes `haruspex.save(filename, content)` that writes into the chat's working dir without the content round-tripping through the model's context. Used for large artifacts (full DataFrame HTML, generated plots, exported datasets). Reuses Phase 9's path sandboxing. |
| DataFrame artifact size | Truncated to **200 rows** on the worker side before the HTML is sent to the UI. Tool result includes a hint pointing the model at `haruspex.save(...)` so it can offer the user the full table on request. |
| Output channels | Text (stdout/stderr/result) → both model and UI. Rich artifacts (PNG plots, HTML tables) → UI only. Images → model only when per-chat toggle is on. **Default: image-to-model OFF.** |
| Resource limits | Wall-clock timeout, settings-configurable (default 30s). Kill mechanism: cooperative interrupt (SharedArrayBuffer) first, terminate-and-respawn worker as fallback. |
| Tools exposed | `run_python`, `reset_python`, `install_package`. |
| Chat UI | Inline code (syntax-highlighted) + streamed text output + rich artifacts (PNG / table / HTML) rendered in order. |
| Streaming | stdout/stderr stream live to UI; tool result returned to the model is the full concatenated text on completion. |
| Architecture | Pyodide in a Web Worker inside the WebView. No Rust sidecar. |
| Worker lifecycle | **Single worker, lazy spawn.** First-ever `run_python` pays Pyodide cold start (~2s, "Starting Python…" indicator). Switching chats resets the worker. |
| Session restore | On switch back to a chat with prior code history, worker is reset and replays that chat's `run_python` / `install_package` / `reset_python` calls in order to rebuild state. UI shows "Restoring session…". Errored runs are skipped. If replay fails (network down, package gone), fall back to fresh interpreter and inform the model in the next tool result. |
| Replay safety cap | Skip restore (start fresh) if a chat has more than 50 code runs OR replay would take more than 10s. User can override with a "Restore anyway" button. |
| Network egress | **Allowed**, but `pyodide.http.pyfetch` is overridden to forward through a Tauri command (`sandbox_fetch`) on the Rust side. This routes through `reqwest` with the app's configured HTTP/HTTPS proxy and centralizes egress logging. |
| User approval | Settings toggle: `off` / `once-per-chat` / `every run`. **Default: once-per-chat.** First `run_python` in a chat prompts; subsequent runs auto-execute. |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Frontend (SvelteKit, main thread)                           │
│  • sandbox.ts: public API (runPython, install, reset)       │
│  • Worker lifecycle manager: lazy spawn, reset, replay      │
│  • Approval prompt component                                │
│  • Code block + output renderer (syntax + stream + artifacts)│
└─────────────────────────────────────────────────────────────┘
                  │ postMessage              ▲
                  ▼                          │
┌─────────────────────────────────────────────────────────────┐
│ python.worker.ts (Web Worker)                               │
│  • Loads Pyodide from /pyodide/ (bundled in static/)        │
│  • Captures stdout/stderr → streams chunks to main          │
│  • Captures rich artifacts via custom display hook          │
│  • Cooperative interrupt via SharedArrayBuffer              │
│  • pyfetch override → forwards to main → Tauri              │
└─────────────────────────────────────────────────────────────┘
                  │ invoke('sandbox_fetch')
                  ▼
┌─────────────────────────────────────────────────────────────┐
│ Rust Backend (Tauri commands)                               │
│  • sandbox_fetch: reqwest + app proxy + egress log          │
│  • sandbox_save:  Phase 9 path-sandboxed write to workdir   │
│  • (future) host-side allowlist enforcement                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Tools (model-facing)

### `run_python`

```typescript
{
  type: 'function',
  function: {
    name: 'run_python',
    description: 'Execute Python code in a persistent sandbox. Variables, imports, and installed packages persist across calls within this chat. The result of the final expression is returned alongside any stdout/stderr. For data analysis use install_package first to add pandas/numpy/matplotlib if not already installed.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python source. Top-level await is supported.' }
      },
      required: ['code']
    }
  }
}
```

Result returned to model:

```typescript
{
  stdout: string,
  stderr: string,
  result: string,        // repr() of the final expression, '' if statement
  error: string | null,  // exception traceback, null on success
  artifacts: number,     // count only — image bytes never leak into the result unless toggle is on
  notes: string[],       // worker-emitted hints, e.g. "DataFrame truncated to 200 of 5000 rows; use haruspex.save(...) for the full table"
  duration_ms: number
}
```

### `reset_python`

```typescript
{
  type: 'function',
  function: {
    name: 'reset_python',
    description: 'Wipe the Python session: clears all variables, imports, and installed packages. Use after a poisoned state (e.g., a hung import or bad monkey-patch). Does not affect chat history.',
    parameters: { type: 'object', properties: {} }
  }
}
```

### `install_package`

```typescript
{
  type: 'function',
  function: {
    name: 'install_package',
    description: 'Install a Python package via micropip (downloads from the Pyodide package index). Common pre-built packages: numpy, pandas, matplotlib, scipy, scikit-learn, sympy, pillow, beautifulsoup4. Pure-Python wheels from PyPI also work; packages with C extensions not pre-built for Pyodide will fail.',
    parameters: {
      type: 'object',
      properties: {
        package: { type: 'string', description: "Package name, optionally with version pin: 'pandas' or 'pandas==2.1.0'" }
      },
      required: ['package']
    }
  }
}
```

---

## Worker Protocol

### Main → worker

```typescript
type MainToWorker =
  | { kind: 'run',       id: string, code: string }
  | { kind: 'install',   id: string, package: string }
  | { kind: 'reset',     id: string }
  | { kind: 'interrupt', id: string }
  | { kind: 'fetch_response', id: string, ok: boolean, status: number, body: ArrayBuffer, headers: Record<string,string> }
  | { kind: 'save_response',  id: string, request_id: string, ok: boolean, path?: string, bytes?: number, error?: string };
```

### Worker → main

```typescript
type WorkerToMain =
  | { kind: 'ready' }
  | { kind: 'stdout',   id: string, data: string }
  | { kind: 'stderr',   id: string, data: string }
  | { kind: 'artifact', id: string, mime: string, bytes: Uint8Array, alt?: string, truncated?: { shown: number, total: number } }
  | { kind: 'install_progress', id: string, package: string, phase: 'resolving'|'downloading'|'installing' }
  | { kind: 'done',     id: string, result: ToolResult }
  | { kind: 'fetch_request', id: string, url: string, init: RequestInit }
  | { kind: 'save_request',  id: string, request_id: string, filename: string, content: ArrayBuffer | string };
```

### Cooperative interrupt

- Allocate a `SharedArrayBuffer(4)` and pass it to `pyodide.setInterruptBuffer()` during init.
- On timeout, main thread writes `2` (SIGINT) to byte 0; Pyodide raises `KeyboardInterrupt` at the next bytecode boundary.
- If the worker doesn't post `done` within 2s of interrupt, escalate: `worker.terminate()`, spawn a new worker, replay history if the active chat has any.

---

## Session Restore (replay)

When the active chat changes:

1. Reset the existing worker (cheap path) or terminate + respawn (if reset takes too long or worker is wedged).
2. Walk the new chat's message history in order; collect every assistant tool call to `run_python`, `install_package`, or `reset_python`.
3. Apply the **replay cap**: if more than 50 calls, or estimated duration > 10s, skip auto-restore and surface a "Restore session" button.
4. Replay each call:
   - `install_package` → re-run; cached installs are fast.
   - `reset_python` → clear interpreter; subsequent replays start from clean state.
   - `run_python` → re-execute. **Skip** any call that originally errored (we know from the stored tool result). Suppress streaming output to UI during replay (no double-render).
5. On any replay failure: stop, fall back to fresh interpreter, mark the chat with "Session not restored — model will start with a fresh Python state." The next real tool result includes that note so the model knows.

Determinism caveats are documented for the user (in settings help text):

- `time.time()`, `random.random()` without seed, `uuid.uuid4()` produce different values on replay.
- `pyfetch` calls re-fire — remote may have changed.
- The model only ever saw the original output (preserved in chat history); only the *in-memory* state can diverge.

---

## Output Rendering

### Text streaming

- stdout/stderr chunks arrive as `WorkerToMain` messages and append to the active code block's output pane.
- Each chunk is concatenated; the full text is what gets returned to the model in the tool result.

### Rich artifacts

Hook into Pyodide's display system at worker init:

```python
import builtins, io, base64
from pyodide.ffi import to_js
import js

def _emit(mime, bytes_, alt=None):
    js.postMessage(to_js({
        'kind': 'artifact', 'id': _current_id, 'mime': mime,
        'bytes': bytes_, 'alt': alt,
    }))

# matplotlib: monkeypatch pyplot.show to render PNG and emit
# pandas: register an IPython display formatter for DataFrame -> text/html
# Pillow: PIL.Image.show -> emit image/png
```

UI renders artifacts inline, in arrival order, between code and (or interleaved with) the streamed text output.

### DataFrame truncation

The pandas display formatter is overridden in `python-init.py` to cap HTML rendering at **200 rows**:

- The worker calls `df.head(200).to_html()` rather than `df.to_html()`; for `df.tail(N)` etc. the user's slicing wins (we only cap if no slice was applied and `len(df) > 200`).
- The `artifact` message includes a `truncated: { shown: 200, total: 5000 }` field, which the UI renders as a header on the table ("Showing 200 of 5,000 rows").
- A `note` is appended to the tool result returned to the model: `"DataFrame artifact truncated to 200 of 5000 rows in the UI. Use haruspex.save('filename.html', df.to_html()) to write the full table to the working dir if the user wants the full data."`. This way the model can proactively offer to save the full table if the user asks for "everything" or "all rows".
- The full DataFrame remains in the Python session as the original variable — `haruspex.save('foo.html', df.to_html())` works without re-deriving it.

### Image-to-model toggle

- Per-chat boolean, default `false`, shown as a toggle in the chat's settings menu.
- When `true`, image artifacts produced during a `run_python` call are also appended to the next user-role message as `image_url` content blocks before being sent to the model on the following turn.
- Counter in the tool result (`artifacts: N`) is always present so the model knows artifacts were produced even when it can't see them.

---

## Haruspex Python Bridge

A `haruspex` module is exposed inside the Pyodide environment to give the model side channels that bypass its own context window. It's loaded by `python-init.py` and is available immediately after worker startup (no `install_package` needed).

### `haruspex.save(filename, content) -> dict`

```python
import haruspex
haruspex.save('orders_table.html', df.to_html())
haruspex.save('plot.png', png_bytes)
haruspex.save('summary.csv', df.to_csv(index=False))
```

- `filename`: path **relative to the chat's working directory** (Phase 9). Absolute paths and `..` traversal are rejected.
- `content`: `str` or `bytes`. Strings are encoded as UTF-8.
- Returns: `{'ok': True, 'path': '<absolute path>', 'bytes': 4823}` so the model can confirm success in its next reasoning step.
- Raises:
  - `RuntimeError("No working directory set — ask the user to select one before saving files.")` if the chat has no workdir.
  - `ValueError` if `content` exceeds the per-save cap (default 100 MB).
  - `PermissionError` if approval is required and the user denies (gated under the same per-chat `run_python` approval — once the user has approved code execution for the chat, saves into the workdir are implicitly allowed).

### Why a bridge instead of just calling `fs_write_file`

The model could already use Phase 9's `fs_write_file` to write to the working dir — but the file content would have to round-trip through the model's context window first. For a 5KB script that's fine; for a 50MB rendered HTML table or a 10MB PNG it's catastrophic (and would blow the context before it ever reached the FS tool). `haruspex.save` keeps content entirely worker-side; the model only ever sees the success summary.

### Implementation

The Python side calls a synchronous bridge that:

1. Posts a `save_request` message to the main thread with a fresh `request_id`.
2. Suspends the calling Python coroutine via `pyodide.ffi.run_sync` until a `save_response` arrives.
3. Resolves with the response dict (or raises if `ok: false`).

Main thread routes `save_request` → `invoke('sandbox_save', { chatId, filename, content })`. Rust:

- Looks up the chat's working dir.
- Reuses Phase 9's path-sandboxing helper (`canonicalize` + prefix check).
- Writes via `tokio::fs::write` (text) or directly (bytes).
- Logs the save event to the activity store with `(filename, bytes, sha256)`.
- Returns the absolute path and byte count.

### Future bridge functions (not in v1)

Out of scope for this phase but the same channel pattern applies: `haruspex.load(filename)` for reading workdir files into Python without round-tripping, `haruspex.notify(message)` for surfacing model-authored notes in the chat UI without going through tool results, `haruspex.figure(fig)` as an explicit "save this matplotlib figure" helper.

---

## Network Egress

`pyodide.http.pyfetch` is overridden in the worker init script to send a `fetch_request` message to the main thread, which calls `invoke('sandbox_fetch', { url, method, headers, body })`. The Rust side:

- Uses the same `reqwest` client and proxy config as the rest of the app (web_search, fetch_url).
- Applies size cap (e.g., 10MB) on response body to prevent the worker from consuming the whole heap.
- Logs the egress event (URL, status, bytes) for the in-app activity view.
- Returns the response back through `fetch_response` to the worker, which resolves the original `pyfetch` promise.

The worker exposes `pyodide.http.pyfetch` only — never gives Python direct access to the JS `fetch` global.

---

## User Approval

Setting: `sandboxApproval: 'off' | 'once-per-chat' | 'every-run'` (default `'once-per-chat'`).

- `off`: code runs without prompting.
- `once-per-chat`: first `run_python` in a chat shows a modal: "The model wants to run Python code in this chat. Allow?" with [Allow once] [Allow for this chat] [Deny]. Per-chat allow flag stored on the chat object.
- `every-run`: each `run_python` shows the code preview before executing with [Allow] [Deny].

Denial returns an error to the model: `"User denied code execution."` so the model can adapt (apologize, propose a different approach).

`install_package` and `reset_python` are not gated separately — they piggyback on the per-chat `run_python` approval (since installing/resetting without ever running is meaningless).

---

## Settings Panel Additions

A new "Code Sandbox" section in settings:

- **Enable Python sandbox** (master toggle, default on)
- **Execution timeout** (seconds, default 30, range 5–300)
- **Approval mode** (off / once-per-chat / every-run, default once-per-chat)
- **Include images in model context by default** (per-chat default for the image-to-model toggle, default off)
- **Network access** (on / off, default on — when off, `sandbox_fetch` returns an error and the override raises `RuntimeError`)
- (Advanced) **Replay cap — max calls** (default 50)
- (Advanced) **Replay cap — max seconds** (default 10)

Help text under "Approval mode" briefly explains the determinism caveats and that the sandbox is isolated from the host filesystem.

---

## Tauri Configuration

### CSP additions

In `src-tauri/tauri.conf.json` `app.security.csp`:

- `script-src`: add `'wasm-unsafe-eval'` (Pyodide requires it).
- `worker-src`: add `'self' blob:` (worker module loading).
- `connect-src`: add the Pyodide package CDN host (`https://cdn.jsdelivr.net` if using the default index) so micropip can resolve packages. Network egress from Python itself goes through Rust, not the WebView, so no other connect-src changes needed.

### COOP / COEP for SharedArrayBuffer

Cooperative interrupt requires `crossOriginIsolated`, which requires:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

Tauri's custom `tauri://` protocol can serve these headers via `tauri.conf.json` → `app.windows[].additionalHttpHeaders` (Tauri 2.x). Verify on all three platforms during the spike — WebKitGTK has historically been the trickiest.

If COOP/COEP can't be made to work cleanly on Linux, fall back to terminate-only kill (lose session state on timeout but keep the feature shippable).

---

## File Layout

```
src/lib/sandbox/
  sandbox.ts              # public API used by the agent loop
  worker-manager.ts       # lazy spawn, reset, replay, interrupt-then-terminate
  python.worker.ts        # Pyodide host
  python-init.py          # display hooks, pyfetch override, haruspex module install
  haruspex-bridge.py      # the `haruspex` module source (save, future helpers)
  protocol.ts             # MainToWorker / WorkerToMain types
  approval.ts             # per-chat approval state + modal triggers
  artifacts.ts            # rendering helpers (PNG, HTML table, etc.)
  sandbox.test.ts
  worker-manager.test.ts

src/lib/agent/
  tools.ts                # add run_python, reset_python, install_package
  tool-runners.ts         # dispatch to sandbox.ts

src/lib/components/chat/
  CodeRunBlock.svelte     # collapsible: code + streamed output + artifacts
  ApprovalModal.svelte
  RestoringIndicator.svelte
  ArtifactImage.svelte
  ArtifactTable.svelte

src-tauri/src/
  sandbox_fetch.rs        # Tauri command: reqwest + proxy + size cap + egress log
  sandbox_save.rs         # Tauri command: path-sandboxed write into chat workdir

static/pyodide/            # bundled Pyodide dist (gitignored; populated by setup script)
scripts/
  fetch-pyodide.sh         # downloads pyodide dist into static/pyodide
```

---

## Tasks

### 11.1 Bundle Pyodide

- Add `scripts/fetch-pyodide.sh` that downloads the Pyodide dist (matching version pinned in script) into `static/pyodide/`.
- Add `static/pyodide/` to `.gitignore`.
- Hook `dev-setup.sh` to call `fetch-pyodide.sh` unless `--skip-pyodide` is passed.
- Verify: `npm run dev`, fetch `/pyodide/pyodide.mjs` returns 200.

### 11.2 Worker scaffolding

- Implement `python.worker.ts` with Pyodide load, ready signal, stdout/stderr capture, basic `run` handler.
- Implement `worker-manager.ts` with lazy spawn, request/response correlation by id, terminate-and-respawn.
- Implement `sandbox.ts` public API (`runPython`, `installPackage`, `reset`).
- Tests: mock worker (jsdom-friendly stub), assert message ordering and timeout behavior.

### 11.3 Cooperative interrupt + COOP/COEP

- Add COOP/COEP headers to `tauri.conf.json`, verify `crossOriginIsolated === true` in DevTools on all platforms.
- Wire SharedArrayBuffer interrupt; add the escalation timer in `worker-manager.ts`.
- If a platform can't enable COOP/COEP cleanly, gate cooperative interrupt behind a feature flag and fall back to terminate-only.

### 11.4 Display hooks + rich artifacts

- Implement `python-init.py`: matplotlib backend hook (PNG via `agg`), pandas DataFrame `_repr_html_` capture (with 200-row cap and `truncated` metadata), Pillow `Image.show` hook.
- Wire `artifact` messages to UI; render via `ArtifactImage.svelte` and `ArtifactTable.svelte`.
- `ArtifactTable.svelte` renders the "Showing N of M rows" header when `truncated` is present.
- Append a `note` to the tool result when truncation fires, pointing the model at `haruspex.save`.

### 11.5 Network egress

- Add `sandbox_fetch` Tauri command in `src-tauri/`; reuse the existing reqwest client + proxy config.
- Override `pyodide.http.pyfetch` in `python-init.py` to forward through main-thread → Tauri.
- Apply 10MB response cap and log to existing activity store.

### 11.5b Haruspex Python bridge

- Author `haruspex-bridge.py` exposing `haruspex.save(filename, content)`.
- Wire the `save_request`/`save_response` protocol in `worker-manager.ts`.
- Implement `sandbox_save` Tauri command: reuse Phase 9's path-sandboxing helper, 100MB per-save cap, log to activity store with `(filename, bytes, sha256)`.
- Tests: round-trip a 5MB string save, assert reject on `..` traversal, assert reject when no workdir set.

### 11.6 Tools registration + agent loop wiring

- Add `run_python`, `reset_python`, `install_package` to `tools.ts`.
- Add corresponding handlers in `tool-runners.ts` calling into `sandbox.ts`.
- Update system prompt with a short paragraph about when to use the sandbox, including: "the `haruspex` Python module is preinstalled; use `haruspex.save(filename, content)` to write large outputs (full DataFrame HTML, plot PNGs, exported datasets) to the working directory without round-tripping through your own context."

### 11.7 Approval flow

- Add `sandboxApproval` setting + UI in settings panel.
- Implement `ApprovalModal.svelte` and per-chat approval state (stored on the chat object).
- Wire `tool-runners.ts` to await approval before dispatching `run_python`.

### 11.8 Chat UI rendering

- `CodeRunBlock.svelte`: syntax-highlighted code (Shiki), streamed output pane, artifact slots, collapse toggle.
- Replace the generic tool-call renderer for the three new tools with this dedicated block.
- "Starting Python…" and "Restoring session…" indicators.

### 11.9 Session restore

- Implement replay walk in `worker-manager.ts` triggered on active-chat change.
- Apply replay cap (50 calls / 10s); surface "Restore anyway" button when capped.
- Suppress streaming output during replay; on failure, fall back to fresh interpreter and inject a synthetic system note for the next tool result.

### 11.10 Settings panel

- Add the "Code Sandbox" section described above.
- Per-chat image-to-model toggle in the chat settings menu.

### 11.11 End-to-end tests

- Vitest: a fake worker that simulates the protocol, asserts approval gating, replay determinism, and timeout escalation.
- Playwright (or manual): the three deliverables at the top of this doc.

---

## Out of Scope (v2 candidates)

- JavaScript/TypeScript sandbox (second worker, separate tools).
- Notebook-style UI for the user to write code directly.
- State snapshotting (so chat switches don't pay replay cost).
- CPython sidecar for full ecosystem (numpy/torch/etc.) — significant cross-platform sandboxing investment.
- File mount into Pyodide MEMFS (currently bridged via FS tool only).
- Per-package allowlist / signature verification for `install_package`.

## Open Questions

- **Pyodide version pin policy**: pin to a specific dist on each haruspex release, or auto-update on `dev-setup.sh`? (Lean: pin per release.)
- **Bundled vs runtime CDN for Pyodide core itself**: bundling adds ~12MB to the installer but matches the "private local" framing. Runtime fetch saves install size at the cost of an offline first-run hit. (Lean: bundle.)
- **What counts as "errored" for replay-skip**: any non-empty `error` field in the tool result, or only certain exception types? (Lean: any.)
- **`haruspex.save` overwrite policy**: silently overwrite an existing file, refuse, or auto-suffix with `-1`, `-2`? (Lean: silent overwrite, since the model often iterates on the same filename. Surface the overwrite in the activity log.)
