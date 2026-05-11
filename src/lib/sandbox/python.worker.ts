/// <reference lib="webworker" />

import { loadPyodide, type PyodideInterface } from 'pyodide';
import type { MainToWorker, ToolResult, WorkerToMain } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let pyodide: PyodideInterface | null = null;
let initStarted = false;
let pendingInterruptBuffer: SharedArrayBuffer | null = null;
let currentRunId = '';
let currentStdout = '';
let currentStderr = '';

// Tracks Promises returned from _haruspex_save so the matching
// save_response message can resolve/reject the right call. Keyed by
// the request_id we mint when the Python coroutine asks to save.
interface PendingSave {
	resolve: (result: { path: string; bytes: number }) => void;
	reject: (err: Error) => void;
}
const pendingSaves = new Map<string, PendingSave>();

// Python-side helpers: install matplotlib's plt.show capture lazily (only if
// matplotlib is importable), and inspect the value of a run's last expression
// for a rich representation (DataFrame HTML, anything with _repr_html_). The
// helpers call the JS bridges _haruspex_emit_image / _haruspex_emit_html
// registered below to surface artifacts to the worker → main protocol.
const HARUSPEX_INIT_PY = `
import io as _io
import sys as _sys
import types as _types

# Install the 'haruspex' module so user code can do:
#   import haruspex
#   await haruspex.save('plot.png', png_bytes)
# The actual write happens in Rust via the JS-side _haruspex_save bridge,
# which returns a Promise the Python coroutine awaits.
_haruspex_mod = _types.ModuleType('haruspex')
_haruspex_mod.__doc__ = 'Haruspex sandbox bridge — write files to the active chat working dir.'

async def _haruspex_save_py(filename, content):
    """Save a file into the active chat's working directory.

    Args:
        filename: Path relative to the working dir. Absolute paths and
                  '..' traversal are rejected.
        content:  str (UTF-8 encoded) or bytes/bytearray.

    Returns:
        dict with 'path' (absolute path written) and 'bytes' (count).

    Raises:
        TypeError if content is the wrong type.
        OSError if the save fails (no working dir, path escape, write error).
    """
    if isinstance(content, str):
        content = content.encode('utf-8')
    elif not isinstance(content, (bytes, bytearray)):
        raise TypeError(
            'haruspex.save: content must be str or bytes, got ' + type(content).__name__
        )
    result = await _haruspex_save(filename, content)
    if hasattr(result, 'to_py'):
        result = result.to_py()
    return result

_haruspex_mod.save = _haruspex_save_py
_sys.modules['haruspex'] = _haruspex_mod

def _haruspex_install_matplotlib_hook():
    try:
        import matplotlib as _mpl
    except ImportError:
        return
    if getattr(_mpl, '_haruspex_patched', False):
        return
    _mpl.use('agg')
    import matplotlib.pyplot as _plt
    def _show(*args, **kwargs):
        for _num in _plt.get_fignums():
            _fig = _plt.figure(_num)
            _buf = _io.BytesIO()
            _fig.savefig(_buf, format='png', bbox_inches='tight', dpi=100)
            _haruspex_emit_image('image/png', _buf.getvalue())
        _plt.close('all')
    _plt.show = _show
    _mpl._haruspex_patched = True

def _haruspex_postprocess(value):
    """Inspect the run's last expression and emit a rich artifact when it has
    one. Returns the string to use as the textual 'result' field; '' when the
    artifact stands alone, repr(value) for plain values."""
    if value is None:
        return ''
    try:
        import pandas as _pd
        if isinstance(value, _pd.DataFrame):
            _total = len(value)
            if _total > 200:
                _haruspex_emit_html(value.head(200)._repr_html_(), 200, _total)
                return f'(DataFrame: {_total} rows × {len(value.columns)} cols, first 200 rendered in UI)'
            _haruspex_emit_html(value._repr_html_(), None, None)
            return f'(DataFrame: {_total} rows × {len(value.columns)} cols, rendered in UI)'
    except Exception:
        pass
    if hasattr(value, '_repr_html_'):
        try:
            _html = value._repr_html_()
            if _html:
                _haruspex_emit_html(_html, None, None)
                return '(rendered as HTML in UI)'
        except Exception:
            pass
    try:
        return repr(value)
    except Exception as _e:
        return f'<repr failed: {_e}>'
`;

function post(msg: WorkerToMain) {
	self.postMessage(msg);
}

async function init(): Promise<void> {
	if (initStarted) return;
	initStarted = true;
	try {
		// loadPyodide comes from the npm package; everything it pulls at
		// runtime (core .wasm, stdlib zip, lock file, packages installed
		// via micropip) lives at the Pyodide CDN. The version path here
		// must match the npm package version (see package.json).
		// Network is required on first run; the browser caches all of
		// this for subsequent runs.
		pyodide = await loadPyodide({
			indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.29.4/full/'
		});
		// micropip ships as a loadable package, not part of the stdlib —
		// pre-load it so install_package() can pyimport it without an
		// extra round trip on first use.
		await pyodide.loadPackage('micropip');
		// Pyodide's batched callback delivers one line at a time WITHOUT
		// the trailing newline, so re-append it before forwarding. Without
		// this, `print('a'); print('b')` shows up as 'ab' instead of 'a\nb'.
		pyodide.setStdout({
			batched: (s) => {
				const line = s + '\n';
				currentStdout += line;
				if (currentRunId) post({ kind: 'stdout', id: currentRunId, data: line });
			}
		});
		pyodide.setStderr({
			batched: (s) => {
				const line = s + '\n';
				currentStderr += line;
				if (currentRunId) post({ kind: 'stderr', id: currentRunId, data: line });
			}
		});
		if (pendingInterruptBuffer) {
			pyodide.setInterruptBuffer(new Uint8Array(pendingInterruptBuffer));
			pendingInterruptBuffer = null;
		}
		// Pyodide's auto-conversion of Python bytes to JS yields a Uint8Array
		// that may be a view into WASM memory — postMessage refuses to
		// structured-clone such views (DataCloneError). Copy into a fresh
		// JS-owned Uint8Array before posting. Same defensive String() on
		// the mime so a Python str doesn't leak through as a PyProxy.
		pyodide.globals.set('_haruspex_emit_image', (mime: unknown, bytes: unknown) => {
			if (!currentRunId) return;
			let safeBytes: Uint8Array;
			if (bytes instanceof Uint8Array) {
				safeBytes = new Uint8Array(bytes);
			} else if (
				bytes &&
				typeof bytes === 'object' &&
				'toJs' in bytes &&
				typeof (bytes as { toJs: () => unknown }).toJs === 'function'
			) {
				const converted = (bytes as { toJs: () => unknown }).toJs();
				safeBytes =
					converted instanceof Uint8Array
						? new Uint8Array(converted)
						: new Uint8Array(converted as ArrayBufferLike);
			} else {
				return;
			}
			post({
				kind: 'artifact',
				id: currentRunId,
				mime: String(mime),
				payload: { kind: 'bytes', bytes: safeBytes }
			});
		});
		pyodide.globals.set('_haruspex_save', (filename: unknown, content: unknown) => {
			const requestId = crypto.randomUUID();
			let payload: Uint8Array | string;
			if (typeof content === 'string') {
				payload = content;
			} else if (content instanceof Uint8Array) {
				// Detach from any underlying WASM buffer so postMessage can
				// structured-clone it (same fix as the artifact emit path).
				payload = new Uint8Array(content);
			} else if (
				content &&
				typeof content === 'object' &&
				'toJs' in content &&
				typeof (content as { toJs: () => unknown }).toJs === 'function'
			) {
				const converted = (content as { toJs: () => unknown }).toJs();
				if (converted instanceof Uint8Array) {
					payload = new Uint8Array(converted);
				} else if (typeof converted === 'string') {
					payload = converted;
				} else {
					return Promise.reject(new Error('haruspex.save: content must be str or bytes'));
				}
			} else {
				return Promise.reject(new Error('haruspex.save: content must be str or bytes'));
			}
			return new Promise<{ path: string; bytes: number }>((resolve, reject) => {
				pendingSaves.set(requestId, { resolve, reject });
				post({
					kind: 'save_request',
					id: currentRunId,
					request_id: requestId,
					filename: String(filename),
					content: payload
				});
			});
		});
		pyodide.globals.set(
			'_haruspex_emit_html',
			(html: unknown, shown: number | null, total: number | null) => {
				if (!currentRunId) return;
				const truncated =
					shown !== null && total !== null && shown !== undefined && total !== undefined
						? { shown, total }
						: undefined;
				post({
					kind: 'artifact',
					id: currentRunId,
					mime: 'text/html',
					payload: { kind: 'text', text: String(html) },
					truncated
				});
			}
		);
		await pyodide.runPythonAsync(HARUSPEX_INIT_PY);
		post({ kind: 'ready' });
	} catch (err) {
		post({ kind: 'load_error', error: err instanceof Error ? err.message : String(err) });
	}
}

function applyInterruptBuffer(buffer: SharedArrayBuffer): void {
	if (pyodide) {
		pyodide.setInterruptBuffer(new Uint8Array(buffer));
	} else {
		pendingInterruptBuffer = buffer;
	}
}

function emptyResult(durationMs: number, error: string | null = null): ToolResult {
	const result: ToolResult = {
		stdout: currentStdout,
		stderr: currentStderr,
		result: '',
		error,
		artifacts: 0,
		artifactsList: [], // populated on the main side from streamed artifact messages
		notes: [],
		duration_ms: durationMs
	};
	currentStdout = '';
	currentStderr = '';
	return result;
}

async function handleRun(id: string, code: string): Promise<void> {
	if (!pyodide) {
		post({
			kind: 'done',
			id,
			result: emptyResult(0, 'Pyodide is not loaded')
		});
		return;
	}
	currentRunId = id;
	currentStdout = '';
	currentStderr = '';
	const t0 = performance.now();
	try {
		await pyodide.loadPackagesFromImports(code);
		// Re-install the matplotlib show-capture hook each run; idempotent
		// in Python (guarded by a sentinel attribute), so the cost is one
		// dictionary lookup if matplotlib is loaded.
		await pyodide.runPythonAsync('_haruspex_install_matplotlib_hook()');
		const value = await pyodide.runPythonAsync(code);
		const result = emptyResult(Math.round(performance.now() - t0));
		// Pass the value back to Python so it can detect rich representations
		// (DataFrame _repr_html_, anything with _repr_html_) and emit
		// artifacts as a side effect; the returned string is the textual
		// 'result' field shown to the model.
		if (value !== undefined && value !== null) {
			const postprocess = pyodide.globals.get('_haruspex_postprocess');
			try {
				result.result = String(postprocess(value));
			} finally {
				postprocess?.destroy?.();
				if (typeof (value as { destroy?: () => void }).destroy === 'function') {
					(value as { destroy: () => void }).destroy();
				}
			}
		}
		post({ kind: 'done', id, result });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		post({
			kind: 'done',
			id,
			result: emptyResult(Math.round(performance.now() - t0), message)
		});
	} finally {
		currentRunId = '';
	}
}

async function handleInstall(id: string, packageName: string): Promise<void> {
	if (!pyodide) {
		post({
			kind: 'done',
			id,
			result: emptyResult(0, 'Pyodide is not loaded')
		});
		return;
	}
	const t0 = performance.now();
	post({ kind: 'install_progress', id, package: packageName, phase: 'resolving' });
	try {
		const micropip = pyodide.pyimport('micropip');
		post({ kind: 'install_progress', id, package: packageName, phase: 'downloading' });
		await micropip.install(packageName);
		post({ kind: 'install_progress', id, package: packageName, phase: 'installing' });
		const result = emptyResult(Math.round(performance.now() - t0));
		result.result = `installed ${packageName}`;
		post({ kind: 'done', id, result });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		post({
			kind: 'done',
			id,
			result: emptyResult(Math.round(performance.now() - t0), message)
		});
	}
}

self.addEventListener('message', (e: MessageEvent<MainToWorker>) => {
	const msg = e.data;
	switch (msg.kind) {
		case 'set_interrupt_buffer':
			applyInterruptBuffer(msg.buffer);
			break;
		case 'run':
			void handleRun(msg.id, msg.code);
			break;
		case 'install':
			void handleInstall(msg.id, msg.package);
			break;
		case 'reset':
			// Full reset is implemented by the manager via terminate-and-respawn.
			// Acknowledging here keeps the protocol symmetric in case we add an
			// in-process reset later.
			post({ kind: 'done', id: msg.id, result: emptyResult(0) });
			break;
		case 'interrupt':
			// Cooperative interrupt is delivered through the SharedArrayBuffer;
			// this message is reserved for future use (e.g. cancelling network
			// fetches that don't see the bytecode interrupt).
			break;
		case 'save_response': {
			const pending = pendingSaves.get(msg.request_id);
			if (!pending) break;
			pendingSaves.delete(msg.request_id);
			if (msg.ok) {
				pending.resolve({ path: msg.path ?? '', bytes: msg.bytes ?? 0 });
			} else {
				pending.reject(new Error(msg.error ?? 'haruspex.save failed'));
			}
			break;
		}
		case 'fetch_response':
			// Bridges resolved by their own pending-promise tables in 11.5.
			break;
	}
});

void init();
