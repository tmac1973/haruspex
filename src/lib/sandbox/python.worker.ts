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

// Python-side helpers: install matplotlib's plt.show capture lazily (only if
// matplotlib is importable), and inspect the value of a run's last expression
// for a rich representation (DataFrame HTML, anything with _repr_html_). The
// helpers call the JS bridges _haruspex_emit_image / _haruspex_emit_html
// registered below to surface artifacts to the worker → main protocol.
const HARUSPEX_INIT_PY = `
import io as _io

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
		pyodide.globals.set('_haruspex_emit_image', (mime: string, bytes: Uint8Array) => {
			if (!currentRunId) return;
			post({
				kind: 'artifact',
				id: currentRunId,
				mime,
				payload: { kind: 'bytes', bytes }
			});
		});
		pyodide.globals.set(
			'_haruspex_emit_html',
			(html: string, shown: number | null, total: number | null) => {
				if (!currentRunId) return;
				const truncated =
					shown !== null && total !== null && shown !== undefined && total !== undefined
						? { shown, total }
						: undefined;
				post({
					kind: 'artifact',
					id: currentRunId,
					mime: 'text/html',
					payload: { kind: 'text', text: html },
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
		case 'fetch_response':
		case 'save_response':
			// Bridges resolved by their own pending-promise tables in 11.5/11.5b.
			break;
	}
});

void init();
