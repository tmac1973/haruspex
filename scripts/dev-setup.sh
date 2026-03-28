#!/bin/bash
# Haruspex Development Environment Setup
# Downloads and builds all sidecar binaries and models needed for dev.
#
# Usage: ./scripts/dev-setup.sh [--skip-models] [--skip-build]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"
TARGET_DIR="$PROJECT_ROOT/src-tauri/target/debug"
TARGET_TRIPLE="$(rustc --print host-tuple)"
MODELS_DIR="$HOME/.local/share/com.haruspex.app/models"
TTS_CACHE="$HOME/.cache/k"

SKIP_MODELS=false
SKIP_BUILD=false

for arg in "$@"; do
    case $arg in
        --skip-models) SKIP_MODELS=true ;;
        --skip-build) SKIP_BUILD=true ;;
    esac
done

echo "========================================"
echo "  Haruspex Dev Setup"
echo "  Target: $TARGET_TRIPLE"
echo "========================================"
echo

# ---- System dependency check ----
echo ">> Checking system dependencies..."
MISSING=""
for cmd in cargo npm cmake rustc; do
    if ! command -v $cmd &>/dev/null; then
        MISSING="$MISSING $cmd"
    fi
done
if [ -n "$MISSING" ]; then
    echo "ERROR: Missing required tools:$MISSING"
    exit 1
fi
echo "   All tools found."
echo

# ---- npm install ----
echo ">> Installing npm dependencies..."
(cd "$PROJECT_ROOT" && npm ci --silent 2>/dev/null || npm install --silent)
echo "   Done."
echo

# ---- Build llama.cpp ----
if [ "$SKIP_BUILD" = false ]; then
    LLAMA_SERVER="$BINARIES_DIR/llama-server-$TARGET_TRIPLE"
    if [ -f "$LLAMA_SERVER" ] && [ -x "$LLAMA_SERVER" ]; then
        echo ">> llama-server already exists, skipping build."
    else
        echo ">> Building llama.cpp (llama-server)..."
        LLAMA_BUILD_DIR="/tmp/haruspex-llama-build"
        rm -rf "$LLAMA_BUILD_DIR"

        if [ ! -d "/tmp/llama.cpp" ]; then
            echo "   Cloning llama.cpp..."
            git clone --depth 1 https://github.com/ggml-org/llama.cpp.git /tmp/llama.cpp 2>/dev/null
        fi

        mkdir -p "$LLAMA_BUILD_DIR"
        cd "$LLAMA_BUILD_DIR"

        # Try Vulkan first, fall back to CPU
        CMAKE_ARGS="-DCMAKE_BUILD_TYPE=Release"
        if pkg-config --exists vulkan 2>/dev/null || [ -f /usr/include/vulkan/vulkan.h ]; then
            echo "   Vulkan headers found, building with GPU support..."
            CMAKE_ARGS="$CMAKE_ARGS -DGGML_VULKAN=ON"
        else
            echo "   No Vulkan headers, building CPU-only..."
        fi

        cmake /tmp/llama.cpp $CMAKE_ARGS 2>&1 | tail -3
        cmake --build . --config Release -j$(nproc) --target llama-server 2>&1 | tail -3

        mkdir -p "$BINARIES_DIR"
        cp bin/llama-server "$LLAMA_SERVER"
        chmod +x "$LLAMA_SERVER"

        # Copy shared libraries
        find . -name "*.so*" -type f | while read lib; do
            base=$(basename "$lib")
            cp "$lib" "$BINARIES_DIR/$base"
            # Create soname symlinks
            soname=$(echo "$base" | sed 's/\.[0-9]*\.[0-9]*$//')
            [ "$soname" != "$base" ] && ln -sf "$base" "$BINARIES_DIR/$soname"
            short=$(echo "$base" | sed 's/\.so\..*/.so/')
            [ "$short" != "$base" ] && ln -sf "$base" "$BINARIES_DIR/$short"
        done

        echo "   Built: $LLAMA_SERVER"
        cd "$PROJECT_ROOT"
    fi
    echo
fi

# ---- Build whisper.cpp ----
if [ "$SKIP_BUILD" = false ]; then
    WHISPER_SERVER="$BINARIES_DIR/whisper-server-$TARGET_TRIPLE"
    if [ -f "$WHISPER_SERVER" ] && [ -x "$WHISPER_SERVER" ]; then
        echo ">> whisper-server already exists, skipping build."
    else
        echo ">> Building whisper.cpp (whisper-server)..."
        WHISPER_BUILD_DIR="/tmp/haruspex-whisper-build"
        rm -rf "$WHISPER_BUILD_DIR"

        if [ ! -d "/tmp/whisper.cpp" ]; then
            echo "   Cloning whisper.cpp..."
            git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git /tmp/whisper.cpp 2>/dev/null
        fi

        mkdir -p "$WHISPER_BUILD_DIR"
        cd "$WHISPER_BUILD_DIR"

        CMAKE_ARGS="-DCMAKE_BUILD_TYPE=Release"
        if pkg-config --exists vulkan 2>/dev/null || [ -f /usr/include/vulkan/vulkan.h ]; then
            CMAKE_ARGS="$CMAKE_ARGS -DGGML_VULKAN=ON"
        fi

        cmake /tmp/whisper.cpp $CMAKE_ARGS 2>&1 | tail -3
        cmake --build . --config Release -j$(nproc) --target whisper-server 2>&1 | tail -3

        mkdir -p "$BINARIES_DIR"
        cp bin/whisper-server "$WHISPER_SERVER"
        chmod +x "$WHISPER_SERVER"

        # Copy shared libraries
        find . -name "*.so*" -type f | while read lib; do
            base=$(basename "$lib")
            cp "$lib" "$BINARIES_DIR/$base"
            soname=$(echo "$base" | sed 's/\.[0-9]*\.[0-9]*$//')
            [ "$soname" != "$base" ] && ln -sf "$base" "$BINARIES_DIR/$soname"
            short=$(echo "$base" | sed 's/\.so\..*/.so/')
            [ "$short" != "$base" ] && ln -sf "$base" "$BINARIES_DIR/$short"
        done

        echo "   Built: $WHISPER_SERVER"
        cd "$PROJECT_ROOT"
    fi
    echo
fi

# ---- Build Kokoros (koko TTS) ----
if [ "$SKIP_BUILD" = false ]; then
    KOKO="$BINARIES_DIR/koko-$TARGET_TRIPLE"
    if [ -f "$KOKO" ] && [ -x "$KOKO" ]; then
        echo ">> koko (Kokoros TTS) already exists, skipping build."
    else
        echo ">> Building Kokoros (koko TTS server)..."
        if [ ! -d "/tmp/Kokoros" ]; then
            echo "   Cloning Kokoros..."
            git clone --depth 1 https://github.com/lucasjinreal/Kokoros.git /tmp/Kokoros 2>/dev/null
        fi

        cd /tmp/Kokoros
        cargo build --release --bin koko 2>&1 | tail -3

        mkdir -p "$BINARIES_DIR"
        cp target/release/koko "$KOKO"
        chmod +x "$KOKO"

        echo "   Built: $KOKO"
        cd "$PROJECT_ROOT"
    fi
    echo
fi

# ---- Symlink libs for dev mode ----
echo ">> Symlinking shared libraries for dev mode..."
"$SCRIPT_DIR/link-sidecar-libs.sh"
echo "   Done."
echo

# ---- Download models ----
if [ "$SKIP_MODELS" = false ]; then
    # Whisper model
    WHISPER_DIR="$MODELS_DIR/whisper"
    WHISPER_MODEL="$WHISPER_DIR/ggml-base.en.bin"
    if [ -f "$WHISPER_MODEL" ]; then
        echo ">> Whisper model already exists."
    else
        echo ">> Downloading Whisper model (ggml-base.en, ~148 MB)..."
        mkdir -p "$WHISPER_DIR"
        curl -L --progress-bar \
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" \
            -o "$WHISPER_MODEL"
        echo "   Saved: $WHISPER_MODEL"
    fi
    echo

    # Kokoro TTS model
    KOKO_MODEL="$TTS_CACHE/0.onnx"
    KOKO_VOICES="$TTS_CACHE/0.bin"
    if [ -f "$KOKO_MODEL" ] && [ -f "$KOKO_VOICES" ]; then
        echo ">> Kokoro TTS models already exist."
    else
        echo ">> Downloading Kokoro TTS models (~340 MB total)..."
        mkdir -p "$TTS_CACHE"
        if [ ! -f "$KOKO_MODEL" ]; then
            echo "   Downloading model (310 MB)..."
            curl -L --progress-bar \
                "https://github.com/8b-is/kokoro-tiny/raw/main/models/0.onnx" \
                -o "$KOKO_MODEL"
        fi
        if [ ! -f "$KOKO_VOICES" ]; then
            echo "   Downloading voices (27 MB)..."
            curl -L --progress-bar \
                "https://github.com/8b-is/kokoro-tiny/raw/main/models/0.bin" \
                -o "$KOKO_VOICES"
        fi
        echo "   Saved to: $TTS_CACHE/"
    fi
    echo
fi

echo "========================================"
echo "  Setup complete!"
echo ""
echo "  To start dev server:"
echo "    GDK_BACKEND=x11 npm run tauri dev"
echo ""
echo "  Sidecar binaries:"
ls -lh "$BINARIES_DIR"/*-"$TARGET_TRIPLE"* 2>/dev/null | awk '{print "    " $NF " (" $5 ")"}'
echo ""
echo "  Models:"
[ -f "$WHISPER_MODEL" ] && echo "    Whisper: $WHISPER_MODEL"
[ -f "$KOKO_MODEL" ] && echo "    Kokoro TTS: $TTS_CACHE/"
echo ""
echo "  Note: LLM model (Qwen 3.5 9B) is downloaded"
echo "  via the app's first-run wizard or settings page."
echo "========================================"
