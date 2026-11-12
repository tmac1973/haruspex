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
# and muxers are cut down to what they write. libav* are linked statically;
# lame is built from source and linked statically too. What stays dynamic is
# what the platform provides: glibc, gnutls, ALSA and PulseAudio on Linux
# (every desktop has them), the system frameworks on macOS. Windows is fully
# static.
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
        )
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
        )
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
        )
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
    --enable-encoder=png,mjpeg,pcm_s16le,flac,aac,libmp3lame \
    --disable-muxers \
    --enable-muxer=image2,image2pipe,wav,flac,mp3,adts,null \
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
