#!/bin/bash
# Downloads the uv (Python package manager) binary into src-tauri/binaries/.
# Used to install and launch PyPI-published MCP servers without asking the
# user to install Python: uv provisions its own CPython on demand, so nothing
# else has to be bundled for the Python side. Prebuilt single-file binary from
# astral-sh/uv releases — no build step needed.
#
# Idempotent — skips the download if the pinned binary is already present.
#
# Usage: ./scripts/fetch-uv.sh [--target <triple>]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"

TARGET_TRIPLE=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --target) TARGET_TRIPLE="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done
if [ -z "$TARGET_TRIPLE" ]; then
    TARGET_TRIPLE="$(rustc --print host-tuple)"
fi

UV_VERSION="$(cat "$PROJECT_ROOT/UV_VERSION" 2>/dev/null | tr -d '[:space:]')"
case "$TARGET_TRIPLE" in
    x86_64-unknown-linux-gnu)  UV_ASSET="uv-x86_64-unknown-linux-gnu.tar.gz"   ; UV_EXE="uv" ;;
    aarch64-unknown-linux-gnu) UV_ASSET="uv-aarch64-unknown-linux-gnu.tar.gz"  ; UV_EXE="uv" ;;
    x86_64-apple-darwin)       UV_ASSET="uv-x86_64-apple-darwin.tar.gz"        ; UV_EXE="uv" ;;
    aarch64-apple-darwin)      UV_ASSET="uv-aarch64-apple-darwin.tar.gz"       ; UV_EXE="uv" ;;
    x86_64-pc-windows-msvc)    UV_ASSET="uv-x86_64-pc-windows-msvc.zip"        ; UV_EXE="uv.exe" ;;
    *) UV_ASSET="" ;;
esac

if [ -z "$UV_ASSET" ]; then
    echo ">> WARN: unknown target $TARGET_TRIPLE for uv — skipping"
    exit 0
fi
if [ -z "$UV_VERSION" ]; then
    echo ">> WARN: UV_VERSION file missing or empty — skipping uv"
    exit 0
fi

UV_DEST="$BINARIES_DIR/uv-$TARGET_TRIPLE"
# Windows sidecars need the .exe suffix on top of the triple for Tauri.
case "$TARGET_TRIPLE" in *windows*) UV_DEST="$UV_DEST.exe" ;; esac

if [ -f "$UV_DEST" ]; then
    echo ">> uv already installed."
    exit 0
fi

echo ">> Downloading uv $UV_VERSION..."
mkdir -p "$BINARIES_DIR"
TMP_DIR=$(mktemp -d)
if curl -fsSL -o "$TMP_DIR/uv.archive" \
    "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$UV_ASSET"; then
    case "$UV_ASSET" in
        *.tar.gz) tar -xzf "$TMP_DIR/uv.archive" -C "$TMP_DIR" ;;
        *.zip)    unzip -q "$TMP_DIR/uv.archive" -d "$TMP_DIR" ;;
    esac
    FOUND=$(find "$TMP_DIR" -type f -name "$UV_EXE" | head -1)
    if [ -n "$FOUND" ]; then
        cp "$FOUND" "$UV_DEST"
        chmod +x "$UV_DEST"
        echo "   Installed: $UV_DEST"
    else
        echo "   WARN: uv binary not found inside archive — PyPI MCP servers will be unavailable"
    fi
else
    echo "   WARN: failed to download uv — PyPI MCP servers will be unavailable"
fi
rm -rf "$TMP_DIR"
