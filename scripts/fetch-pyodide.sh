#!/bin/bash
# Downloads Pyodide core distribution + bundled doc-creation wheels
# (fpdf2, python-pptx, deps) into static/pyodide/ for the Python sandbox.
# Idempotent — skips work if the pinned versions are already present.
#
# Usage: ./scripts/fetch-pyodide.sh

set -e

PYODIDE_VERSION="0.29.4"

# Pure-Python wheels pre-bundled so the sandbox can produce PDFs and
# PowerPoints offline (Pillow / lxml / typing_extensions are already
# inside Pyodide and loaded via pyodide.loadPackage).
WHEELS_VERSION="1"
WHEELS=(
    "fpdf2-2.8.7-py3-none-any.whl"
    "defusedxml-0.7.1-py2.py3-none-any.whl"
    "fonttools-4.62.1-py3-none-any.whl"
    "python_pptx-1.0.2-py3-none-any.whl"
    "xlsxwriter-3.2.9-py3-none-any.whl"
)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DEST_DIR="$PROJECT_ROOT/static/pyodide"
WHEELS_DIR="$DEST_DIR/wheels"
VERSION_MARKER="$DEST_DIR/.haruspex-pyodide-version"
WHEELS_MARKER="$WHEELS_DIR/.haruspex-wheels-version"

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
    # Preserve any bundled wheels from a previous run.
    find "$DEST_DIR" -mindepth 1 -maxdepth 1 ! -name 'wheels' -exec rm -rf {} +
    mv "$TMP_DIR/pyodide"/* "$DEST_DIR/"
    echo "$PYODIDE_VERSION" > "$VERSION_MARKER"

    echo "   Installed Pyodide $PYODIDE_VERSION to static/pyodide/"
fi

# --- Doc-creation wheels (fpdf2 + python-pptx + transitive non-Pyodide deps) ---
if [ -f "$WHEELS_MARKER" ] && [ "$(cat "$WHEELS_MARKER")" = "$WHEELS_VERSION" ]; then
    echo ">> Bundled doc wheels v$WHEELS_VERSION already present at static/pyodide/wheels/"
    exit 0
fi

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
