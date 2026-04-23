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

# Fix MSVC link.exe PATH conflict on Windows
source "$SCRIPT_DIR/msvc-path-fix.sh"

LLAMA_VERSION=$(cat "$PROJECT_ROOT/LLAMA_CPP_VERSION" 2>/dev/null || echo "master")
WHISPER_VERSION=$(cat "$PROJECT_ROOT/WHISPER_CPP_VERSION" 2>/dev/null || echo "master")
case "$TARGET" in
    *-windows-msvc) BUILD_DIR="$PROJECT_ROOT/.sidecar-build" ;;
    *)              BUILD_DIR="/tmp/haruspex-sidecar-build" ;;
esac
NPROC=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "${NUMBER_OF_PROCESSORS:-4}")

# Bundle any Homebrew/local dylibs a macOS binary depends on, recursively,
# and rewrite their install names to @rpath/... so the bundled app can find
# them without the user having Homebrew installed. GitHub's macOS runners
# ship with openssl@3 in Homebrew, which cmake happily auto-detects and links
# llama-server against; without this, end users hit "Library not loaded" for
# /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib.
bundle_external_dylibs_macos() {
    local binary="$1"
    local libs_dir="$BINARIES_DIR/libs"
    mkdir -p "$libs_dir"

    # Use files for the work queue because the otool pipeline below runs in
    # a subshell — shell arrays wouldn't survive.
    local todo seen
    todo=$(mktemp)
    seen=$(mktemp)
    echo "$binary" > "$todo"
    # Also process dylibs already copied from the llama.cpp/whisper.cpp build
    # output — they can pull in homebrew deps of their own.
    find "$libs_dir" -maxdepth 1 -name "*.dylib" -type f >> "$todo" 2>/dev/null || true

    while [ -s "$todo" ]; do
        local current
        current=$(sed -n '1p' "$todo")
        sed -i '' '1d' "$todo"

        grep -qxF "$current" "$seen" && continue
        echo "$current" >> "$seen"

        # A dylib's first otool -L line is its own install name — skip it.
        local selfid
        selfid=$(otool -D "$current" 2>/dev/null | awk 'NR==2{print;exit}')

        while read -r dep; do
            [ -z "$dep" ] && continue
            [ "$dep" = "$selfid" ] && continue
            case "$dep" in
                /opt/homebrew/*|/usr/local/*) ;;
                *) continue ;;
            esac

            local name
            name=$(basename "$dep")

            if [ ! -f "$libs_dir/$name" ]; then
                if cp -L "$dep" "$libs_dir/$name" 2>/dev/null; then
                    chmod u+w "$libs_dir/$name"
                    install_name_tool -id "@rpath/$name" "$libs_dir/$name" 2>/dev/null || true
                    # @loader_path lets a dylib find sibling dylibs (e.g.
                    # libssl finding libcrypto) without relying on the main
                    # binary's rpath alone.
                    install_name_tool -add_rpath "@loader_path" "$libs_dir/$name" 2>/dev/null || true
                    echo "   Bundled: $name (from $dep)"
                    echo "$libs_dir/$name" >> "$todo"
                fi
            fi

            install_name_tool -change "$dep" "@rpath/$name" "$current" 2>/dev/null || true
        done < <(otool -L "$current" 2>/dev/null | awk 'NR>1{print $1}')
    done

    rm -f "$todo" "$seen"

    # Bake rpaths into the main binary so dyld finds bundled dylibs even when
    # DYLD_LIBRARY_PATH isn't set (more robust than relying on the env var,
    # which hardened-runtime / SIP can strip).
    for rp in "@executable_path/../Resources/binaries/libs" "@loader_path"; do
        if ! otool -l "$binary" 2>/dev/null | grep -qF "path $rp "; then
            install_name_tool -add_rpath "$rp" "$binary" 2>/dev/null || true
        fi
    done
}

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

    # GGML_NATIVE=OFF disables -march=native so the binary is portable across
    # CPUs — otherwise CI runners with AVX-512 produce binaries that SIGILL on
    # older (e.g. Zen 3) user hardware.
    echo "   Configuring with flags: $CMAKE_GPU_FLAGS"
    if ! cmake "$LLAMA_SRC" -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF $CMAKE_GPU_FLAGS 2>&1; then
        echo "   WARN: cmake configure failed with GPU flags ($CMAKE_GPU_FLAGS), retrying CPU-only..."
        rm -rf "$BUILD_DIR/llama"
        mkdir -p "$BUILD_DIR/llama"
        cd "$BUILD_DIR/llama"
        cmake "$LLAMA_SRC" -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF 2>&1
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
    if ! cmake "$WHISPER_SRC" -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF $CMAKE_GPU_FLAGS 2>&1; then
        echo "   WARN: cmake configure failed with GPU flags, retrying CPU-only..."
        rm -rf "$BUILD_DIR/whisper"
        mkdir -p "$BUILD_DIR/whisper"
        cd "$BUILD_DIR/whisper"
        cmake "$WHISPER_SRC" -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF 2>&1
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
    sed 's/^reqwest[[:space:]]*=.*/reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }/' kokoros/Cargo.toml.bak > kokoros/Cargo.toml
    echo "   Patched reqwest:"
    grep reqwest kokoros/Cargo.toml
    # Remove lock file to force fresh dependency resolution with rustls
    rm -f Cargo.lock

    cargo build --release --bin koko 2>&1

    # Restore original Cargo.toml
    mv kokoros/Cargo.toml.bak kokoros/Cargo.toml

    cp target/release/koko${EXT} "$KOKO_BIN"
    chmod +x "$KOKO_BIN"

    # Bundle koko's dynamically-linked shared libraries (e.g. libsonic from espeak-ng)
    mkdir -p "$BINARIES_DIR/libs"
    if command -v ldd >/dev/null 2>&1; then
        ldd "$KOKO_BIN" 2>/dev/null | grep -v "linux-vdso\|ld-linux\|libc\.so\|libm\.so\|libdl\|libpthread\|librt\|libgcc_s\|libstdc++" | \
            awk '/=>/ {print $3}' | while read lib; do
            libname=$(basename "$lib")
            # Only copy libs not already bundled and not standard system libs
            if [ -f "$lib" ] && [ ! -f "$BINARIES_DIR/libs/$libname" ]; then
                case "$libname" in
                    libsonic*|libpcaudio*|libespeak*)
                        cp "$lib" "$BINARIES_DIR/libs/"
                        echo "   Bundled koko dep: $libname"
                        ;;
                esac
            fi
        done
    fi

    # Bundle espeak-ng-data (required for text phonemization at runtime).
    # espeak-rs-sys bakes the build-time path into the binary, so we must
    # ship the data and set ESPEAK_DATA_PATH at launch.
    # We need top-level files + the lang/ subdirectory (~13.5 MB total).
    # The espeak-rs-sys build output is under target/release/build/espeak-rs-sys-*/out/share/espeak-ng-data
    ESPEAK_BUILD_DATA=$(find target/release/build -type d -name "espeak-ng-data" 2>/dev/null | grep -i "share" | head -1)
    if [ -z "$ESPEAK_BUILD_DATA" ]; then
        ESPEAK_BUILD_DATA=$(find target/release/build -type d -name "espeak-ng-data" 2>/dev/null | head -1)
    fi
    ESPEAK_DEST="$BINARIES_DIR/espeak-ng-data"
    ESPEAK_SRC=""
    if [ -n "$ESPEAK_BUILD_DATA" ] && [ -d "$ESPEAK_BUILD_DATA" ]; then
        ESPEAK_SRC="$ESPEAK_BUILD_DATA"
    elif [ -d /usr/share/espeak-ng-data ]; then
        ESPEAK_SRC="/usr/share/espeak-ng-data"
    fi
    if [ -n "$ESPEAK_SRC" ]; then
        echo "   Bundling espeak-ng-data from $ESPEAK_SRC..."
        rm -rf "$ESPEAK_DEST"
        mkdir -p "$ESPEAK_DEST"
        # Copy top-level files (dict files, phontab, intonations)
        find "$ESPEAK_SRC" -maxdepth 1 -type f -exec cp {} "$ESPEAK_DEST/" \;
        # Copy lang/ subdirectory (needed for language identification)
        if [ -d "$ESPEAK_SRC/lang" ]; then
            cp -r "$ESPEAK_SRC/lang" "$ESPEAK_DEST/lang"
        fi
    else
        echo "   WARN: espeak-ng-data not found — TTS phonemization may fail at runtime"
        echo "   Creating placeholder files so the Tauri resource globs don't break the build"
        mkdir -p "$ESPEAK_DEST/lang/placeholder"
        touch "$ESPEAK_DEST/.placeholder"
        touch "$ESPEAK_DEST/lang/.placeholder"
        touch "$ESPEAK_DEST/lang/placeholder/.placeholder"
    fi

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

        # Bundle OpenSSL DLLs if any sidecar links against them.
        # llama.cpp and some transitive deps may pull in libcurl → OpenSSL.
        # These DLLs are typically found alongside the sidecar build output
        # or in common Windows locations.
        echo ">> Bundling OpenSSL DLLs (if needed)..."
        for ssl_dll in libcrypto-3-x64.dll libssl-3-x64.dll; do
            if [ -f "$BINARIES_DIR/libs/$ssl_dll" ]; then
                continue
            fi
            # Search common locations: sidecar build output, system, Git, Strawberry Perl
            SSL_SRC=""
            for search_dir in \
                "$BUILD_DIR/llama/bin/Release" \
                "$BUILD_DIR/llama/bin" \
                "C:/Program Files/OpenSSL-Win64" \
                "C:/Program Files/OpenSSL-Win64/bin" \
                "C:/Program Files/Git/mingw64/bin" \
                "C:/Strawberry/c/bin" \
                "C:/Windows/System32"; do
                if [ -f "$search_dir/$ssl_dll" ]; then
                    SSL_SRC="$search_dir/$ssl_dll"
                    break
                fi
            done
            if [ -n "$SSL_SRC" ]; then
                cp "$SSL_SRC" "$BINARIES_DIR/libs/"
                echo "   Copied: $ssl_dll (from $SSL_SRC)"
            fi
        done
        echo
        ;;
esac

# ---- Bundle external dylibs (macOS) ----
# Done after all sidecars are built so the function can see every dylib that
# landed in binaries/libs/ from each build.
case "$TARGET" in
    *-apple-darwin)
        echo ">> Bundling external (Homebrew) dylibs for macOS..."
        for sidecar_name in llama-server whisper-server koko; do
            sidecar_path="$BINARIES_DIR/${sidecar_name}-${TARGET}"
            if [ -f "$sidecar_path" ]; then
                bundle_external_dylibs_macos "$sidecar_path"
            fi
        done
        echo
        ;;
esac

# ---- Download PDFium library ----
# Used by pdfium-render in the main app binary for high-quality PDF text
# extraction (handles forms, custom fonts, position-aware reading order).
# Binaries come from https://github.com/bblanchon/pdfium-binaries.
PDFIUM_VERSION="${PDFIUM_VERSION:-chromium/7763}"
case "$TARGET" in
    x86_64-unknown-linux-gnu)  PDFIUM_ASSET="pdfium-linux-x64.tgz"        ; PDFIUM_LIB="libpdfium.so"     ;;
    aarch64-unknown-linux-gnu) PDFIUM_ASSET="pdfium-linux-arm64.tgz"      ; PDFIUM_LIB="libpdfium.so"     ;;
    x86_64-apple-darwin)       PDFIUM_ASSET="pdfium-mac-x64.tgz"          ; PDFIUM_LIB="libpdfium.dylib"  ;;
    aarch64-apple-darwin)      PDFIUM_ASSET="pdfium-mac-arm64.tgz"        ; PDFIUM_LIB="libpdfium.dylib"  ;;
    x86_64-pc-windows-msvc)    PDFIUM_ASSET="pdfium-win-x64.tgz"          ; PDFIUM_LIB="pdfium.dll"       ;;
    *) PDFIUM_ASSET="" ;;
esac

if [ -n "$PDFIUM_ASSET" ]; then
    mkdir -p "$BINARIES_DIR/libs"
    if [ ! -f "$BINARIES_DIR/libs/$PDFIUM_LIB" ]; then
        echo ">> Downloading PDFium ($PDFIUM_VERSION / $PDFIUM_ASSET)..."
        PDFIUM_URL="https://github.com/bblanchon/pdfium-binaries/releases/download/$PDFIUM_VERSION/$PDFIUM_ASSET"
        TMP_DIR=$(mktemp -d)
        if curl -fsSL -o "$TMP_DIR/pdfium.tgz" "$PDFIUM_URL"; then
            tar -xzf "$TMP_DIR/pdfium.tgz" -C "$TMP_DIR"
            # The archive contains lib/libpdfium.so (or bin/pdfium.dll on Windows)
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
            echo "   WARN: Failed to download PDFium from $PDFIUM_URL"
        fi
        rm -rf "$TMP_DIR"
    else
        echo ">> PDFium already installed: $BINARIES_DIR/libs/$PDFIUM_LIB"
    fi
    echo
else
    echo ">> WARN: unknown target $TARGET for PDFium — skipping"
    echo
fi

# ---- Summary ----
echo "========================================"
echo "  Sidecars built for $TARGET:"
for bin in "$BINARIES_DIR"/*-"$TARGET"*; do
    [ -f "$bin" ] && echo "    $(basename $bin) ($(du -h "$bin" | cut -f1))"
done
echo "========================================"
