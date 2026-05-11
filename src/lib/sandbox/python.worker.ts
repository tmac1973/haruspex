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

interface PendingFetch {
	resolve: (result: {
		status: number;
		headers: Record<string, string>;
		body: Uint8Array;
		url: string;
	}) => void;
	reject: (err: Error) => void;
}
const pendingFetches = new Map<string, PendingFetch>();

// Resolved by the manager's reply to our 'get_proxy_mode' query during init.
let proxyModeWaiter: ((mode: string) => void) | null = null;

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

# ----------------------------------------------------------------------
# pyodide.http.pyfetch override — route through the app's reqwest+proxy
# stack so model-authored 'await pyodide.http.pyfetch(url)' calls honor
# the user's app-level proxy setting (the WebView's fetch doesn't see it).
# ----------------------------------------------------------------------

class _SandboxFetchResponse:
    """Thin stand-in for pyodide.http.FetchResponse covering the common
    methods (.bytes / .string / .text / .json / .memoryview / .ok /
    .raise_for_status). The body is delivered up front as bytes; the
    async accessors are stubs that return immediately."""
    def __init__(self, status, headers, body, url):
        self.status = int(status)
        self.headers = dict(headers or {})
        self.url = str(url or '')
        self._body = bytes(body) if not isinstance(body, bytes) else body
        self.ok = 200 <= self.status < 300
        self.status_text = ''

    async def bytes(self):
        return self._body

    async def string(self):
        return self._body.decode('utf-8')

    async def text(self):
        return await self.string()

    async def json(self):
        import json as _json
        return _json.loads(self._body.decode('utf-8'))

    async def memoryview(self):
        return memoryview(self._body)

    def raise_for_status(self):
        if not self.ok:
            raise OSError('HTTP ' + str(self.status) + ' for ' + self.url)

async def _haruspex_pyfetch(url, **kwargs):
    method = kwargs.get('method', 'GET')
    headers = kwargs.get('headers', None) or {}
    body = kwargs.get('body', None)
    if isinstance(body, str):
        body = body.encode('utf-8')
    # Coerce headers to a plain dict (might be passed as JS Headers etc.)
    if hasattr(headers, 'to_py'):
        headers = headers.to_py()
    if not isinstance(headers, dict):
        headers = dict(headers)
    response = await _haruspex_fetch(url, method, headers, body)
    if hasattr(response, 'to_py'):
        response = response.to_py()
    return _SandboxFetchResponse(
        status=response['status'],
        headers=response['headers'],
        body=response['body'],
        url=response.get('url', url),
    )

# Install the override. Importing pyodide.http here is cheap (it's part
# of the runtime, not a package download).
try:
    import pyodide.http as _pyodide_http
    _pyodide_http.pyfetch = _haruspex_pyfetch
except ImportError:
    # pyodide.http should always be available in Pyodide; if it isn't,
    # something weird happened and we just leave pyfetch unpatched.
    pass

# Wire urllib / requests / httpx to route through pyfetch via the
# pyodide-http helper package. Without this, model code that reaches
# for the standard urllib.request.urlopen (or third-party requests)
# fails with "urllib.error.URLError: unknown url type: https" because
# the WASM environment has no real socket layer.
#
# Skipped when the user has an app proxy configured: pyodide-http uses
# sync XMLHttpRequest internally, which goes around our pyfetch
# override and therefore bypasses the proxy. Leaving urllib unpatched
# in that case forces the model to use pyodide.http.pyfetch directly,
# which IS proxy-aware (override → fetch_request → sandbox_fetch).
if not _haruspex_skip_http_patch:
    try:
        import micropip as _micropip_for_http_patch
        await _micropip_for_http_patch.install('pyodide-http')
        import pyodide_http
        pyodide_http.patch_all()
    except Exception as _patch_err:
        import sys as _sys_for_warn
        print('WARNING: pyodide-http patch failed: ' + str(_patch_err), file=_sys_for_warn.stderr)
        print('  → urllib/requests/httpx will not work; use pyodide.http.pyfetch directly.',
              file=_sys_for_warn.stderr)
else:
    # Proxy is configured. Replace urllib.request.urlopen with a stub that
    # raises a SPECIFIC error naming pyfetch as the fix. The default
    # "URLError: unknown url type: https" is too generic for the model to
    # interpret as "use the other API"; it tends to abandon Python entirely
    # and fall back to web_search, which then hallucinates from
    # documentation pages.
    import urllib.request as _urllib_request

    def _haruspex_urlopen_proxy_block(*args, **kwargs):
        raise OSError(
            "urllib.request.urlopen is disabled in this sandbox because an "
            "app proxy is configured (urllib uses synchronous XMLHttpRequest "
            "which can't be routed through the proxy). Use "
            "'await pyodide.http.pyfetch(url)' instead — it goes through "
            "the proxy correctly. Same goes for requests / httpx / "
            "Path.read_text on URLs."
        )

    _urllib_request.urlopen = _haruspex_urlopen_proxy_block

# ----------------------------------------------------------------------
# builtins.open patch — make native Python file writes reach the user's
# working directory.
#
# Pyodide's filesystem is in-memory MEMFS. Python's open(), plt.savefig,
# pd.to_csv, np.save, PIL Image.save — all write into MEMFS only by
# default, so files appear to "exist" from the model's POV but never
# touch the host disk. We can't bridge async-to-sync to give Python a
# real-time host FS (no SharedArrayBuffer on Linux/WebKitGTK), so we
# defer: every write-mode open against a user-facing path goes through
# the original open as normal (MEMFS), AND we record the path. After
# the user's code returns, we read each recorded path from MEMFS and
# flush it to the host via haruspex.save.
#
# Read-after-write within the same run still works (MEMFS retains the
# file). Cross-run reads still need the FS tools.
# ----------------------------------------------------------------------

import builtins as _builtins

_haruspex_original_open = _builtins.open
_haruspex_pending_save_paths = set()

# Paths inside these prefixes are treated as Pyodide-internal scratch
# (config caches, system libs, /tmp) and NOT flushed to host. Anything
# else — bare filenames, /home/pyodide/foo.png, /home/tim/test/x.csv —
# is considered a user-facing save target.
_haruspex_save_excluded_prefixes = (
    '/lib/', '/usr/', '/dev/', '/proc/', '/sys/', '/etc/',
    '/tmp/', '/var/',
    '/home/pyodide/.',
)

def _haruspex_should_save(path_str):
    return not any(path_str.startswith(p) for p in _haruspex_save_excluded_prefixes)

def _haruspex_patched_open(filename, mode='r', *args, **kwargs):
    if isinstance(mode, str) and any(c in mode for c in 'wxa'):
        path_str = str(filename)
        if _haruspex_should_save(path_str):
            _haruspex_pending_save_paths.add(path_str)
    return _haruspex_original_open(filename, mode, *args, **kwargs)

_builtins.open = _haruspex_patched_open

async def _haruspex_drain_pending_saves():
    """Flush each recorded write-mode open to host disk via haruspex.save.
    Per-file failures are printed to stderr so the model can react on the
    next turn; one bad save doesn't abort the rest."""
    import os as _os
    import sys as _sys
    failed = []
    paths = list(_haruspex_pending_save_paths)
    _haruspex_pending_save_paths.clear()
    for path in paths:
        try:
            with _haruspex_original_open(path, 'rb') as _f:
                content = _f.read()
        except Exception as e:
            failed.append((path, 'could not read from sandbox FS: ' + str(e)))
            continue
        # Try the user's path verbatim; if it escapes the workdir
        # (matplotlib often hands us /home/pyodide/foo.png absolute),
        # fall back to the basename so the file lands in the workdir.
        try:
            await _haruspex_save_py(path, content)
        except Exception as e:
            msg = str(e)
            if 'escapes working directory' in msg or 'absolute' in msg:
                try:
                    await _haruspex_save_py(_os.path.basename(path), content)
                except Exception as e2:
                    failed.append((path, str(e2)))
            else:
                failed.append((path, msg))
    for fname, err in failed:
        print('WARNING: could not save ' + repr(fname) + ' to working directory: ' + err,
              file=_sys.stderr)

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
		pyodide.globals.set(
			'_haruspex_fetch',
			(url: unknown, method: unknown, headers: unknown, body: unknown) => {
				const requestId = crypto.randomUUID();
				let bodyBytes: Uint8Array | undefined;
				if (body == null) {
					bodyBytes = undefined;
				} else if (body instanceof Uint8Array) {
					bodyBytes = new Uint8Array(body);
				} else if (typeof body === 'string') {
					bodyBytes = new TextEncoder().encode(body);
				} else if (
					typeof body === 'object' &&
					body !== null &&
					'toJs' in body &&
					typeof (body as { toJs: () => unknown }).toJs === 'function'
				) {
					const c = (body as { toJs: () => unknown }).toJs();
					if (c instanceof Uint8Array) bodyBytes = new Uint8Array(c);
					else if (typeof c === 'string') bodyBytes = new TextEncoder().encode(c);
				}
				const headersObj: Record<string, string> = {};
				if (headers && typeof headers === 'object') {
					const src =
						'toJs' in headers && typeof (headers as { toJs: () => unknown }).toJs === 'function'
							? ((headers as { toJs: () => unknown }).toJs() as Record<string, unknown>)
							: (headers as Record<string, unknown>);
					for (const [k, v] of Object.entries(src)) {
						if (v != null) headersObj[String(k)] = String(v);
					}
				}
				return new Promise<{
					status: number;
					headers: Record<string, string>;
					body: Uint8Array;
					url: string;
				}>((resolve, reject) => {
					pendingFetches.set(requestId, { resolve, reject });
					post({
						kind: 'fetch_request',
						id: currentRunId,
						request_id: requestId,
						url: String(url),
						init: {
							method: typeof method === 'string' ? method : undefined,
							headers: headersObj,
							body: bodyBytes
						}
					});
				});
			}
		);
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
		// Ask main for the current proxy mode so the init script can decide
		// whether to install the urllib/requests/httpx → pyfetch bridge
		// (pyodide-http). When a proxy is configured, we deliberately leave
		// urllib unpatched: pyodide-http uses sync XMLHttpRequest under the
		// hood and that bypasses our pyfetch override (and therefore the
		// proxy). Forcing the model to use pyodide.http.pyfetch directly is
		// the only path that respects the proxy.
		const proxyMode = await new Promise<string>((resolve) => {
			proxyModeWaiter = resolve;
			post({ kind: 'get_proxy_mode' });
		});
		pyodide.globals.set('_haruspex_skip_http_patch', proxyMode === 'manual');
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
		// Flush any native file writes that landed in MEMFS during the run
		// to the host working dir. Errors per file are surfaced via stderr
		// inside the drain function; only catastrophic failures bubble up.
		try {
			await pyodide.runPythonAsync('await _haruspex_drain_pending_saves()');
		} catch (drainErr) {
			currentStderr +=
				'\n[haruspex] drain failed: ' +
				(drainErr instanceof Error ? drainErr.message : String(drainErr)) +
				'\n';
		}
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
		case 'proxy_mode':
			if (proxyModeWaiter) {
				const w = proxyModeWaiter;
				proxyModeWaiter = null;
				w(msg.mode);
			}
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
		case 'fetch_response': {
			const pending = pendingFetches.get(msg.request_id);
			if (!pending) break;
			pendingFetches.delete(msg.request_id);
			if (msg.error) {
				pending.reject(new Error(msg.error));
			} else {
				pending.resolve({
					status: msg.status,
					headers: msg.headers,
					body: msg.body,
					url: msg.url
				});
			}
			break;
		}
	}
});

void init();
