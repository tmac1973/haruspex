#!/bin/bash
# Builds the LGPL ffmpeg and ffprobe Haruspex ships as
# haruspex-ffmpeg-<triple>[.exe] / haruspex-ffprobe-<triple>[.exe].
#
# Run by .github/workflows/build-ffmpeg.yml, which publishes the results to the
# ffmpeg-<tag> release that scripts/fetch-ffmpeg.sh downloads. Runnable locally
# on Linux with the packages that workflow installs.
#
# LGPL only: no --enable-gpl, no x264/x265, nothing nonfree. The cameras and
# the video tools only decode, grab frames and extract sound, so the encoders
# and muxers are cut down to what they write, plus the hardware H.264 encoders
# Settings → Video editing tests before melt is let near one (melt crashes on
# an encoder that won't open): VA-API, NVENC and Quick Sync on Linux; NVENC,
# AMF and Quick Sync on Windows; VideoToolbox on macOS. All are LGPL-safe.
#
# libav* are linked statically, and so is everything built from source here:
# lame, and on Linux libdrm, libva and libvpl, so that a machine without
# libva still runs ffmpeg (libva finds the GPU's driver at run time, in the
# distros' usual folders). NVENC and AMF need only headers; their drivers are
# loaded when an encoder opens. What stays dynamic is what the platform
# provides: glibc, libstdc++, gnutls, ALSA and PulseAudio on Linux (every
# desktop has them), the system frameworks on macOS. Windows is fully static.
#
# Usage: ./scripts/build-ffmpeg.sh --target <triple> [--out <dir>]
#   --out defaults to src-tauri/binaries/. FFMPEG_BUILD_DIR sets the scratch
#   directory (default: a fresh temp dir).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Keep in step with FFMPEG_TAG in fetch-ffmpeg.sh and the release tag in
# build-ffmpeg.yml.
FFMPEG_TAG="n8.1.3"
FFMPEG_REPO="https://github.com/FFmpeg/FFmpeg.git"
LAME_VERSION="3.100"
LAME_URL="https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz"
LAME_SHA256="ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e"
# Hardware encoders' dependencies, by git tag.
NVCODEC_TAG="n12.1.14.0"   # NVENC headers: drivers 530 and newer
LIBDRM_TAG="libdrm-2.4.124"
# libva loads a GPU driver by an entry point named for the libva version the
# driver was built against, and looks from its own version down: it must be at
# least as new as the distros' (Fedora 44 ships 2.23). Keep it at the latest.
LIBVA_TAG="2.24.1"
LIBVPL_TAG="v2.15.0"

TARGET=""
OUT_DIR="$PROJECT_ROOT/src-tauri/binaries"
while [[ $# -gt 0 ]]; do
    case $1 in
        --target) TARGET="$2"; shift 2 ;;
        --out) OUT_DIR="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done
[ -z "$TARGET" ] && TARGET="$(rustc --print host-tuple)"

case "$(uname -s)" in
    Darwin) JOBS="$(sysctl -n hw.ncpu)" ;;
    *)      JOBS="$(nproc)" ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
    sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
else
    sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

WORK="${FFMPEG_BUILD_DIR:-$(mktemp -d)}"
PREFIX="$WORK/prefix"
mkdir -p "$WORK" "$PREFIX" "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
echo ">> Building ffmpeg $FFMPEG_TAG for $TARGET in $WORK"

# ---- Per-target settings ----
EXT=""
# Empty arrays are expanded as ${A[@]+"${A[@]}"}: macOS's bash 3.2 calls a
# plain "${A[@]}" of an empty array unbound under set -u.
CROSS=()
LAME_HOST=()
PKG_CONFIG_FLAGS=()
EXTRA_CFLAGS="-I$PREFIX/include"
EXTRA_LDFLAGS="-L$PREFIX/lib"
HW_ENCODERS=""
case "$TARGET" in
    x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu)
        # shellcheck disable=SC2054 # the commas belong to --enable-indev
        PLATFORM=(
            --disable-autodetect
            --enable-pthreads
            --enable-zlib
            --enable-gnutls
            --enable-alsa
            --enable-libpulse
            --enable-indev=v4l2,alsa,pulse
            --enable-vaapi
            --enable-ffnvcodec
            --enable-nvenc
            --enable-libvpl
        )
        HW_ENCODERS="h264_vaapi,h264_nvenc,h264_qsv"
        # Where libva looks for the GPU's driver: the folders Debian/Ubuntu,
        # Fedora and Arch put them in (LIBVA_DRIVERS_PATH still overrides).
        # Fedora's own mesa has no H.264; RPM Fusion's freeworld and nonfree
        # drivers do, in their own folders, which Fedora's libva tries first.
        ARCH_DIR="${TARGET%%-*}-linux-gnu"
        VA_DRIVER_DIRS="/usr/lib/$ARCH_DIR/dri:/usr/lib64/dri-nonfree:/usr/lib64/dri-freeworld:/usr/lib64/dri:/usr/lib/dri"
        ;;
    aarch64-apple-darwin|x86_64-apple-darwin)
        export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
        # Autodetect stays on here: it is what finds the system frameworks
        # avfoundation needs. Anything a Homebrew runner might offer is
        # switched off by name.
        PLATFORM=(
            --enable-zlib
            --enable-securetransport
            --enable-avfoundation
            --enable-indev=avfoundation
            --disable-sdl2
            --disable-xlib
            --disable-libxcb
            --disable-lzma
            --disable-iconv
            --disable-vulkan
            --enable-videotoolbox
        )
        HW_ENCODERS="h264_videotoolbox"
        if [ "$TARGET" = "x86_64-apple-darwin" ] && [ "$(uname -m)" != "x86_64" ]; then
            CROSS=(--enable-cross-compile --arch=x86_64 --target-os=darwin)
            EXTRA_CFLAGS="$EXTRA_CFLAGS -arch x86_64"
            EXTRA_LDFLAGS="$EXTRA_LDFLAGS -arch x86_64"
            LAME_HOST=(--host=x86_64-apple-darwin)
            export CFLAGS="-arch x86_64" LDFLAGS="-arch x86_64"
        fi
        ;;
    x86_64-pc-windows-msvc)
        # Built in MSYS2's MINGW64 shell; named with the msvc triple, as the
        # other sidecars are. -static keeps libgcc and winpthread out of DLLs.
        EXT=".exe"
        PLATFORM=(
            --disable-autodetect
            --enable-w32threads
            --enable-zlib
            --enable-schannel
            --enable-indev=dshow
            --enable-ffnvcodec
            --enable-nvenc
            --enable-amf
            --enable-libvpl
            # MSYS2's libvpl is C++ and its vpl.pc doesn't say so; -static
            # links libstdc++ in.
            --extra-libs=-lstdc++
        )
        HW_ENCODERS="h264_nvenc,h264_amf,h264_qsv"
        EXTRA_LDFLAGS="$EXTRA_LDFLAGS -static"
        PKG_CONFIG_FLAGS=(--pkg-config-flags=--static)
        ;;
    *)
        echo "ERROR: no ffmpeg build for $TARGET"
        exit 1
        ;;
esac

# ---- lame (LGPL), static ----
if [ ! -f "$PREFIX/lib/libmp3lame.a" ]; then
    echo ">> Building lame $LAME_VERSION"
    curl -fsSL -o "$WORK/lame.tar.gz" "$LAME_URL"
    ACTUAL="$(sha256_of "$WORK/lame.tar.gz")"
    if [ "$ACTUAL" != "$LAME_SHA256" ]; then
        echo "ERROR: lame checksum mismatch: expected $LAME_SHA256, got $ACTUAL"
        exit 1
    fi
    rm -rf "$WORK/lame-$LAME_VERSION"
    tar -xzf "$WORK/lame.tar.gz" -C "$WORK"
    (
        cd "$WORK/lame-$LAME_VERSION"
        # The export list names a symbol 3.100 no longer defines, which breaks
        # the link on macOS. Homebrew drops it the same way.
        grep -v '^lame_init_old$' include/libmp3lame.sym > include/libmp3lame.sym.new
        mv include/libmp3lame.sym.new include/libmp3lame.sym
        ./configure --prefix="$PREFIX" ${LAME_HOST[@]+"${LAME_HOST[@]}"} \
            --enable-static --disable-shared --disable-frontend \
            --disable-decoder --disable-dependency-tracking
        make -j"$JOBS"
        make install
    )
fi

export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:$PREFIX/lib64/pkgconfig:$PREFIX/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

# A git checkout of `tag` from `repo` in $WORK/`name`.
checkout() {
    local name="$1" repo="$2" tag="$3"
    if [ ! -d "$WORK/$name/.git" ]; then
        git clone --depth 1 --branch "$tag" "$repo" "$WORK/$name"
    fi
}

case "$TARGET" in
    *-linux-gnu|*-windows-msvc)
        # ---- NVENC headers (MIT) ----
        if [ ! -f "$PREFIX/include/ffnvcodec/nvEncodeAPI.h" ]; then
            echo ">> Installing nv-codec-headers $NVCODEC_TAG"
            checkout nv-codec-headers https://github.com/FFmpeg/nv-codec-headers.git "$NVCODEC_TAG"
            make -C "$WORK/nv-codec-headers" install PREFIX="$PREFIX"
        fi
        ;;
esac

case "$TARGET" in
    *-linux-gnu)
        # ---- libdrm and libva (MIT), static ----
        if [ ! -f "$PREFIX/lib/libdrm.a" ] && [ ! -f "$PREFIX/lib64/libdrm.a" ]; then
            echo ">> Building $LIBDRM_TAG"
            checkout libdrm https://gitlab.freedesktop.org/mesa/drm.git "$LIBDRM_TAG"
            meson setup "$WORK/libdrm/build" "$WORK/libdrm" --prefix="$PREFIX" --libdir=lib \
                --default-library=static --buildtype=release \
                -Dintel=disabled -Dradeon=disabled -Damdgpu=disabled -Dnouveau=disabled \
                -Dvmwgfx=disabled -Domap=disabled -Dexynos=disabled -Dfreedreno=disabled \
                -Dtegra=disabled -Dvc4=disabled -Detnaviv=disabled -Dcairo-tests=disabled \
                -Dman-pages=disabled -Dvalgrind=disabled -Dtests=false -Dinstall-test-programs=false
            ninja -C "$WORK/libdrm/build" install
        fi
        if [ ! -f "$PREFIX/lib/libva.a" ]; then
            echo ">> Building libva $LIBVA_TAG"
            checkout libva https://github.com/intel/libva.git "$LIBVA_TAG"
            meson setup "$WORK/libva/build" "$WORK/libva" --prefix="$PREFIX" --libdir=lib \
                --buildtype=release \
                -Ddriverdir="$VA_DRIVER_DIRS" \
                -Dwith_x11=no -Dwith_glx=no -Dwith_wayland=no -Denable_docs=false
            ninja -C "$WORK/libva/build" install
            # libva only builds shared libraries. Archive its objects into
            # static ones and drop the .so files so ffmpeg links those.
            for lib in libva libva-drm; do
                objs=("$WORK/libva/build/va/$lib.so".*.p/*.o)
                ar rcs "$PREFIX/lib/$lib.a" "${objs[@]}"
                rm -f "$PREFIX/lib/$lib.so" "$PREFIX/lib/$lib.so".*
            done
        fi
        # ---- libvpl, Intel's Quick Sync dispatcher (MIT), static ----
        if [ ! -f "$PREFIX/lib/libvpl.a" ]; then
            echo ">> Building libvpl $LIBVPL_TAG"
            checkout libvpl https://github.com/intel/libvpl.git "$LIBVPL_TAG"
            cmake -S "$WORK/libvpl" -B "$WORK/libvpl/build" -DCMAKE_BUILD_TYPE=Release \
                -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_INSTALL_LIBDIR=lib \
                -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF \
                -DINSTALL_EXAMPLES=OFF -DBUILD_TOOLS=OFF
            cmake --build "$WORK/libvpl/build" -j"$JOBS"
            cmake --install "$WORK/libvpl/build"
        fi
        # These are static, so what they link against has to come along, and
        # their .pc files don't all say: libva-drm needs libdrm, libva dlopens
        # its driver, libvpl is C++. Not pkg-config --static: that would pull
        # the system's gnutls in statically too, whose static deps aren't there.
        add_libs() { sed -i "s|^Libs:\(.*\)|Libs:\1 $2|" "$PREFIX/lib/pkgconfig/$1.pc"; }
        grep -q -- '-ldrm' "$PREFIX/lib/pkgconfig/libva-drm.pc" || add_libs libva-drm "-ldrm"
        grep -q -- '-ldl' "$PREFIX/lib/pkgconfig/libva.pc" || add_libs libva "-ldl -lpthread"
        grep -q -- '-lstdc++' "$PREFIX/lib/pkgconfig/vpl.pc" || add_libs vpl "-lstdc++"
        ;;
esac

# ---- ffmpeg ----
SRC="$WORK/ffmpeg"
if [ ! -d "$SRC/.git" ]; then
    git clone --depth 1 --branch "$FFMPEG_TAG" "$FFMPEG_REPO" "$SRC"
fi

cd "$SRC"
./configure \
    --prefix="$PREFIX" \
    ${CROSS[@]+"${CROSS[@]}"} \
    ${PKG_CONFIG_FLAGS[@]+"${PKG_CONFIG_FLAGS[@]}"} \
    --extra-cflags="$EXTRA_CFLAGS" \
    --extra-ldflags="$EXTRA_LDFLAGS" \
    --disable-gpl \
    --disable-nonfree \
    --enable-version3 \
    --enable-static \
    --disable-shared \
    --disable-doc \
    --disable-ffplay \
    --disable-debug \
    --enable-libmp3lame \
    --disable-encoders \
    --enable-encoder=png,mjpeg,rawvideo,wrapped_avframe,pcm_s16le,flac,aac,libmp3lame${HW_ENCODERS:+,$HW_ENCODERS} \
    --disable-muxers \
    --enable-muxer=image2,image2pipe,rawvideo,segment,wav,flac,mp3,adts,null \
    --disable-protocols \
    --enable-protocol=file,pipe,rtp,tcp,udp,http,https,tls,httpproxy \
    --disable-indevs \
    --enable-indev=lavfi \
    --disable-outdevs \
    "${PLATFORM[@]}"

# The licence is the point of building our own: refuse to ship anything else.
if ! grep -q '^#define CONFIG_GPL 0' config.h || ! grep -q '^#define CONFIG_NONFREE 0' config.h; then
    echo "ERROR: configure produced a GPL or nonfree build"
    exit 1
fi

make -j"$JOBS"

for tool in ffmpeg ffprobe; do
    cp "$tool$EXT" "$OUT_DIR/haruspex-$tool-$TARGET$EXT"
    chmod +x "$OUT_DIR/haruspex-$tool-$TARGET$EXT"
    echo "   Built: $OUT_DIR/haruspex-$tool-$TARGET$EXT"
done
