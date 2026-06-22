#!/bin/bash
# Haruspex Development Environment Setup
# Downloads and builds all sidecar binaries and models needed for dev.
#
# Usage: ./scripts/dev-setup.sh [--skip-models] [--skip-build] [--skip-pyodide]

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
SKIP_PYODIDE=false

for arg in "$@"; do
    case $arg in
        --skip-models) SKIP_MODELS=true ;;
        --skip-build) SKIP_BUILD=true ;;
        --skip-pyodide) SKIP_PYODIDE=true ;;
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

# ---- Build sidecars (llama-server, whisper-server, koko) ----
# Delegate to build-sidecars.sh, the single cross-platform build path. It owns
# the platform specifics the old inline build here got wrong on Windows (.exe
# naming, the bin/Release/ output dir, DLL bundling, $VULKAN_SDK detection) and
# also bundles espeak-ng-data. ALLOW_CPU_FALLBACK keeps dev lenient: a machine
# without a working Vulkan toolchain gets a CPU sidecar instead of the hard
# abort release builds use to enforce GPU.
if [ "$SKIP_BUILD" = false ]; then
    ALLOW_CPU_FALLBACK=1 "$SCRIPT_DIR/build-sidecars.sh" --target "$TARGET_TRIPLE"
    echo
fi

# ---- Download PDFium library ----
# Needed by the main app for high-quality PDF text extraction. This block
# runs unconditionally — PDFium isn't built, it's just downloaded, so it
# should not be coupled to --skip-build. The file-exists check below makes
# the block idempotent so re-running dev-setup is cheap.
PDFIUM_VERSION="${PDFIUM_VERSION:-chromium/7763}"
case "$TARGET_TRIPLE" in
    x86_64-unknown-linux-gnu)  PDFIUM_ASSET="pdfium-linux-x64.tgz"   ; PDFIUM_LIB="libpdfium.so"     ;;
    aarch64-unknown-linux-gnu) PDFIUM_ASSET="pdfium-linux-arm64.tgz" ; PDFIUM_LIB="libpdfium.so"     ;;
    x86_64-apple-darwin)       PDFIUM_ASSET="pdfium-mac-x64.tgz"     ; PDFIUM_LIB="libpdfium.dylib"  ;;
    aarch64-apple-darwin)      PDFIUM_ASSET="pdfium-mac-arm64.tgz"   ; PDFIUM_LIB="libpdfium.dylib"  ;;
    x86_64-pc-windows-msvc)    PDFIUM_ASSET="pdfium-win-x64.tgz"     ; PDFIUM_LIB="pdfium.dll"       ;;
    *) PDFIUM_ASSET="" ;;
esac
if [ -n "$PDFIUM_ASSET" ]; then
    mkdir -p "$BINARIES_DIR/libs"
    if [ ! -f "$BINARIES_DIR/libs/$PDFIUM_LIB" ]; then
        echo ">> Downloading PDFium library..."
        TMP_DIR=$(mktemp -d)
        if curl -fsSL -o "$TMP_DIR/pdfium.tgz" \
            "https://github.com/bblanchon/pdfium-binaries/releases/download/$PDFIUM_VERSION/$PDFIUM_ASSET"; then
            tar -xzf "$TMP_DIR/pdfium.tgz" -C "$TMP_DIR"
            if [ -f "$TMP_DIR/lib/$PDFIUM_LIB" ]; then
                cp "$TMP_DIR/lib/$PDFIUM_LIB" "$BINARIES_DIR/libs/"
            elif [ -f "$TMP_DIR/bin/$PDFIUM_LIB" ]; then
                cp "$TMP_DIR/bin/$PDFIUM_LIB" "$BINARIES_DIR/libs/"
            fi
            echo "   Installed: $PDFIUM_LIB"
        else
            echo "   WARN: failed to download PDFium — PDF extraction will use fallback"
        fi
        rm -rf "$TMP_DIR"
    else
        echo ">> PDFium already installed."
    fi
    echo
fi

# ---- Download ruff (Python linter sidecar) ----
# Used after fs_write_text / fs_edit_text on .py files to surface syntax
# and pyflakes errors back to the model in the same tool result. Prebuilt
# single-file binary from astral-sh/ruff releases — no build step needed.
RUFF_VERSION="$(cat "$PROJECT_ROOT/RUFF_VERSION" 2>/dev/null | tr -d '[:space:]')"
case "$TARGET_TRIPLE" in
    x86_64-unknown-linux-gnu)  RUFF_ASSET="ruff-x86_64-unknown-linux-gnu.tar.gz"   ; RUFF_EXE="ruff" ;;
    aarch64-unknown-linux-gnu) RUFF_ASSET="ruff-aarch64-unknown-linux-gnu.tar.gz"  ; RUFF_EXE="ruff" ;;
    x86_64-apple-darwin)       RUFF_ASSET="ruff-x86_64-apple-darwin.tar.gz"        ; RUFF_EXE="ruff" ;;
    aarch64-apple-darwin)      RUFF_ASSET="ruff-aarch64-apple-darwin.tar.gz"       ; RUFF_EXE="ruff" ;;
    x86_64-pc-windows-msvc)    RUFF_ASSET="ruff-x86_64-pc-windows-msvc.zip"        ; RUFF_EXE="ruff.exe" ;;
    *) RUFF_ASSET="" ;;
esac
if [ -n "$RUFF_ASSET" ] && [ -n "$RUFF_VERSION" ]; then
    RUFF_DEST="$BINARIES_DIR/ruff-$TARGET_TRIPLE"
    # Windows sidecars need the .exe suffix on top of the triple for Tauri.
    case "$TARGET_TRIPLE" in *windows*) RUFF_DEST="$RUFF_DEST.exe" ;; esac
    if [ -f "$RUFF_DEST" ]; then
        echo ">> ruff already installed."
    else
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
    fi
    echo
fi

# ---- Download Pyodide runtime (Python sandbox) ----
# Phase 11 — needed by the in-browser Python code-execution tool.
# Idempotent and self-contained; safe to re-run.
if [ "$SKIP_PYODIDE" = false ]; then
    "$SCRIPT_DIR/fetch-pyodide.sh"
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
