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

# On Windows (Git Bash), Git ships a POSIX link.exe in /usr/bin that shadows
# the MSVC linker. Find the real MSVC link.exe and prepend its directory so
# it takes priority.
case "$TARGET" in
    *-windows-msvc)
        MSVC_LINK=$(cmd //c "where link.exe" 2>/dev/null | grep -i "MSVC\|Visual Studio\|HostX64" | head -1 | tr -d '\r')
        if [ -n "$MSVC_LINK" ]; then
            MSVC_LINK_DIR=$(dirname "$MSVC_LINK")
            # Convert Windows path to Unix-style for Git Bash
            MSVC_LINK_DIR=$(cygpath -u "$MSVC_LINK_DIR" 2>/dev/null || echo "$MSVC_LINK_DIR")
            export PATH="$MSVC_LINK_DIR:$PATH"
            echo "MSVC linker: $MSVC_LINK"
        else
            echo "WARN: Could not find MSVC link.exe — linking may fail"
        fi
        ;;
esac

LLAMA_VERSION=$(cat "$PROJECT_ROOT/LLAMA_CPP_VERSION" 2>/dev/null || echo "master")
WHISPER_VERSION=$(cat "$PROJECT_ROOT/WHISPER_CPP_VERSION" 2>/dev/null || echo "master")
case "$TARGET" in
    *-windows-msvc) BUILD_DIR="$PROJECT_ROOT/.sidecar-build" ;;
    *)              BUILD_DIR="/tmp/haruspex-sidecar-build" ;;
esac
NPROC=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "${NUMBER_OF_PROCESSORS:-4}")

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
    *-linux-gnu)
        if pkg-config --exists vulkan 2>/dev/null || [ -f /usr/include/vulkan/vulkan.h ]; then
            CMAKE_GPU_FLAGS="-DGGML_VULKAN=ON"
            echo "GPU: Vulkan"
        else
            echo "GPU: None (Vulkan headers not found)"
        fi
        ;;
    *-windows-msvc)
        if [ -n "$VULKAN_SDK" ] && [ -d "$VULKAN_SDK/Include/vulkan" ]; then
            CMAKE_GPU_FLAGS="-DGGML_VULKAN=ON"
            echo "GPU: Vulkan (SDK: $VULKAN_SDK)"
        else
            echo "GPU: None (VULKAN_SDK not set or Vulkan headers not found)"
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
    LLAMA_SRC="${BUILD_DIR}/llama.cpp"
    if [ ! -d "$LLAMA_SRC" ]; then
        git clone --depth 1 --branch "$LLAMA_VERSION" https://github.com/ggml-org/llama.cpp.git "$LLAMA_SRC" 2>/dev/null || \
        git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "$LLAMA_SRC" 2>/dev/null
    fi

    rm -rf "$BUILD_DIR/llama"
    mkdir -p "$BUILD_DIR/llama"
    cd "$BUILD_DIR/llama"

    echo "   Configuring with flags: $CMAKE_GPU_FLAGS"
    if ! cmake "$LLAMA_SRC" -DCMAKE_BUILD_TYPE=Release $CMAKE_GPU_FLAGS 2>&1; then
        echo "   WARN: cmake configure failed with GPU flags ($CMAKE_GPU_FLAGS), retrying CPU-only..."
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
    # Use -L to dereference symlinks so we get real files (symlinks don't survive packaging)
    mkdir -p "$BINARIES_DIR/libs"
    find -L . \( -name "*.so*" -o -name "*.dylib" -o -name "*.dll" \) -type f | while read lib; do
        cp -L "$lib" "$BINARIES_DIR/libs/"
    done

    # Create soname copies on Linux (real files, not symlinks, for reliable packaging)
    # Handles patterns like libfoo.so.1.2.3 -> libfoo.so.1 and libfoo.so
    for f in "$BINARIES_DIR"/libs/*.so.*; do
        [ -f "$f" ] || continue
        base=$(basename "$f")
        # Skip if this is already a soname (e.g. libfoo.so.0 with no further dots)
        # Generate soname: libfoo.so.1.2.3 -> libfoo.so.1, libfoo.so.0.1 -> libfoo.so.0
        soname=$(echo "$base" | sed -E 's/(\.so\.[0-9]+)\..*/\1/')
        if [ "$soname" != "$base" ] && [ ! -f "$BINARIES_DIR/libs/$soname" ]; then
            cp "$f" "$BINARIES_DIR/libs/$soname"
        fi
        # Generate short name: libfoo.so.anything -> libfoo.so
        short=$(echo "$base" | sed 's/\.so\..*/\.so/')
        if [ "$short" != "$base" ] && [ ! -f "$BINARIES_DIR/libs/$short" ]; then
            cp "$f" "$BINARIES_DIR/libs/$short"
        fi
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
    WHISPER_SRC="${BUILD_DIR}/whisper.cpp"
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

    # Copy shared libraries to libs/ subdirectory.
    # Only copy libs that don't already exist — llama-server's GGML libs take
    # precedence since llama-server needs the exact versions it was built against.
    mkdir -p "$BINARIES_DIR/libs"
    find -L . \( -name "*.so*" -o -name "*.dylib" -o -name "*.dll" \) -type f | while read lib; do
        libname=$(basename "$lib")
        if [ ! -f "$BINARIES_DIR/libs/$libname" ]; then
            cp -L "$lib" "$BINARIES_DIR/libs/"
        fi
    done

    for f in "$BINARIES_DIR"/libs/*.so.*; do
        [ -f "$f" ] || continue
        base=$(basename "$f")
        soname=$(echo "$base" | sed -E 's/(\.so\.[0-9]+)\..*/\1/')
        if [ "$soname" != "$base" ] && [ ! -f "$BINARIES_DIR/libs/$soname" ]; then
            cp "$f" "$BINARIES_DIR/libs/$soname"
        fi
        short=$(echo "$base" | sed 's/\.so\..*/\.so/')
        if [ "$short" != "$base" ] && [ ! -f "$BINARIES_DIR/libs/$short" ]; then
            cp "$f" "$BINARIES_DIR/libs/$short"
        fi
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
    KOKO_SRC="${BUILD_DIR}/Kokoros"
    if [ ! -d "$KOKO_SRC" ]; then
        git clone --depth 1 https://github.com/lucasjinreal/Kokoros.git "$KOKO_SRC" 2>/dev/null
    fi

    cd "$KOKO_SRC"
    echo "   Building..."
    # audiopus_sys uses old cmake_minimum_required incompatible with newer cmake
    export CMAKE_POLICY_VERSION_MINIMUM=3.5

    # Use rustls instead of native-tls to avoid OpenSSL dependency.
    # Patch reqwest line in kokoros/Cargo.toml — replace the whole line to avoid
    # regex matching issues with varying formats across upstream versions.
    cp kokoros/Cargo.toml kokoros/Cargo.toml.bak
    sed '/^reqwest[[:space:]]*=/c\reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }' kokoros/Cargo.toml.bak > kokoros/Cargo.toml
    echo "   Patched reqwest:"
    grep reqwest kokoros/Cargo.toml
    # Remove lock file to force fresh dependency resolution with rustls
    rm -f Cargo.lock

    cargo build --release --bin koko 2>&1

    # Restore original Cargo.toml
    mv kokoros/Cargo.toml.bak kokoros/Cargo.toml

    cp target/release/koko${EXT} "$KOKO_BIN"
    chmod +x "$KOKO_BIN"

    echo "   Built: $KOKO_BIN"
fi
echo

# ---- Bundle MSVC runtime DLLs on Windows ----
case "$TARGET" in
    *-windows-msvc)
        echo ">> Bundling MSVC runtime DLLs..."
        mkdir -p "$BINARIES_DIR/libs"
        # Find the VC redist base directory (works with VS 2022 Build Tools and full VS).
        # VCToolsRedistDir env var points to e.g. .../Redist/MSVC/14.44.35207/
        MSVC_REDIST_BASE=""
        for base in \
            "$VCToolsRedistDir" \
            "C:/Program Files/Microsoft Visual Studio/2022/Enterprise/VC/Redist/MSVC" \
            "C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Redist/MSVC" \
            "C:/Program Files/Microsoft Visual Studio/2022/BuildTools/VC/Redist/MSVC" \
            "C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Redist/MSVC"; do
            [ -z "$base" ] && continue
            if [ -d "$base/x64/Microsoft.VC143.CRT" ]; then
                MSVC_REDIST_BASE="$base/x64"
                break
            fi
            # Try globbing version subdirectories
            for ver_dir in "$base"/*/x64; do
                if [ -d "$ver_dir/Microsoft.VC143.CRT" ]; then
                    MSVC_REDIST_BASE="$ver_dir"
                    break 2
                fi
            done
        done

        if [ -n "$MSVC_REDIST_BASE" ]; then
            echo "   Found MSVC redist at: $MSVC_REDIST_BASE"
            # CRT DLLs are in Microsoft.VC143.CRT/
            for dll in msvcp140.dll vcruntime140.dll vcruntime140_1.dll; do
                src="$MSVC_REDIST_BASE/Microsoft.VC143.CRT/$dll"
                if [ -f "$src" ]; then
                    cp "$src" "$BINARIES_DIR/libs/"
                    echo "   Copied: $dll"
                fi
            done
            # OpenMP runtime is in Microsoft.VC143.OpenMP/
            if [ -f "$MSVC_REDIST_BASE/Microsoft.VC143.OpenMP/vcomp140.dll" ]; then
                cp "$MSVC_REDIST_BASE/Microsoft.VC143.OpenMP/vcomp140.dll" "$BINARIES_DIR/libs/"
                echo "   Copied: vcomp140.dll"
            fi
        else
            echo "   WARN: Could not find MSVC runtime DLLs to bundle"
        fi
        echo
        ;;
esac

# ---- Summary ----
echo "========================================"
echo "  Sidecars built for $TARGET:"
for bin in "$BINARIES_DIR"/*-"$TARGET"*; do
    [ -f "$bin" ] && echo "    $(basename $bin) ($(du -h "$bin" | cut -f1))"
done
echo "========================================"
