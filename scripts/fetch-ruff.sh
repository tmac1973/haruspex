#!/bin/bash
# Downloads the ruff (Python linter) sidecar binary into src-tauri/binaries/.
# Used after fs_write_text / fs_edit_text on .py files to surface syntax and
# pyflakes errors back to the model in the same tool result. Prebuilt
# single-file binary from astral-sh/ruff releases — no build step needed.
#
# Idempotent — skips the download if the pinned binary is already present.
#
# Usage: ./scripts/fetch-ruff.sh [--target <triple>]

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

RUFF_VERSION="$(cat "$PROJECT_ROOT/RUFF_VERSION" 2>/dev/null | tr -d '[:space:]')"
case "$TARGET_TRIPLE" in
    x86_64-unknown-linux-gnu)  RUFF_ASSET="ruff-x86_64-unknown-linux-gnu.tar.gz"   ; RUFF_EXE="ruff" ;;
    aarch64-unknown-linux-gnu) RUFF_ASSET="ruff-aarch64-unknown-linux-gnu.tar.gz"  ; RUFF_EXE="ruff" ;;
    x86_64-apple-darwin)       RUFF_ASSET="ruff-x86_64-apple-darwin.tar.gz"        ; RUFF_EXE="ruff" ;;
    aarch64-apple-darwin)      RUFF_ASSET="ruff-aarch64-apple-darwin.tar.gz"       ; RUFF_EXE="ruff" ;;
    x86_64-pc-windows-msvc)    RUFF_ASSET="ruff-x86_64-pc-windows-msvc.zip"        ; RUFF_EXE="ruff.exe" ;;
    *) RUFF_ASSET="" ;;
esac

if [ -z "$RUFF_ASSET" ]; then
    echo ">> WARN: unknown target $TARGET_TRIPLE for ruff — skipping"
    exit 0
fi
if [ -z "$RUFF_VERSION" ]; then
    echo ">> WARN: RUFF_VERSION file missing or empty — skipping ruff"
    exit 0
fi

RUFF_DEST="$BINARIES_DIR/ruff-$TARGET_TRIPLE"
# Windows sidecars need the .exe suffix on top of the triple for Tauri.
case "$TARGET_TRIPLE" in *windows*) RUFF_DEST="$RUFF_DEST.exe" ;; esac

if [ -f "$RUFF_DEST" ]; then
    echo ">> ruff already installed."
    exit 0
fi

echo ">> Downloading ruff $RUFF_VERSION..."
mkdir -p "$BINARIES_DIR"
TMP_DIR=$(mktemp -d)
if curl -fsSL -o "$TMP_DIR/ruff.archive" \
    "https://github.com/astral-sh/ruff/releases/download/$RUFF_VERSION/$RUFF_ASSET"; then
    case "$RUFF_ASSET" in
        *.tar.gz) tar -xzf "$TMP_DIR/ruff.archive" -C "$TMP_DIR" ;;
        *.zip)    unzip -q "$TMP_DIR/ruff.archive" -d "$TMP_DIR" ;;
    esac
    FOUND=$(find "$TMP_DIR" -type f -name "$RUFF_EXE" | head -1)
    if [ -n "$FOUND" ]; then
        cp "$FOUND" "$RUFF_DEST"
        chmod +x "$RUFF_DEST"
        echo "   Installed: $RUFF_DEST"
    else
        echo "   WARN: ruff binary not found inside archive — Python lint after edit will be skipped"
    fi
else
    echo "   WARN: failed to download ruff — Python lint after edit will be skipped"
fi
rm -rf "$TMP_DIR"
