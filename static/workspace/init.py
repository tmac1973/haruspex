# Haruspex workspace iframe — Python init.
#
# Loaded by static/workspace/index.html via pyodide.runPythonAsync after
# the JS side has registered the bridge globals:
#
#   _haruspex_emit_image, _haruspex_emit_html         — chat-inline artifacts
#   _haruspex_stage_show_html, _haruspex_stage_clear  — workspace stage I/O
#   _haruspex_fetch, _haruspex_save, _haruspex_delete — parent-routed Tauri
#                                                       invokes (no
#                                                       __TAURI_INTERNALS__
#                                                       in child iframes)
#   _haruspex_doc_wheels_url                          — origin URL for the
#                                                       bundled fpdf2 /
#                                                       python-pptx wheels
#   _haruspex_skip_http_patch                         — runtime flag set
#                                                       when an app proxy is
#                                                       configured (manual)
#   _haruspex_working_dir_set                         — runtime flag set
#                                                       when the active chat
#                                                       has a workdir
#
# The bulk of this file mirrors HARUSPEX_INIT_PY from python.worker.ts,
# adapted for the iframe context. After step 9 the legacy worker is
# deleted and this file becomes the only place these helpers live.

import ast as _ast
import asyncio as _asyncio
import builtins as _builtins
import io as _io
import sys as _sys
import types as _types


# ======================================================================
# haruspex module — save / delete / show_html / clear_stage / spawn /
# stop_tasks
# ======================================================================

_haruspex_mod = _types.ModuleType('haruspex')
_haruspex_mod.__doc__ = (
    'Haruspex sandbox bridge — save/delete files in the active chat workdir, '
    'render HTML to the workspace stage, manage background tasks.'
)


async def _haruspex_save_py(filename, content):
    """Save a file into the active chat's working directory.

    Args:
        filename: Path relative to the working dir. Absolute paths and
                  '..' traversal are rejected by the Rust side.
        content:  str (UTF-8 encoded) or bytes/bytearray.

    Returns:
        dict with 'path' (absolute host path written) and 'bytes' (count).

    Raises:
        TypeError if content is the wrong type.
        OSError on save failure (no workdir, path escape, write error).
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


async def _haruspex_delete_py(filename):
    """Delete a file in the active chat's working directory.

    Same path-safety rules as haruspex.save — relative to workdir, no '..'.
    Used by the post-run drain to propagate Python-side deletions
    (os.remove, pathlib.unlink) back to the host.
    """
    result = await _haruspex_delete(filename)
    if hasattr(result, 'to_py'):
        result = result.to_py()
    return result


def _haruspex_show_html(html):
    """Replace the workspace stage with raw HTML.

    Re-executes any <script> tags inside `html` so dashboard HTML from
    plotly / bokeh / altair wires up. Auto-switches the parent's active
    tab to Workspace the first time the stage is written in a turn.
    """
    if not isinstance(html, str):
        raise TypeError('haruspex.show_html: html must be a str')
    _haruspex_stage_show_html(html)


def _haruspex_clear_stage():
    """Empty the stage and re-create the default canvas. Use before
    rendering new content when you don't want stale DOM lingering."""
    _haruspex_stage_clear()


# Background-task registry. Python-side because asyncio.Task PyProxies
# passed as args into a JS function are auto-destroyed when that JS
# function returns (Pyodide 0.27+ ownership model); a JS Set would only
# hold dead proxies. add_done_callback / discard keeps the set
# self-pruning when tasks finish naturally.
_haruspex_tasks = set()


def _haruspex_spawn(coro):
    """Launch a coroutine as a background task and register it so
    haruspex.stop_tasks() can cancel it later.

    Idiomatic for long-running interactive code (pygame game loop,
    custom animations). The submitted run_python call returns as soon
    as this function returns; the task keeps running in the iframe.
    """
    task = _asyncio.ensure_future(coro)
    _haruspex_tasks.add(task)
    task.add_done_callback(_haruspex_tasks.discard)
    return task


def _haruspex_stop_tasks_py():
    """Cancel every asyncio task registered via haruspex.spawn.
    Returns the number of tasks that were cancelled."""
    cancelled = 0
    for t in list(_haruspex_tasks):
        if not t.done():
            t.cancel()
            cancelled += 1
    _haruspex_tasks.clear()
    return cancelled


_haruspex_mod.save = _haruspex_save_py
_haruspex_mod.delete = _haruspex_delete_py
_haruspex_mod.show_html = _haruspex_show_html
_haruspex_mod.clear_stage = _haruspex_clear_stage
_haruspex_mod.spawn = _haruspex_spawn
_haruspex_mod.stop_tasks = _haruspex_stop_tasks_py

_sys.modules['haruspex'] = _haruspex_mod


# ======================================================================
# pyodide.http.pyfetch override — route through the app's reqwest+proxy
# stack so model-authored `await pyodide.http.pyfetch(url)` calls honor
# the user's app-level proxy setting (the WebView's fetch doesn't see it).
# ======================================================================

class _SandboxFetchResponse:
    """Thin stand-in for pyodide.http.FetchResponse covering the common
    methods (.bytes / .string / .text / .json / .memoryview / .ok /
    .raise_for_status). Body is delivered up front as bytes; the async
    accessors are stubs that return immediately."""
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


try:
    import pyodide.http as _pyodide_http
    _pyodide_http.pyfetch = _haruspex_pyfetch
except ImportError:
    pass


# ======================================================================
# urllib / requests / httpx routing.
#
# Without intervention, the standard `urllib.request.urlopen` (and
# third-party `requests` / `httpx`) fails with "URLError: unknown url
# type: https" because the WASM environment has no real socket layer.
#
# Two cases:
#  - no app proxy → install pyodide-http and patch_all() so urllib uses
#    sync XMLHttpRequest under the hood (works in browser).
#  - app proxy configured → pyodide-http's XHR path bypasses our
#    pyfetch override and the proxy. Replace urllib.request.urlopen
#    with a stub that raises a SPECIFIC error naming pyfetch as the
#    fix — the generic urllib error caused the model to abandon Python
#    entirely and fall back to web_search hallucinations.
# ======================================================================

if not _haruspex_skip_http_patch:
    try:
        import micropip as _micropip_for_http_patch
        await _micropip_for_http_patch.install('pyodide-http')
        import pyodide_http
        pyodide_http.patch_all()
    except Exception as _patch_err:
        print(
            'WARNING: pyodide-http patch failed: ' + str(_patch_err),
            file=_sys.stderr,
        )
        print(
            '  -> urllib/requests/httpx will not work; use pyodide.http.pyfetch directly.',
            file=_sys.stderr,
        )
else:
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


# ======================================================================
# Doc-creation wheels — install fpdf2 + python-pptx + xlsxwriter + their
# pure-Python deps from the bundled static/pyodide/wheels/ directory so
# the model can produce PDFs / PowerPoints / XLSX offline.
# Pillow / lxml / typing_extensions were already loaded JS-side via
# pyodide.loadPackage. deps=False keeps micropip from re-resolving them
# against PyPI (would fail offline).
# Failure here is non-fatal; the sandbox still boots and the model gets
# a clean ImportError if it reaches for fpdf / pptx / xlsxwriter.
# ======================================================================

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
    print(
        'WARNING: bundled doc-creation wheels failed to install: '
        + str(_doc_install_err),
        file=_sys.stderr,
    )
    print(
        '  -> fpdf / python-pptx will not import. Re-run ./scripts/fetch-pyodide.sh',
        file=_sys.stderr,
    )


# ======================================================================
# MEMFS → host flush.
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
# (2) builtins.open patch: catches write-mode opens against paths
#     OUTSIDE the workdir (matplotlib's /home/pyodide/plot.png default,
#     or any path the model picks explicitly). Those get saved into the
#     workdir by basename. Inside-the-workdir opens are caught by (1)
#     too; we dedupe in the drain.
#
# Read-after-write within the same run still works (MEMFS retains the
# file). Cross-run reads still need the FS tools.
# ======================================================================

_haruspex_original_open = _builtins.open
_haruspex_pending_save_paths = set()
_haruspex_workdir_snapshot = {}  # abs_path -> mtime, refreshed per run

# Pyodide-internal scratch paths that are NOT flushed to host.
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
    Called pre-run so the post-run drain can detect new/modified files
    regardless of how they were written."""
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
    addressing it as save_as (relative to the workdir). On error,
    record (abs_path, message) into the failed list."""
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
    """Mirror MEMFS changes back to host. Two-phase design (see header).
    Also propagates Python-side deletions back to host so os.remove() /
    pathlib.unlink() inside the run actually take effect on disk.
    Per-file failures are printed to stderr; one bad save doesn't abort
    the rest.
    """
    import os as _os
    failed = []
    flushed = set()
    present = set()
    try:
        cwd = _os.getcwd()
    except Exception:
        cwd = None
    # Phase 1: walk + diff (catches zipfile writes etc.)
    if _haruspex_working_dir_set and cwd:
        for _root, _dirs, _files in _os.walk(cwd):
            for _fname in _files:
                # LibreOffice/Office lock files come and go on host side;
                # ignore so we don't fight the desktop app.
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
    # Phase 1b: in-snapshot but absent now → propagate the deletion.
    if _haruspex_working_dir_set and cwd:
        for _snap_path in list(_haruspex_workdir_snapshot.keys()):
            if _snap_path in present:
                continue
            _rel = _os.path.relpath(_snap_path, cwd)
            if _rel.startswith('..'):
                continue
            try:
                await _haruspex_delete_py(_rel)
            except Exception as _e:
                failed.append((_snap_path, 'could not delete on host: ' + str(_e)))
    # Phase 2: builtins.open paths outside the workdir → save by basename.
    _paths = list(_haruspex_pending_save_paths)
    _haruspex_pending_save_paths.clear()
    for _path in _paths:
        _abs = _path if _os.path.isabs(_path) else (
            _os.path.join(cwd, _path) if cwd else _path
        )
        if _abs in flushed:
            continue
        if cwd and (_abs == cwd or _abs.startswith(cwd + _os.sep)):
            continue
        await _haruspex_flush_one(_path, _os.path.basename(_path), failed)
    for _fname, _err in failed:
        print(
            'WARNING: could not save ' + repr(_fname) + ' to working directory: ' + _err,
            file=_sys.stderr,
        )


# ======================================================================
# matplotlib plt.show capture — emit each open figure as an inline-chat
# image artifact. Idempotent (sentinel-guarded), re-run each run.
# ======================================================================

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


# ======================================================================
# Last-expression postprocess — DataFrame _repr_html_, anything with a
# _repr_html_, fall back to repr(). Returns the string for the textual
# 'result' field; rich representations also emit an HTML artifact as a
# side effect.
# ======================================================================

def _haruspex_postprocess(value):
    if value is None:
        return ''
    # Pandas DataFrames render cleanly as inline-chat HTML — pure markup,
    # no scripts. Handle first so we don't fall into the generic
    # _repr_html_ branch (which would route them to the workspace).
    try:
        import pandas as _pd
        if isinstance(value, _pd.DataFrame):
            total = len(value)
            if total > 200:
                _haruspex_emit_html(value.head(200)._repr_html_(), 200, total)
                return f'(DataFrame: {total} rows x {len(value.columns)} cols, first 200 rendered in UI)'
            _haruspex_emit_html(value._repr_html_(), None, None)
            return f'(DataFrame: {total} rows x {len(value.columns)} cols, rendered in UI)'
    except Exception:
        pass
    if hasattr(value, '_repr_html_'):
        try:
            html = value._repr_html_()
            if html:
                # Script-bearing HTML (plotly, bokeh, altair, folium, etc.)
                # can't render in the chat — chat artifacts go through
                # {@html ...} which doesn't execute <script> tags, so the
                # user would see an empty placeholder. Route these to the
                # workspace stage instead; haruspex.show_html re-executes
                # the embedded scripts so the figure draws.
                if '<script' in html.lower():
                    _haruspex_stage_show_html(html)
                    return '(rendered in Workspace tab)'
                _haruspex_emit_html(html, None, None)
                return '(rendered as HTML in UI)'
        except Exception:
            pass
    try:
        return repr(value)
    except Exception as e:
        return f'<repr failed: {e}>'


# ======================================================================
# Cooperative-yield AST auto-transform.
#
# Pyodide on the iframe main thread shares the UI event loop with the
# parent on WebKitGTK. Models trained on desktop pygame examples emit a
# synchronous top-level loop like:
#
#     while running:
#         for event in pygame.event.get(): ...
#         # update + draw
#         pygame.display.flip()
#         clock.tick(60)
#
# With no `await asyncio.sleep(0)` anywhere — this freezes the iframe
# AND the parent UI (same event loop). The system-prompt nudge and
# tool description alone don't reliably change what the model writes —
# the fix has to live in the runtime.
#
# This transform wraps user code in an async function, declares every
# top-level name `global` so nested code paths still see them in the
# module namespace, and injects `await asyncio.sleep(0)` at the start
# of every while/for loop body. The browser event loop gets a turn
# between iterations and the UI stays responsive.
#
# Code that already uses async patterns (defines an async def, calls
# asyncio.ensure_future / asyncio.create_task / asyncio.run, calls
# haruspex.spawn) is left untouched. Code with no loops is also
# untouched — there's nothing to fix.
#
# Failures (parse errors, unparse glitches) silently fall back to the
# original source — pyodide.runPythonAsync will surface the real error.
# ======================================================================


def _haruspex_workspace_already_async(tree):
    for node in _ast.walk(tree):
        if isinstance(node, _ast.AsyncFunctionDef):
            return True
        if isinstance(node, _ast.Call):
            func = node.func
            if isinstance(func, _ast.Attribute) and func.attr in (
                'ensure_future', 'create_task', 'run', 'spawn'
            ):
                if isinstance(func.value, _ast.Name) and func.value.id in (
                    'asyncio', 'haruspex'
                ):
                    return True
    return False


def _haruspex_workspace_has_loop(tree):
    for node in _ast.walk(tree):
        if isinstance(node, (_ast.While, _ast.For)):
            return True
    return False


def _haruspex_workspace_make_yield():
    # `await __haruspex_asyncio.sleep(0)` as a fresh AST node. We use
    # the renamed import so we don't depend on user code also having
    # `import asyncio`. A new node per injection so each loop body
    # owns its statement.
    return _ast.Expr(
        value=_ast.Await(
            value=_ast.Call(
                func=_ast.Attribute(
                    value=_ast.Name(id='__haruspex_asyncio', ctx=_ast.Load()),
                    attr='sleep',
                    ctx=_ast.Load(),
                ),
                args=[_ast.Constant(value=0)],
                keywords=[],
            )
        )
    )


def _haruspex_workspace_inject_yields(stmts):
    """Walk statements, injecting `await asyncio.sleep(0)` at the start
    of every while/for body at this lexical level. Recurses through
    if/try/with (same execution scope) but stops at function/class
    definitions (await would be a syntax error inside a sync nested
    function)."""
    for stmt in stmts:
        if isinstance(stmt, (_ast.While, _ast.For, _ast.AsyncFor)):
            stmt.body.insert(0, _haruspex_workspace_make_yield())
            _haruspex_workspace_inject_yields(stmt.body)
            if stmt.orelse:
                _haruspex_workspace_inject_yields(stmt.orelse)
        elif isinstance(stmt, _ast.If):
            _haruspex_workspace_inject_yields(stmt.body)
            _haruspex_workspace_inject_yields(stmt.orelse)
        elif isinstance(stmt, _ast.Try):
            _haruspex_workspace_inject_yields(stmt.body)
            for handler in stmt.handlers:
                _haruspex_workspace_inject_yields(handler.body)
            _haruspex_workspace_inject_yields(stmt.orelse)
            _haruspex_workspace_inject_yields(stmt.finalbody)
        elif isinstance(stmt, (_ast.With, _ast.AsyncWith)):
            _haruspex_workspace_inject_yields(stmt.body)
        # FunctionDef / AsyncFunctionDef / ClassDef / others: don't
        # recurse — bodies have their own scope.


def _haruspex_workspace_assign_names(target):
    if isinstance(target, _ast.Name):
        return [target.id]
    if isinstance(target, (_ast.Tuple, _ast.List)):
        names = []
        for elt in target.elts:
            names.extend(_haruspex_workspace_assign_names(elt))
        return names
    if isinstance(target, _ast.Starred):
        return _haruspex_workspace_assign_names(target.value)
    return []


def _haruspex_workspace_top_level_names(stmts):
    names = []
    for node in stmts:
        if isinstance(node, _ast.Assign):
            for target in node.targets:
                names.extend(_haruspex_workspace_assign_names(target))
        elif isinstance(node, (_ast.AugAssign, _ast.AnnAssign)):
            names.extend(_haruspex_workspace_assign_names(node.target))
        elif isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef, _ast.ClassDef)):
            names.append(node.name)
        elif isinstance(node, _ast.Import):
            for alias in node.names:
                first = (alias.asname or alias.name).split('.')[0]
                names.append(first)
        elif isinstance(node, _ast.ImportFrom):
            for alias in node.names:
                if alias.name == '*':
                    continue  # can't declare wildcard globals
                names.append(alias.asname or alias.name)
    return sorted({n for n in names if n.isidentifier() and not n.startswith('__')})


def _haruspex_workspace_transform(source):
    """Auto-wrap synchronous-style user code into a cooperative
    coroutine. Returns the transformed source string, or the original
    source unchanged if the transform isn't needed or fails."""
    try:
        tree = _ast.parse(source)
    except Exception:
        return source

    if _haruspex_workspace_already_async(tree):
        return source
    if not _haruspex_workspace_has_loop(tree):
        return source

    _haruspex_workspace_inject_yields(tree.body)
    names = _haruspex_workspace_top_level_names(tree.body)

    body = list(tree.body)
    if names:
        body.insert(0, _ast.Global(names=names))

    async_fn = _ast.AsyncFunctionDef(
        name='__haruspex_workspace_main',
        args=_ast.arguments(
            posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]
        ),
        body=body,
        decorator_list=[],
        returns=None,
        type_comment=None,
    )

    # Schedule the async task and store its Task object as a
    # module-level name so the asyncio loop keeps a strong reference.
    # The caller (static/workspace/index.html) runs this transformed
    # source via SYNC pyodide.runPython — the call returns immediately
    # after ensure_future schedules the task. runPythonAsync would
    # wait for the asyncio loop to be idle, which never happens for an
    # infinite game loop.
    schedule = _ast.parse(
        '__haruspex_workspace_task = '
        '__haruspex_asyncio.ensure_future(__haruspex_workspace_main())'
    ).body[0]
    import_asyncio = _ast.parse('import asyncio as __haruspex_asyncio').body[0]

    new_module = _ast.Module(
        body=[import_asyncio, async_fn, schedule],
        type_ignores=[],
    )
    _ast.fix_missing_locations(new_module)

    try:
        return _ast.unparse(new_module)
    except Exception:
        return source
