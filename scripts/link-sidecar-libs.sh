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

# Symlink .so/.dylib files from binaries/ and binaries/libs/ to target/debug/.
#
# binaries/sd-libs/ is deliberately NOT in this list. sd-server carries its own
# ggml, whose unversioned and .so.0 names are identical to llama.cpp's while
# the version behind them is older — flattening both into one directory
# overwrites the soname llama-server loads and breaks the LLM sidecar. See
# docs/image-generation.md.
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
