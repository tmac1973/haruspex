#!/bin/bash
# Links sidecar shared libraries next to the resolved sidecar binary.
# llama.cpp/whisper.cpp discover backends via /proc/self/exe, so the
# shared libs must be in the same directory as the running binary.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"
LIBS_DIR="$BINARIES_DIR/libs"
TARGET_DIR="$PROJECT_ROOT/src-tauri/target/debug"

# Only run if target dir exists
if [ ! -d "$TARGET_DIR" ]; then
    exit 0
fi

# Symlink .so/.dylib files from binaries/ and binaries/libs/ to target/debug/
for dir in "$BINARIES_DIR" "$LIBS_DIR"; do
    [ -d "$dir" ] || continue
    for lib in "$dir"/*.so* "$dir"/*.dylib; do
        [ -e "$lib" ] || continue
        basename="$(basename "$lib")"
        target="$TARGET_DIR/$basename"
        if [ ! -e "$target" ]; then
            ln -sf "$lib" "$target"
        fi
    done
done
