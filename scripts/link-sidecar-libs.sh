#!/bin/bash
# Links llama-server shared libraries next to the resolved sidecar binary.
# llama.cpp discovers backends via /proc/self/exe, so the .so files must
# be in the same directory as the running binary.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"
TARGET_DIR="$PROJECT_ROOT/src-tauri/target/debug"

# Only run if both directories exist
if [ ! -d "$BINARIES_DIR" ] || [ ! -d "$TARGET_DIR" ]; then
    exit 0
fi

# Symlink all .so files from binaries/ to target/debug/
for lib in "$BINARIES_DIR"/*.so*; do
    [ -e "$lib" ] || continue
    basename="$(basename "$lib")"
    target="$TARGET_DIR/$basename"
    if [ ! -e "$target" ]; then
        ln -sf "$lib" "$target"
    fi
done
