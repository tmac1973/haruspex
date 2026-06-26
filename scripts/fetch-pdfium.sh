#!/bin/bash
# Downloads the PDFium shared library into src-tauri/binaries/libs/.
# Used by pdfium-render in the main app binary for high-quality PDF text
# extraction (handles forms, custom fonts, position-aware reading order).
# Binaries come from https://github.com/bblanchon/pdfium-binaries.
#
# Idempotent — skips the download if the library is already present.
#
# Usage: ./scripts/fetch-pdfium.sh [--target <triple>]

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

PDFIUM_VERSION="${PDFIUM_VERSION:-chromium/7763}"
case "$TARGET_TRIPLE" in
    x86_64-unknown-linux-gnu)  PDFIUM_ASSET="pdfium-linux-x64.tgz"   ; PDFIUM_LIB="libpdfium.so"     ;;
    aarch64-unknown-linux-gnu) PDFIUM_ASSET="pdfium-linux-arm64.tgz" ; PDFIUM_LIB="libpdfium.so"     ;;
    x86_64-apple-darwin)       PDFIUM_ASSET="pdfium-mac-x64.tgz"     ; PDFIUM_LIB="libpdfium.dylib"  ;;
    aarch64-apple-darwin)      PDFIUM_ASSET="pdfium-mac-arm64.tgz"   ; PDFIUM_LIB="libpdfium.dylib"  ;;
    x86_64-pc-windows-msvc)    PDFIUM_ASSET="pdfium-win-x64.tgz"     ; PDFIUM_LIB="pdfium.dll"       ;;
    *) PDFIUM_ASSET="" ;;
esac

if [ -z "$PDFIUM_ASSET" ]; then
    echo ">> WARN: unknown target $TARGET_TRIPLE for PDFium — skipping"
    exit 0
fi

mkdir -p "$BINARIES_DIR/libs"
if [ -f "$BINARIES_DIR/libs/$PDFIUM_LIB" ]; then
    echo ">> PDFium already installed."
    exit 0
fi

echo ">> Downloading PDFium ($PDFIUM_VERSION / $PDFIUM_ASSET)..."
TMP_DIR=$(mktemp -d)
if curl -fsSL -o "$TMP_DIR/pdfium.tgz" \
    "https://github.com/bblanchon/pdfium-binaries/releases/download/$PDFIUM_VERSION/$PDFIUM_ASSET"; then
    tar -xzf "$TMP_DIR/pdfium.tgz" -C "$TMP_DIR"
    # The archive contains lib/libpdfium.so (or bin/pdfium.dll on Windows).
    if [ -f "$TMP_DIR/lib/$PDFIUM_LIB" ]; then
        cp "$TMP_DIR/lib/$PDFIUM_LIB" "$BINARIES_DIR/libs/"
        echo "   Installed: $PDFIUM_LIB"
    elif [ -f "$TMP_DIR/bin/$PDFIUM_LIB" ]; then
        cp "$TMP_DIR/bin/$PDFIUM_LIB" "$BINARIES_DIR/libs/"
        echo "   Installed: $PDFIUM_LIB"
    else
        echo "   WARN: could not find $PDFIUM_LIB in the PDFium archive"
    fi
else
    echo "   WARN: Failed to download PDFium — PDF extraction will use fallback"
fi
rm -rf "$TMP_DIR"
