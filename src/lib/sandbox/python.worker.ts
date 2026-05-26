/// <reference lib="webworker" />

import { loadPyodide, type PyodideInterface } from 'pyodide';
import type { MainToWorker, ToolResult, WorkerToMain } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

interface PyodideFS {
	writeFile(path: string, data: Uint8Array | string): void;
	unlink(path: string): void;
	mkdirTree(path: string): void;
	analyzePath(path: string): { exists: boolean };
}

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

interface PendingDelete {
	resolve: (result: { path: string }) => void;
	reject: (err: Error) => void;
}
const pendingDeletes = new Map<string, PendingDelete>();

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
let proxyModeWaiter: ((cfg: { mode: string; workingDirSet: boolean }) => void) | null = null;

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

async def _haruspex_delete_py(filename):
    """Delete a file in the active chat's working directory.

    Used by the post-run drain to propagate Python deletions (os.remove,
    pathlib.unlink, etc.) back to the host. Same path-safety rules as
    haruspex.save — relative to the workdir, no '..' escapes.

    Args:
        filename: Path relative to the working dir.

    Returns:
        dict with 'path' (absolute path of the deleted file).
    """
    result = await _haruspex_delete(filename)
    if hasattr(result, 'to_py'):
        result = result.to_py()
    return result

_haruspex_mod.delete = _haruspex_delete_py
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
            "pyodide.http.pyfetch instead — it routes through the proxy "
            "correctly. Top-level await works in this sandbox; the exact "
            "pattern is: "
            "import pyodide.http, json; "
            "response = await pyodide.http.pyfetch(url); "
            "data = json.loads(await response.string()); "
            "print(data). "
            "Do NOT use asyncio.run() — there's already an event loop running. "
            "Just await the call directly at the top level."
        )

    _urllib_request.urlopen = _haruspex_urlopen_proxy_block

# ----------------------------------------------------------------------
# Doc-creation wheels — install fpdf2 + python-pptx (and their non-Pyodide
# pure-Python deps) from the bundled static/pyodide/wheels/ directory so
# the model can produce PDFs and PowerPoints offline. The Pyodide-built
# deps (Pillow, lxml, typing_extensions) were already pulled JS-side via
# loadPackage. We pass deps=False so micropip won't try to re-resolve
# them against PyPI (which would fail for offline users).
# A failure here is non-fatal: the sandbox still boots, the model just
# gets an ImportError if it reaches for fpdf / pptx. The warning tells
# the user what to do (re-run dev-setup.sh).
# ----------------------------------------------------------------------

try:
    import micropip as _micropip_for_doc_wheels
    _doc_wheels = [
        'fpdf2-2.8.7-py3-none-any.whl',
        'defusedxml-0.7.1-py2.py3-none-any.whl',
        'fonttools-4.62.1-py3-none-any.whl',
        'python_pptx-1.0.2-py3-none-any.whl',
        'xlsxwriter-3.2.9-py3-none-any.whl',
    ]
    _wheel_urls = [_haruspex_doc_wheels_url + _w for _w in _doc_wheels]
    await _micropip_for_doc_wheels.install(_wheel_urls, deps=False)
except Exception as _doc_install_err:
    import sys as _sys_for_doc_warn
    print(
        'WARNING: bundled doc-creation wheels failed to install: '
        + str(_doc_install_err),
        file=_sys_for_doc_warn.stderr,
    )
    print(
        '  -> fpdf / python-pptx will not import. Re-run ./scripts/fetch-pyodide.sh',
        file=_sys_for_doc_warn.stderr,
    )

# ----------------------------------------------------------------------
# MEMFS → host flush — mirror file changes back to the user's working dir.
#
# Pyodide's filesystem is in-memory MEMFS. Python's open(), plt.savefig,
# pd.to_csv, np.save, PIL Image.save — all write into MEMFS only by
# default, so files appear to "exist" from the model's POV but never
# touch the host disk. We can't bridge async-to-sync to give Python a
# real-time host FS (no SharedArrayBuffer on Linux/WebKitGTK), so we
# defer the flush to the end of each run.
#
# Two complementary mechanisms cover the cases:
#
# (1) Walk-and-diff: before user code runs, snapshot every file in the
#     workdir + its mtime. After the run, walk the workdir again and
#     flush any file that's new or whose mtime changed. Catches writes
#     made via ANY primitive — zipfile.ZipFile (python-pptx, python-docx,
#     openpyxl), io.FileIO, raw os.write — not just Python-level open().
#
# (2) builtins.open patch: catches write-mode opens against paths OUTSIDE
#     the workdir (matplotlib's /home/pyodide/plot.png default, or any
#     path the model picks explicitly). Those get saved into the workdir
#     by basename. Inside-the-workdir opens are caught by (1) too; we
#     dedupe in the drain.
#
# Read-after-write within the same run still works (MEMFS retains the
# file). Cross-run reads still need the FS tools.
# ----------------------------------------------------------------------

import builtins as _builtins

_haruspex_original_open = _builtins.open
_haruspex_pending_save_paths = set()
_haruspex_workdir_snapshot = {}  # abs_path -> mtime, refreshed per run

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

def _haruspex_snapshot_workdir():
    """Record {abs_path: mtime} for every file currently in the workdir.
    Called before each user run so the post-run drain can detect new /
    modified files regardless of how they were written."""
    import os as _os
    _haruspex_workdir_snapshot.clear()
    if not _haruspex_working_dir_set:
        return
    try:
        cwd = _os.getcwd()
    except Exception:
        return
    for _root, _dirs, _files in _os.walk(cwd):
        for _f in _files:
            _path = _os.path.join(_root, _f)
            try:
                _haruspex_workdir_snapshot[_path] = _os.stat(_path).st_mtime
            except Exception:
                pass

async def _haruspex_flush_one(abs_path, save_as, failed):
    """Read abs_path from MEMFS and write it to host via haruspex.save,
    addressing it as save_as (relative to the workdir). On error, record
    (abs_path, message) into the failed list."""
    try:
        with _haruspex_original_open(abs_path, 'rb') as _f:
            _content = _f.read()
    except Exception as _e:
        failed.append((abs_path, 'could not read from sandbox FS: ' + str(_e)))
        return
    try:
        await _haruspex_save_py(save_as, _content)
    except Exception as _e:
        failed.append((abs_path, str(_e)))

async def _haruspex_drain_pending_saves():
    """Mirror MEMFS changes back to host. See the header comment above for
    the two-phase design. Also propagates Python-side deletions back to
    host so os.remove() / pathlib.unlink() inside the run actually take
    effect on disk. Per-file failures are printed to stderr so the model
    can react on the next turn; one bad save doesn't abort the rest.
    """
    import os as _os
    import sys as _sys
    failed = []
    flushed = set()
    present = set()
    try:
        cwd = _os.getcwd()
    except Exception:
        cwd = None
    # Phase 1: walk the workdir and flush anything new / modified vs. the
    # pre-run snapshot. Catches zipfile-based writes (python-pptx, docx,
    # openpyxl) and any other write that bypasses builtins.open.
    if _haruspex_working_dir_set and cwd:
        for _root, _dirs, _files in _os.walk(cwd):
            for _fname in _files:
                # LibreOffice/Office lock files come and go on the host
                # side; ignore so we don't fight the desktop app.
                if _fname.startswith('.~lock.'):
                    continue
                _path = _os.path.join(_root, _fname)
                present.add(_path)
                try:
                    _mtime = _os.stat(_path).st_mtime
                except Exception:
                    continue
                _prev = _haruspex_workdir_snapshot.get(_path)
                if _prev is not None and _mtime <= _prev:
                    continue
                _rel = _os.path.relpath(_path, cwd)
                await _haruspex_flush_one(_path, _rel, failed)
                flushed.add(_path)
    # Phase 1b: anything that was in the pre-run snapshot but is NOT in
    # MEMFS now was removed by the user's code (os.remove / pathlib
    # unlink / shutil moves). Propagate the deletion to host so the
    # workdir actually reflects the model's intent — otherwise the host
    # file stays and the next pre-run sync re-mirrors it back into MEMFS,
    # silently undoing the deletion.
    if _haruspex_working_dir_set and cwd:
        for _snap_path in list(_haruspex_workdir_snapshot.keys()):
            if _snap_path in present:
                continue
            _rel = _os.path.relpath(_snap_path, cwd)
            # Path escapes workdir → can't address via haruspex.delete.
            # Shouldn't happen since the snapshot only contains workdir
            # files, but be defensive.
            if _rel.startswith('..'):
                continue
            try:
                await _haruspex_delete_py(_rel)
            except Exception as _e:
                failed.append((_snap_path, 'could not delete on host: ' + str(_e)))
    # Phase 2: paths recorded by the builtins.open patch that fall
    # OUTSIDE the workdir (matplotlib's /home/pyodide/plot.png, etc.).
    # Save those by basename so they land in the workdir. Skip ones
    # already covered by phase 1.
    _paths = list(_haruspex_pending_save_paths)
    _haruspex_pending_save_paths.clear()
    for _path in _paths:
        _abs = _path if _os.path.isabs(_path) else (
            _os.path.join(cwd, _path) if cwd else _path
        )
        if _abs in flushed:
            continue
        if cwd and (_abs == cwd or _abs.startswith(cwd + _os.sep)):
            # Inside workdir — phase 1 owns this; either it was flushed
            # or it wasn't actually written (mode='a' on a file that no
            # code touched). Either way, nothing to do.
            continue
        await _haruspex_flush_one(_path, _os.path.basename(_path), failed)
    for _fname, _err in failed:
        print('WARNING: could not save ' + repr(_fname) + ' to working directory: ' + _err,
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
    artifact stands alone, repr(value) for plain values.

    Script-bearing _repr_html_ output (plotly, bokeh, altair, folium,
    ...) gets the interactive=True flag so the chat renders it inside
    a sandboxed iframe (srcdoc) where its embedded <script> tags
    actually execute. Plain markup (pandas DataFrame tables) renders
    via {@html ...} in the message — much cheaper.
    """
    if value is None:
        return ''
    try:
        import pandas as _pd
        if isinstance(value, _pd.DataFrame):
            _total = len(value)
            if _total > 200:
                _haruspex_emit_html(value.head(200)._repr_html_(), 200, _total, False)
                return f'(DataFrame: {_total} rows × {len(value.columns)} cols, first 200 rendered in UI)'
            _haruspex_emit_html(value._repr_html_(), None, None, False)
            return f'(DataFrame: {_total} rows × {len(value.columns)} cols, rendered in UI)'
    except Exception:
        pass
    if hasattr(value, '_repr_html_'):
        try:
            _html = value._repr_html_()
            if _html:
                _interactive = '<script' in _html.lower()
                _haruspex_emit_html(_html, None, None, _interactive)
                if _interactive:
                    return '(rendered as interactive plot in chat)'
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
		// Doc-creation deps that ARE in the Pyodide lockfile (Pillow for
		// fpdf2 + python-pptx; lxml + typing_extensions for python-pptx).
		// Eager-load so the pure-Python wheels we install below can be
		// imported without loadPackagesFromImports having to re-fetch deps
		// on every first `import fpdf` / `import pptx`.
		await pyodide.loadPackage(['Pillow', 'lxml', 'typing_extensions']);
		// Same-origin URL to the wheels bundled by scripts/fetch-pyodide.sh
		// into static/pyodide/wheels/. SvelteKit serves static/ at the
		// origin root; this works under `npm run dev` and Tauri prod alike.
		pyodide.globals.set(
			'_haruspex_doc_wheels_url',
			new URL('/pyodide/wheels/', self.location.origin).href
		);
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
		pyodide.globals.set('_haruspex_delete', (filename: unknown) => {
			const requestId = crypto.randomUUID();
			return new Promise<{ path: string }>((resolve, reject) => {
				pendingDeletes.set(requestId, { resolve, reject });
				post({
					kind: 'delete_request',
					id: currentRunId,
					request_id: requestId,
					filename: String(filename)
				});
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
			(html: unknown, shown: number | null, total: number | null, interactive: unknown) => {
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
					truncated,
					interactive: !!interactive
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
		const runtimeCfg = await new Promise<{ mode: string; workingDirSet: boolean }>((resolve) => {
			proxyModeWaiter = resolve;
			post({ kind: 'get_proxy_mode' });
		});
		pyodide.globals.set('_haruspex_skip_http_patch', runtimeCfg.mode === 'manual');
		pyodide.globals.set('_haruspex_working_dir_set', runtimeCfg.workingDirSet);
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

async function handleSyncWorkdir(msg: {
	sync_id: string;
	workdir_abs: string;
	to_sync: Array<{ path: string; abs_path: string; bytes: Uint8Array; mtime: number }>;
	deleted: string[];
	skipped: Array<{ path: string; reason: string }>;
}): Promise<void> {
	if (!pyodide) {
		post({ kind: 'sync_workdir_ack', sync_id: msg.sync_id, error: 'pyodide not loaded' });
		return;
	}
	try {
		// pyodide.FS exposes Emscripten's filesystem API. We use it directly
		// instead of going through Python — much faster and avoids spinning
		// up runPythonAsync for what is essentially memcpy work.
		const fs = (pyodide as unknown as { FS: PyodideFS }).FS;
		// Make sure the workdir parent directory exists so chdir succeeds.
		try {
			fs.mkdirTree(msg.workdir_abs);
		} catch {
			// already exists, fine
		}
		for (const file of msg.to_sync) {
			// Defensive copy: Pyodide's structured-clone gives us a fresh
			// Uint8Array but writeFile is happier with a plain one.
			const bytes =
				file.bytes instanceof Uint8Array ? new Uint8Array(file.bytes) : new Uint8Array(0);
			const lastSlash = file.abs_path.lastIndexOf('/');
			if (lastSlash > 0) {
				try {
					fs.mkdirTree(file.abs_path.slice(0, lastSlash));
				} catch {
					// dir already exists
				}
			}
			try {
				fs.writeFile(file.abs_path, bytes);
			} catch (err) {
				currentStderr += '[haruspex.sync] failed to write ' + file.path + ': ' + String(err) + '\n';
			}
		}
		for (const path of msg.deleted) {
			const abs = msg.workdir_abs + '/' + path;
			try {
				if (fs.analyzePath(abs).exists) fs.unlink(abs);
			} catch {
				// best effort
			}
		}
		for (const sk of msg.skipped) {
			currentStderr += '[haruspex.sync] skipped ' + sk.path + ': ' + sk.reason + '\n';
		}
		// Chdir Python into the workdir so the model's relative paths
		// resolve to the synced files.
		await pyodide.runPythonAsync(
			'import os as _os; _os.chdir(' + JSON.stringify(msg.workdir_abs) + ')'
		);
		post({ kind: 'sync_workdir_ack', sync_id: msg.sync_id });
	} catch (err) {
		post({
			kind: 'sync_workdir_ack',
			sync_id: msg.sync_id,
			error: err instanceof Error ? err.message : String(err)
		});
	}
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
		// dictionary lookup if matplotlib is loaded. Snapshot the workdir
		// alongside so the post-run drain can detect any new/modified
		// files — including writes from libraries that bypass
		// builtins.open (zipfile-based: python-pptx, python-docx, etc.).
		await pyodide.runPythonAsync(
			'_haruspex_install_matplotlib_hook(); _haruspex_snapshot_workdir()'
		);
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
				w({ mode: msg.mode, workingDirSet: msg.workingDirSet });
			}
			break;
		case 'sync_workdir_files':
			void handleSyncWorkdir(msg);
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
		case 'delete_response': {
			const pending = pendingDeletes.get(msg.request_id);
			if (!pending) break;
			pendingDeletes.delete(msg.request_id);
			if (msg.ok) {
				pending.resolve({ path: msg.path ?? '' });
			} else {
				pending.reject(new Error(msg.error ?? 'haruspex.delete failed'));
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
