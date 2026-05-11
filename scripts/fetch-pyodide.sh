#!/bin/bash
# Downloads Pyodide core distribution into static/pyodide/ for the
# Python sandbox (Phase 11). Idempotent — skips work if the pinned
# version is already present.
#
# Usage: ./scripts/fetch-pyodide.sh

set -e

PYODIDE_VERSION="0.29.4"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DEST_DIR="$PROJECT_ROOT/static/pyodide"
VERSION_MARKER="$DEST_DIR/.haruspex-pyodide-version"

if [ -f "$VERSION_MARKER" ] && [ "$(cat "$VERSION_MARKER")" = "$PYODIDE_VERSION" ]; then
    echo ">> Pyodide $PYODIDE_VERSION already present at static/pyodide/"
    exit 0
fi

echo ">> Downloading Pyodide $PYODIDE_VERSION (core, ~12 MB)..."
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

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
rm -rf "$DEST_DIR"/*
mv "$TMP_DIR/pyodide"/* "$DEST_DIR/"
echo "$PYODIDE_VERSION" > "$VERSION_MARKER"

echo "   Installed Pyodide $PYODIDE_VERSION to static/pyodide/"
