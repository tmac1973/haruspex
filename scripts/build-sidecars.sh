#!/bin/bash
# Build all sidecar binaries for Haruspex
# Usage: ./scripts/build-sidecars.sh [--target <triple>]
#
# Builds: llama-server (llama.cpp), whisper-server (whisper.cpp), koko (Kokoros)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"

# Parse args
TARGET=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --target) TARGET="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

if [ -z "$TARGET" ]; then
    TARGET="$(rustc --print host-tuple)"
fi

LLAMA_VERSION=$(cat "$PROJECT_ROOT/LLAMA_CPP_VERSION" 2>/dev/null || echo "master")
WHISPER_VERSION=$(cat "$PROJECT_ROOT/WHISPER_CPP_VERSION" 2>/dev/null || echo "master")
BUILD_DIR="/tmp/haruspex-sidecar-build"
NPROC=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

echo "========================================"
echo "  Building Haruspex Sidecars"
echo "  Target: $TARGET"
echo "  Jobs: $NPROC"
echo "========================================"
echo

mkdir -p "$BINARIES_DIR"

# Detect GPU build flags per platform
CMAKE_GPU_FLAGS=""
case "$TARGET" in
    *-linux-gnu|*-windows-msvc)
        if pkg-config --exists vulkan 2>/dev/null || [ -f /usr/include/vulkan/vulkan.h ]; then
            CMAKE_GPU_FLAGS="-DGGML_VULKAN=ON"
            echo "GPU: Vulkan"
        else
            echo "GPU: None (Vulkan headers not found)"
        fi
        ;;
    *-apple-darwin)
        CMAKE_GPU_FLAGS="-DGGML_METAL=ON"
        echo "GPU: Metal"
        ;;
esac
echo

# Determine binary extension
EXT=""
case "$TARGET" in
    *-windows-msvc) EXT=".exe" ;;
esac

# ---- llama-server ----
LLAMA_BIN="$BINARIES_DIR/llama-server-${TARGET}${EXT}"
if [ -f "$LLAMA_BIN" ]; then
    echo ">> llama-server already built, skipping."
else
    echo ">> Building llama-server (llama.cpp $LLAMA_VERSION)..."
    LLAMA_SRC="/tmp/llama.cpp"
    if [ ! -d "$LLAMA_SRC" ]; then
        git clone --depth 1 --branch "$LLAMA_VERSION" https://github.com/ggml-org/llama.cpp.git "$LLAMA_SRC" 2>/dev/null || \
        git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "$LLAMA_SRC" 2>/dev/null
    fi

    rm -rf "$BUILD_DIR/llama"
    mkdir -p "$BUILD_DIR/llama"
    cd "$BUILD_DIR/llama"

    echo "   Configuring..."
    if ! cmake "$LLAMA_SRC" -DCMAKE_BUILD_TYPE=Release $CMAKE_GPU_FLAGS 2>&1; then
        echo "   WARN: cmake configure failed with GPU flags, retrying CPU-only..."
        rm -rf "$BUILD_DIR/llama"
        mkdir -p "$BUILD_DIR/llama"
        cd "$BUILD_DIR/llama"
        cmake "$LLAMA_SRC" -DCMAKE_BUILD_TYPE=Release 2>&1
    fi

    echo "   Building..."
    cmake --build . --config Release -j"$NPROC" --target llama-server 2>&1

    # Binary location varies by platform (bin/ on Linux/Mac, bin/Release/ on Windows)
    LLAMA_OUT=$(find . -name "llama-server${EXT}" -type f | head -1)
    if [ -z "$LLAMA_OUT" ]; then
        echo "ERROR: llama-server binary not found after build"
        exit 1
    fi
    cp "$LLAMA_OUT" "$LLAMA_BIN"
    chmod +x "$LLAMA_BIN"

    # Copy shared libraries to libs/ subdirectory
    mkdir -p "$BINARIES_DIR/libs"
    find . \( -name "*.so*" -o -name "*.dylib" -o -name "*.dll" \) -type f | while read lib; do
        cp "$lib" "$BINARIES_DIR/libs/"
    done

    # Create soname symlinks on Linux
    for f in "$BINARIES_DIR"/libs/*.so.*.*; do
        [ -f "$f" ] || continue
        base=$(basename "$f")
        soname=$(echo "$base" | sed 's/\.[0-9]*\.[0-9]*$//')
        [ "$soname" != "$base" ] && ln -sf "$base" "$BINARIES_DIR/libs/$soname"
        short=$(echo "$base" | sed 's/\.so\..*/.so/')
        [ "$short" != "$base" ] && ln -sf "$base" "$BINARIES_DIR/libs/$short"
    done

    echo "   Built: $LLAMA_BIN"
fi
echo

# ---- whisper-server ----
WHISPER_BIN="$BINARIES_DIR/whisper-server-${TARGET}${EXT}"
if [ -f "$WHISPER_BIN" ]; then
    echo ">> whisper-server already built, skipping."
else
    echo ">> Building whisper-server (whisper.cpp $WHISPER_VERSION)..."
    WHISPER_SRC="/tmp/whisper.cpp"
    if [ ! -d "$WHISPER_SRC" ]; then
        git clone --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggml-org/whisper.cpp.git "$WHISPER_SRC" 2>/dev/null || \
        git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER_SRC" 2>/dev/null
    fi

    rm -rf "$BUILD_DIR/whisper"
    mkdir -p "$BUILD_DIR/whisper"
    cd "$BUILD_DIR/whisper"

    echo "   Configuring..."
    if ! cmake "$WHISPER_SRC" -DCMAKE_BUILD_TYPE=Release $CMAKE_GPU_FLAGS 2>&1; then
        echo "   WARN: cmake configure failed with GPU flags, retrying CPU-only..."
        rm -rf "$BUILD_DIR/whisper"
        mkdir -p "$BUILD_DIR/whisper"
        cd "$BUILD_DIR/whisper"
        cmake "$WHISPER_SRC" -DCMAKE_BUILD_TYPE=Release 2>&1
    fi

    echo "   Building..."
    cmake --build . --config Release -j"$NPROC" --target whisper-server 2>&1

    WHISPER_OUT=$(find . -name "whisper-server${EXT}" -type f | head -1)
    if [ -z "$WHISPER_OUT" ]; then
        echo "ERROR: whisper-server binary not found after build"
        exit 1
    fi
    cp "$WHISPER_OUT" "$WHISPER_BIN"
    chmod +x "$WHISPER_BIN"

    # Copy shared libraries
    find . \( -name "*.so*" -o -name "*.dylib" -o -name "*.dll" \) -type f | while read lib; do
        cp "$lib" "$BINARIES_DIR/"
    done

    for f in "$BINARIES_DIR"/*.so.*.*; do
        [ -f "$f" ] || continue
        base=$(basename "$f")
        soname=$(echo "$base" | sed 's/\.[0-9]*\.[0-9]*$//')
        [ "$soname" != "$base" ] && ln -sf "$base" "$BINARIES_DIR/$soname"
        short=$(echo "$base" | sed 's/\.so\..*/.so/')
        [ "$short" != "$base" ] && ln -sf "$base" "$BINARIES_DIR/$short"
    done

    echo "   Built: $WHISPER_BIN"
fi
echo

# ---- koko (Kokoros TTS) ----
KOKO_BIN="$BINARIES_DIR/koko-${TARGET}${EXT}"
if [ -f "$KOKO_BIN" ]; then
    echo ">> koko already built, skipping."
else
    echo ">> Building koko (Kokoros TTS)..."
    KOKO_SRC="/tmp/Kokoros"
    if [ ! -d "$KOKO_SRC" ]; then
        git clone --depth 1 https://github.com/lucasjinreal/Kokoros.git "$KOKO_SRC" 2>/dev/null
    fi

    cd "$KOKO_SRC"
    echo "   Building..."
    # audiopus_sys uses old cmake_minimum_required incompatible with newer cmake
    export CMAKE_POLICY_VERSION_MINIMUM=3.5
    cargo build --release --bin koko 2>&1

    cp target/release/koko${EXT} "$KOKO_BIN"
    chmod +x "$KOKO_BIN"

    echo "   Built: $KOKO_BIN"
fi
echo

# ---- Summary ----
echo "========================================"
echo "  Sidecars built for $TARGET:"
for bin in "$BINARIES_DIR"/*-"$TARGET"*; do
    [ -f "$bin" ] && echo "    $(basename $bin) ($(du -h "$bin" | cut -f1))"
done
echo "========================================"
