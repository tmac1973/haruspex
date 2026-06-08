#!/bin/bash
# Downloads Pyodide core distribution + bundled wheels for the unified
# python sandbox (phase 13):
#   - static/pyodide/wheels/  → doc-creation wheels (fpdf2, python-pptx,
#                               etc.) installed via micropip.install(
#                               <local URL>, deps=False)
#   - static/pyodide/*.whl    → workspace packages (pygame-ce, bokeh,
#                               altair + transitive deps) loaded via
#                               pyodide.loadPackage(...) with
#                               indexURL='/pyodide/'
#
# Idempotent — skips work if the pinned versions are already present.
#
# Usage: ./scripts/fetch-pyodide.sh

set -e

# Resolve a Python interpreter for the JSON-parsing helpers below. Dev
# machines and macOS/Linux CI have `python3`; Windows Git Bash often only
# exposes `python`. Either works — both helpers are plain stdlib json.
if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
else
    echo "ERROR: need python3 (or python) on PATH to resolve wheel metadata" >&2
    exit 1
fi

PYODIDE_VERSION="0.29.4"

# PyPI wheels we install by explicit local URL (deps=False), NOT via the
# Pyodide lockfile — either because they're not in the lockfile at all
# (plotly) or because we want them offline for doc generation. Pillow /
# lxml / typing_extensions are inside Pyodide and loaded via loadPackage.
#
#   - fpdf2 / python-pptx / xlsxwriter (+ pure deps) → installed at boot
#     for offline PDF/PPTX/XLSX generation (see HARUSPEX_INIT_PY).
#   - plotly → installed LAZILY from its local wheel on first `import
#     plotly` (it unzips large; see _haruspex_local_wheels in the worker).
#     Its runtime deps narwhals (vendored at root) + packaging (loaded via
#     matplotlib) are already present.
WHEELS_VERSION="2"
WHEELS=(
    "fpdf2-2.8.7-py3-none-any.whl"
    "defusedxml-0.7.1-py2.py3-none-any.whl"
    "fonttools-4.62.1-py3-none-any.whl"
    "python_pptx-1.0.2-py3-none-any.whl"
    "xlsxwriter-3.2.9-py3-none-any.whl"
    "plotly-6.8.0-py3-none-any.whl"
)

# Interactive-plot wheels: full transitive dep tree for bokeh + altair,
# derived from static/pyodide/pyodide-lock.json. These sit at the root
# of static/pyodide/ (not in wheels/) so pyodide.loadPackage('<name>')
# resolves them via the lockfile when indexURL='/pyodide/'. Re-derive
# whenever PYODIDE_VERSION changes — wheel filenames are version-
# specific.
WORKSPACE_WHEELS_VERSION="2"
WORKSPACE_WHEELS=(
    "altair-6.0.0-py3-none-any.whl"
    "attrs-25.2.0-py3-none-any.whl"
    "bokeh-3.6.3-py3-none-any.whl"
    "contourpy-1.3.1-cp313-cp313-pyemscripten_2025_0_wasm32.whl"
    "jinja2-3.1.6-py3-none-any.whl"
    "jsonschema-4.23.0-py3-none-any.whl"
    "jsonschema_specifications-2024.10.1-py3-none-any.whl"
    "markupsafe-3.0.2-cp313-cp313-pyemscripten_2025_0_wasm32.whl"
    "micropip-0.11.1-py3-none-any.whl"
    "narwhals-2.15.0-py3-none-any.whl"
    "numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl"
    "packaging-26.2-py3-none-any.whl"
    "pandas-2.3.3-cp313-cp313-pyemscripten_2025_0_wasm32.whl"
    "pillow-11.3.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl"
    "pyrsistent-0.20.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl"
    "python_dateutil-2.9.0.post0-py2.py3-none-any.whl"
    "pytz-2025.2-py2.py3-none-any.whl"
    "pyyaml-6.0.2-cp313-cp313-pyemscripten_2025_0_wasm32.whl"
    "referencing-0.36.2-py3-none-any.whl"
    "rpds_py-0.30.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl"
    "six-1.17.0-py2.py3-none-any.whl"
    "typing_extensions-4.15.0-py3-none-any.whl"
    "xyzservices-2025.1.0-py3-none-any.whl"
)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DEST_DIR="$PROJECT_ROOT/static/pyodide"
WHEELS_DIR="$DEST_DIR/wheels"
VERSION_MARKER="$DEST_DIR/.haruspex-pyodide-version"
WHEELS_MARKER="$WHEELS_DIR/.haruspex-wheels-version"
WORKSPACE_WHEELS_MARKER="$DEST_DIR/.haruspex-workspace-wheels-version"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# --- Pyodide core ---
if [ -f "$VERSION_MARKER" ] && [ "$(cat "$VERSION_MARKER")" = "$PYODIDE_VERSION" ]; then
    echo ">> Pyodide $PYODIDE_VERSION already present at static/pyodide/"
else
    echo ">> Downloading Pyodide $PYODIDE_VERSION (core, ~12 MB)..."

    URL="https://github.com/pyodide/pyodide/releases/download/$PYODIDE_VERSION/pyodide-core-$PYODIDE_VERSION.tar.bz2"
    if ! curl -fL --progress-bar -o "$TMP_DIR/pyodide.tar.bz2" "$URL"; then
        echo "   ERROR: failed to download $URL"
        exit 1
    fi

    echo "   Extracting..."
    tar -xjf "$TMP_DIR/pyodide.tar.bz2" -C "$TMP_DIR"

    if [ ! -d "$TMP_DIR/pyodide" ]; then
        echo "   ERROR: expected 'pyodide/' directory inside tarball"
        exit 1
    fi

    mkdir -p "$DEST_DIR"
    # Preserve any bundled wheels from a previous run:
    #   wheels/             → chat-sandbox doc wheels (subdir)
    #   *.whl at root       → workspace wheels (loaded by indexURL)
    #   .haruspex-*         → version markers
    find "$DEST_DIR" -mindepth 1 -maxdepth 1 \
        ! -name 'wheels' \
        ! -name '*.whl' \
        ! -name '.haruspex-*' \
        -exec rm -rf {} +
    # Move new core files in, but never overwrite a wheel we deliberately
    # bundled (the tarball includes a stock set; ours is curated).
    for src in "$TMP_DIR/pyodide"/*; do
        base="$(basename "$src")"
        if [[ "$base" == *.whl && -e "$DEST_DIR/$base" ]]; then
            continue
        fi
        mv -f "$src" "$DEST_DIR/"
    done
    echo "$PYODIDE_VERSION" > "$VERSION_MARKER"

    echo "   Installed Pyodide $PYODIDE_VERSION to static/pyodide/"
fi

# --- Doc-creation wheels (fpdf2 + python-pptx + transitive non-Pyodide deps) ---
if [ -f "$WHEELS_MARKER" ] && [ "$(cat "$WHEELS_MARKER")" = "$WHEELS_VERSION" ]; then
    echo ">> Bundled doc wheels v$WHEELS_VERSION already present at static/pyodide/wheels/"
else
    echo ">> Downloading doc-creation wheels (fpdf2, python-pptx, deps) into static/pyodide/wheels/..."
    mkdir -p "$WHEELS_DIR"
    rm -f "$WHEELS_DIR"/*.whl "$WHEELS_MARKER"

    for wheel in "${WHEELS[@]}"; do
        # PyPI's /packages/<wheel> URL doesn't exist; resolve via simple index.
        # We use the JSON API to look up the file URL deterministically.
        pkg="${wheel%%-*}"
        # python_pptx → python-pptx for the API; underscores stay valid too.
        pkg_url_name="${pkg//_/-}"
        json=$(curl -fsSL "https://pypi.org/pypi/${pkg_url_name}/json")
        file_url=$(echo "$json" | "$PYTHON_BIN" -c "
import json, sys
data = json.load(sys.stdin)
target = '$wheel'
for ver_files in data['releases'].values():
    for f in ver_files:
        if f['filename'] == target:
            print(f['url'])
            sys.exit(0)
sys.exit(1)
")
        if [ -z "$file_url" ]; then
            echo "   ERROR: could not resolve URL for $wheel on PyPI"
            exit 1
        fi
        echo "   $wheel"
        curl -fsSL -o "$WHEELS_DIR/$wheel" "$file_url"
    done

    echo "$WHEELS_VERSION" > "$WHEELS_MARKER"
    echo "   Installed $(ls "$WHEELS_DIR"/*.whl | wc -l) wheels to static/pyodide/wheels/"
fi

# --- plotly.min.js (offline interactive rendering) ---
# The chat worker points plotly's include_plotlyjs at a local URL
# (/plotly/plotly.min.js) so rendered figures load their JS from the app
# instead of cdn.plot.ly — zero network. Extract the exact build plotly
# bundles from the wheel we just vendored, so the JS always matches the
# Python package version. Marker tracks WHEELS_VERSION (which gates the
# plotly wheel).
PLOTLY_JS_DIR="$PROJECT_ROOT/static/plotly"
PLOTLY_JS_MARKER="$PLOTLY_JS_DIR/.haruspex-plotlyjs-version"
PLOTLY_WHEEL_FILE="$(ls "$WHEELS_DIR"/plotly-*.whl 2>/dev/null | head -1)"
if [ -f "$PLOTLY_JS_MARKER" ] && [ "$(cat "$PLOTLY_JS_MARKER")" = "$WHEELS_VERSION" ]; then
    echo ">> plotly.min.js v$WHEELS_VERSION already present at static/plotly/"
elif [ -z "$PLOTLY_WHEEL_FILE" ]; then
    echo "   ERROR: no plotly wheel in $WHEELS_DIR — cannot extract plotly.min.js"
    exit 1
else
    echo ">> Extracting plotly.min.js from $(basename "$PLOTLY_WHEEL_FILE") into static/plotly/..."
    mkdir -p "$PLOTLY_JS_DIR"
    PLOTLY_WHEEL_FILE="$PLOTLY_WHEEL_FILE" PLOTLY_JS_DIR="$PLOTLY_JS_DIR" "$PYTHON_BIN" -c "
import os, zipfile
z = zipfile.ZipFile(os.environ['PLOTLY_WHEEL_FILE'])
data = z.read('plotly/package_data/plotly.min.js')
open(os.path.join(os.environ['PLOTLY_JS_DIR'], 'plotly.min.js'), 'wb').write(data)
print('   plotly.min.js: %.1f MB' % (len(data) / 1e6))
"
    echo "$WHEELS_VERSION" > "$PLOTLY_JS_MARKER"
fi

# --- Workspace wheels (pygame-ce + bokeh + altair + transitive deps) ---
# Pulled from the Pyodide CDN — these are pre-built for Pyodide and listed
# in the local pyodide-lock.json, so the workspace iframe can resolve them
# via pyodide.loadPackage(...) with indexURL='/pyodide/'. Required by the
# phase-13 unified sandbox.
if [ -f "$WORKSPACE_WHEELS_MARKER" ] \
    && [ "$(cat "$WORKSPACE_WHEELS_MARKER")" = "$WORKSPACE_WHEELS_VERSION" ]; then
    echo ">> Workspace wheels v$WORKSPACE_WHEELS_VERSION already present at static/pyodide/"
else
    echo ">> Downloading workspace wheels (pygame-ce, bokeh, altair, deps) into static/pyodide/..."
    rm -f "$WORKSPACE_WHEELS_MARKER"
    cdn_base="https://cdn.jsdelivr.net/pyodide/v$PYODIDE_VERSION/full"
    total_bytes=0
    for wheel in "${WORKSPACE_WHEELS[@]}"; do
        if [ -f "$DEST_DIR/$wheel" ]; then
            echo "   $wheel (cached)"
        else
            echo "   $wheel"
            curl -fsSL -o "$DEST_DIR/$wheel" "$cdn_base/$wheel"
        fi
        size=$(stat -c %s "$DEST_DIR/$wheel" 2>/dev/null || stat -f %z "$DEST_DIR/$wheel")
        total_bytes=$((total_bytes + size))
    done
    echo "$WORKSPACE_WHEELS_VERSION" > "$WORKSPACE_WHEELS_MARKER"
    total_mb=$((total_bytes / 1024 / 1024))
    echo "   Installed ${#WORKSPACE_WHEELS[@]} workspace wheels (~${total_mb} MB) to static/pyodide/"
fi

# --- Chat sandbox scientific stack (matplotlib, scipy, sympy, scikit-learn,
#     beautifulsoup4, lxml + full transitive deps) ---
# The chat run_python worker sets indexURL='/pyodide/' and pre-loads this
# stack at boot, so vendoring the wheels here makes the common scientific
# imports instant and fully offline instead of a multi-MB CDN download
# under the run timeout. Anything NOT vendored still resolves: the worker's
# local-first fetch shim falls back to the CDN on a local miss.
#
# The dependency closure is derived from the bundled pyodide-lock.json so
# it stays correct across PYODIDE_VERSION bumps — bump CHAT_STACK_VERSION
# (or the top-level list) to force a re-resolve. Only wheels not already on
# disk (e.g. numpy/pandas pulled by the workspace set) are downloaded.
CHAT_STACK_VERSION="2"
CHAT_STACK_TOP=(matplotlib scipy sympy scikit-learn beautifulsoup4 lxml requests)
CHAT_STACK_MARKER="$DEST_DIR/.haruspex-chat-stack-version"
LOCK_FILE="$DEST_DIR/pyodide-lock.json"

if [ -f "$CHAT_STACK_MARKER" ] && [ "$(cat "$CHAT_STACK_MARKER")" = "$CHAT_STACK_VERSION" ]; then
    echo ">> Chat sandbox stack v$CHAT_STACK_VERSION already present at static/pyodide/"
elif [ ! -f "$LOCK_FILE" ]; then
    echo "   ERROR: $LOCK_FILE missing — cannot resolve the chat sandbox stack"
    exit 1
else
    echo ">> Resolving chat sandbox stack (matplotlib, scipy, sympy, scikit-learn, deps) from pyodide-lock.json..."
    rm -f "$CHAT_STACK_MARKER"
    # Resolve the transitive closure to a newline-separated list of wheel
    # filenames using the local lock file.
    closure_files=$(LOCK_FILE="$LOCK_FILE" "$PYTHON_BIN" -c "
import json, os, sys
lock = json.load(open(os.environ['LOCK_FILE']))
byname = {v['name'].lower(): v for v in lock['packages'].values()}
seen, out, stack = set(), [], [n.lower() for n in sys.argv[1:]]
while stack:
    n = stack.pop()
    if n in seen:
        continue
    seen.add(n)
    v = byname.get(n)
    if not v:
        sys.stderr.write('   WARNING: %s not in pyodide-lock.json — skipping\n' % n)
        continue
    out.append(v['file_name'])
    stack.extend(d.lower() for d in v.get('depends', []))
print('\n'.join(sorted(set(out))))
" "${CHAT_STACK_TOP[@]}")

    cdn_base="https://cdn.jsdelivr.net/pyodide/v$PYODIDE_VERSION/full"
    new_count=0
    total_bytes=0
    for wheel in $closure_files; do
        if [ -f "$DEST_DIR/$wheel" ]; then
            echo "   $wheel (cached)"
        else
            echo "   $wheel"
            curl -fsSL -o "$DEST_DIR/$wheel" "$cdn_base/$wheel"
            new_count=$((new_count + 1))
        fi
        size=$(stat -c %s "$DEST_DIR/$wheel" 2>/dev/null || stat -f %z "$DEST_DIR/$wheel")
        total_bytes=$((total_bytes + size))
    done
    echo "$CHAT_STACK_VERSION" > "$CHAT_STACK_MARKER"
    total_mb=$((total_bytes / 1024 / 1024))
    echo "   Chat sandbox stack ready (${new_count} new, ~${total_mb} MB total) in static/pyodide/"
fi
