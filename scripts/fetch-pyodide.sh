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

PYODIDE_VERSION="0.29.4"

# Pure-Python wheels for offline document generation. Pillow / lxml /
# typing_extensions are already inside Pyodide and loaded via
# pyodide.loadPackage at runtime.
WHEELS_VERSION="1"
WHEELS=(
    "fpdf2-2.8.7-py3-none-any.whl"
    "defusedxml-0.7.1-py2.py3-none-any.whl"
    "fonttools-4.62.1-py3-none-any.whl"
    "python_pptx-1.0.2-py3-none-any.whl"
    "xlsxwriter-3.2.9-py3-none-any.whl"
)

# Workspace wheels: full transitive dep tree for pygame-ce + bokeh +
# altair, derived from static/pyodide/pyodide-lock.json. These sit at
# the root of static/pyodide/ (not in wheels/) so pyodide.loadPackage(
# '<name>') resolves them via the lockfile when indexURL='/pyodide/'.
# Re-derive whenever PYODIDE_VERSION changes — wheel filenames are
# version-specific.
WORKSPACE_WHEELS_VERSION="1"
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
    "pygame_ce-2.5.6.dev2-cp313-cp313-pyemscripten_2025_0_wasm32.whl"
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
        file_url=$(echo "$json" | python3 -c "
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
