# Haruspex workspace iframe — Python init.
#
# Provides the haruspex helper module and the matplotlib / DataFrame
# rendering hooks. The JS side (static/workspace/index.html) registers
# the bridge globals (_haruspex_emit_image, _haruspex_emit_html,
# _haruspex_stage_show_html, _haruspex_stage_clear, _haruspex_register_task,
# _haruspex_stop_tasks) before running this file.
#
# MVP scope (step 3): no FS bridge, no fetch override, no workdir drain.
# Those land in step 4 — they need parent-postMessage round-trips that
# this MVP runtime doesn't carry yet.

import asyncio as _asyncio
import io as _io
import sys as _sys
import types as _types

# ------------------------------------------------------------------
# haruspex module
# ------------------------------------------------------------------

_haruspex_mod = _types.ModuleType('haruspex')
_haruspex_mod.__doc__ = (
    'Haruspex workspace bridge — render HTML to the visible stage, '
    'manage background tasks. Save/fetch helpers land in step 4.'
)


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


# Background-task registry. Kept Python-side because asyncio.Task
# PyProxies passed as args into a JS function are auto-destroyed when
# that JS function returns (Pyodide 0.27+ ownership model), so a JS
# Set would only hold dead proxies. add_done_callback / discard keeps
# the set self-pruning when tasks finish naturally.
_haruspex_tasks = set()


def _haruspex_spawn(coro):
    """Launch a coroutine as a background task and register it so
    haruspex.stop_tasks() can cancel it later.

    Idiomatic for long-running interactive code (pygame game loop,
    custom animations). The submitted run_python call returns as soon
    as this function returns; the task keeps running in the iframe.

    Usage:
        import asyncio, pygame, haruspex
        async def game():
            while True:
                # ... event loop ...
                await asyncio.sleep(0)
        haruspex.spawn(game())
    """
    task = _asyncio.ensure_future(coro)
    _haruspex_tasks.add(task)
    task.add_done_callback(_haruspex_tasks.discard)
    return task


def _haruspex_stop_tasks_py():
    """Cancel every asyncio task registered via haruspex.spawn.

    Returns the number of tasks that were cancelled.
    """
    cancelled = 0
    for t in list(_haruspex_tasks):
        if not t.done():
            t.cancel()
            cancelled += 1
    _haruspex_tasks.clear()
    return cancelled


_haruspex_mod.show_html = _haruspex_show_html
_haruspex_mod.clear_stage = _haruspex_clear_stage
_haruspex_mod.stop_tasks = _haruspex_stop_tasks_py
_haruspex_mod.spawn = _haruspex_spawn

_sys.modules['haruspex'] = _haruspex_mod


# ------------------------------------------------------------------
# matplotlib plt.show capture — same hook the legacy worker installs.
# Idempotent (sentinel-guarded), re-run safely each run.
# ------------------------------------------------------------------

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


# ------------------------------------------------------------------
# Last-expression postprocess — DataFrame _repr_html_, anything with a
# _repr_html_, fall back to repr(). Returns the string to use as the
# textual 'result' field; rich representations also emit an HTML
# artifact as a side effect.
# ------------------------------------------------------------------

def _haruspex_postprocess(value):
    if value is None:
        return ''
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
                _haruspex_emit_html(html, None, None)
                return '(rendered as HTML in UI)'
        except Exception:
            pass
    try:
        return repr(value)
    except Exception as e:
        return f'<repr failed: {e}>'
