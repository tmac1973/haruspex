#!/bin/bash
# Builds Haruspex's media bundle for one target: GPL ffmpeg and ffprobe as
# shared libraries, melt (MLT) with only the modules Kdenlive and Shotcut
# projects need, and the cut-down Qt 6 that MLT's qt6 module renders `qtblend`
# with. The result is dist/media-<triple>.tar.xz:
#
#   haruspex-ffmpeg-<triple>[.exe]
#   haruspex-ffprobe-<triple>[.exe]
#   haruspex-melt-<triple>[.exe]
#   media/lib/         libav*, libsw*, libmlt*, Qt (DLLs on Windows)
#   media/mlt/         MLT modules
#   media/mlt-data/    MLT data: profiles, presets, service metadata
#   media/qt-plugins/  platforms/ (offscreen), imageformats/
#   media/LICENSES/    every component's licence
#
# Run by .github/workflows/build-media.yml, which publishes the archives to the
# media-<tag> release scripts/fetch-media.sh downloads. Runnable locally on
# Linux in an ubuntu:24.04 container with the packages that workflow installs.
#
# Licences: Haruspex is GPL-3.0-or-later, so the bundle is a GPL build: ffmpeg
# with libx264 (melt's software H.264 encoder) and MLT's GPL modules (qt6,
# plusgpl, normalize). Nothing nonfree, and a build that says otherwise is
# refused.
#
# What the cameras and the video tools need from ffmpeg: decoding, frame grabs
# and sound extraction, so encoders and muxers are cut down to what they write,
# plus the hardware H.264 encoders Settings → Video editing tests before melt
# is let near one (melt crashes on an encoder that won't open): VA-API, NVENC
# and Quick Sync on Linux; NVENC, AMF and Quick Sync on Windows; VideoToolbox
# on macOS. All are LGPL-safe. melt renders through the same libav*, so the
# formats it writes are the ones listed here (MP4 with H.264 from libx264 or
# a hardware encoder, and AAC). WebM is written too (VP8/VP9 from libvpx, with
# Opus), and dav1d decodes AV1 in software, which ComfyUI's clips need.
#
# Everything built from source here is linked into the shared libraries:
# lame, x264, opus, dav1d, libvpx, libxml2, and on Linux libdrm, libva and libvpl, so a machine without
# libva still runs. What stays dynamic is what the platform provides: glibc,
# libstdc++, gnutls, ALSA, PulseAudio, fontconfig and freetype on Linux (every
# desktop has them), the system frameworks on macOS, the system DLLs on
# Windows (MinGW's runtime is linked in statically).
#
# Libraries find each other by rpath on Linux and macOS ($ORIGIN /
# @loader_path), set for the dev layout (binaries/), the deb/rpm/AppImage
# layout (/usr/bin + /usr/lib/Haruspex/binaries/) and the .app layout
# (Contents/MacOS + Contents/Resources/binaries/). Windows has no rpath: the app
# puts media\lib on PATH for every spawn (src-tauri/src/media_env.rs), which
# sets the library path everywhere as a second line of defence.
#
# Usage: ./scripts/build-media.sh --target <triple> [--out <dir>]
#   --out defaults to dist/. MEDIA_BUILD_DIR sets the scratch directory
#   (default: a fresh temp dir); a reused one skips what is already built.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
# shellcheck source=media-versions.sh
. "$SCRIPT_DIR/media-versions.sh"

FFMPEG_REPO="https://github.com/FFmpeg/FFmpeg.git"
LAME_VERSION="3.100"
LAME_URL="https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz"
LAME_SHA256="ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e"
# x264's stable branch, by commit (it has no release tags).
X264_COMMIT="b35605ace3ddf7c1a5d67a2eb553f034aef41d55"
# AV1 decoding (ComfyUI's clips are AV1 WebM; ffmpeg's own av1 decoder only
# runs on hardware), and Opus and VP8/VP9 for writing WebM.
DAV1D_TAG="1.5.5"
OPUS_VERSION="1.6.1"
OPUS_URL="https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz"
OPUS_SHA256="6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1"
LIBVPX_TAG="v1.17.0"
LIBXML2_VERSION="2.13.8"
LIBXML2_URL="https://download.gnome.org/sources/libxml2/${LIBXML2_VERSION%.*}/libxml2-$LIBXML2_VERSION.tar.xz"
LIBXML2_SHA256="277294cb33119ab71b2bc81f2f445e9bc9435b893ad15bb2cd2b0e859a0ee84a"
QT_URL="https://download.qt.io/archive/qt/${QT_VERSION%.*}/$QT_VERSION/submodules"
QTBASE_SHA256="46de0710b594945a5d446ae44354daa386141c6903c53781b2ca547bc62f8f8f"
QTSVG_SHA256="9bdf6fa4b5a2d91c3eaa2edd12263fdff0ae19d0ac25d3c99946cd4189a07123"
MLT_URL="https://github.com/mltframework/mlt/releases/download/v$MLT_VERSION/mlt-$MLT_VERSION.tar.gz"
MLT_SHA256="f11c30e21670f62a3dfc56a31306ac02f3feea00908a2821a4a0bf3e989d3d6a"
# Hardware encoders' dependencies, by git tag.
NVCODEC_TAG="n12.1.14.0"   # NVENC headers: drivers 530 and newer
LIBDRM_TAG="libdrm-2.4.124"
# libva loads a GPU driver by an entry point named for the libva version the
# driver was built against, and looks from its own version down: it must be at
# least as new as the distros' (Fedora 44 ships 2.23). Keep it at the latest.
LIBVA_TAG="2.24.1"
LIBVPL_TAG="v2.15.0"

TARGET=""
OUT_DIR="$PROJECT_ROOT/dist"
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

WORK="${MEDIA_BUILD_DIR:-$(mktemp -d)}"
PREFIX="$WORK/prefix"
mkdir -p "$WORK" "$PREFIX" "$OUT_DIR"
# Physical paths: Qt refuses a build directory reached through a symlink, as
# macOS's temp folder is (/var -> /private/var).
WORK="$(cd "$WORK" && pwd -P)"
PREFIX="$(cd "$PREFIX" && pwd -P)"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
echo ">> Building the media bundle ($MEDIA_TAG) for $TARGET in $WORK"

# A tarball from `url`, checked against `sha`, unpacked into $WORK/`dir`.
fetch() {
    local url="$1" sha="$2" dir="$3"
    local file
    file="$WORK/$(basename "$url")"
    [ -f "$file" ] || curl -fsSL -o "$file" "$url"
    local actual
    actual="$(sha256_of "$file")"
    if [ "$actual" != "$sha" ]; then
        echo "ERROR: $(basename "$url") checksum mismatch: expected $sha, got $actual"
        exit 1
    fi
    if [ ! -d "$WORK/$dir" ]; then
        tar -xf "$file" -C "$WORK"
    fi
}

# A git checkout of `tag` from `repo` in $WORK/`name`.
checkout() {
    local name="$1" repo="$2" tag="$3"
    if [ ! -d "$WORK/$name/.git" ]; then
        git clone --depth 1 --branch "$tag" "$repo" "$WORK/$name"
    fi
}

# ---- Per-target settings ----
EXT=""
OS=""
# Empty arrays are expanded as ${A[@]+"${A[@]}"}: macOS's bash 3.2 calls a
# plain "${A[@]}" of an empty array unbound under set -u.
CROSS=()
LAME_HOST=()
PKG_CONFIG_FLAGS=()
CMAKE_EXTRA=()
QT_PLATFORM=()
QT_ARCHS=()
EXTRA_CFLAGS="-I$PREFIX/include"
EXTRA_LDFLAGS="-L$PREFIX/lib"
HW_ENCODERS=""
case "$TARGET" in
    x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu)
        OS=linux
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
        # Text in titles and Shotcut's text filters needs the desktop's fonts.
        QT_PLATFORM=(-DFEATURE_fontconfig=ON -DFEATURE_system_freetype=ON)
        ;;
    aarch64-apple-darwin|x86_64-apple-darwin)
        OS=macos
        # Qt 6.11 supports macOS 13 and newer, so the bundle does too.
        export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
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
            --install-name-dir=@rpath
        )
        HW_ENCODERS="h264_videotoolbox"
        # Room in the load commands for the rpaths and install names the
        # collect step rewrites.
        EXTRA_LDFLAGS="$EXTRA_LDFLAGS -Wl,-headerpad_max_install_names"
        MAC_ARCH="${TARGET%%-*}"
        [ "$MAC_ARCH" = "aarch64" ] && MAC_ARCH="arm64"
        CMAKE_EXTRA=(-DCMAKE_OSX_ARCHITECTURES="$MAC_ARCH" -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET")
        QT_PLATFORM=(-DFEATURE_framework=OFF -DFEATURE_system_freetype=OFF)
        # Qt cross-compiled to x86_64 would need a host Qt for its tools; built
        # universal it runs its own, and the x86_64 half is kept at the end.
        QT_ARCHS=(-DCMAKE_OSX_ARCHITECTURES="$MAC_ARCH")
        if [ "$TARGET" = "x86_64-apple-darwin" ] && [ "$(uname -m)" != "x86_64" ]; then
            QT_ARCHS=(-DCMAKE_OSX_ARCHITECTURES="x86_64;arm64")
            CROSS=(--enable-cross-compile --arch=x86_64 --target-os=darwin)
            EXTRA_CFLAGS="$EXTRA_CFLAGS -arch x86_64"
            EXTRA_LDFLAGS="$EXTRA_LDFLAGS -arch x86_64"
            LAME_HOST=(--host=x86_64-apple-darwin)
            export CFLAGS="-arch x86_64" LDFLAGS="-arch x86_64"
        fi
        ;;
    x86_64-pc-windows-msvc)
        OS=windows
        # Built in MSYS2's MINGW64 shell; named with the msvc triple, as the
        # other sidecars are. libgcc, libstdc++ and winpthread are linked in
        # statically, so the only DLLs are ours and the system's.
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
            # MSYS2's libvpl is C++ and its vpl.pc doesn't say so.
            --extra-libs=-lstdc++
        )
        HW_ENCODERS="h264_nvenc,h264_amf,h264_qsv"
        EXTRA_LDFLAGS="$EXTRA_LDFLAGS -static-libgcc -static-libstdc++ -Wl,-Bstatic -lwinpthread -Wl,-Bdynamic"
        PKG_CONFIG_FLAGS=(--pkg-config-flags=--static)
        CMAKE_EXTRA=(
            "-DCMAKE_EXE_LINKER_FLAGS=-static-libgcc -static-libstdc++ -Wl,-Bstatic,--whole-archive -lwinpthread -Wl,--no-whole-archive,-Bdynamic"
            "-DCMAKE_SHARED_LINKER_FLAGS=-static-libgcc -static-libstdc++ -Wl,-Bstatic,--whole-archive -lwinpthread -Wl,--no-whole-archive,-Bdynamic"
        )
        QT_PLATFORM=(-DFEATURE_system_freetype=OFF)
        ;;
    *)
        echo "ERROR: no media build for $TARGET"
        exit 1
        ;;
esac

export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:$PREFIX/lib64/pkgconfig:$PREFIX/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

# ---- lame (LGPL), static, position-independent ----
if [ ! -f "$PREFIX/lib/libmp3lame.a" ]; then
    echo ">> Building lame $LAME_VERSION"
    fetch "$LAME_URL" "$LAME_SHA256" "lame-$LAME_VERSION"
    (
        cd "$WORK/lame-$LAME_VERSION"
        # The export list names a symbol 3.100 no longer defines, which breaks
        # the link on macOS. Homebrew drops it the same way.
        grep -v '^lame_init_old$' include/libmp3lame.sym > include/libmp3lame.sym.new
        mv include/libmp3lame.sym.new include/libmp3lame.sym
        ./configure --prefix="$PREFIX" ${LAME_HOST[@]+"${LAME_HOST[@]}"} \
            --enable-static --disable-shared --with-pic --disable-frontend \
            --disable-decoder --disable-dependency-tracking
        make -j"$JOBS"
        make install
    )
fi

# ---- x264 (GPL), static, position-independent ----
if [ ! -f "$PREFIX/lib/libx264.a" ]; then
    echo ">> Building x264 $X264_COMMIT"
    if [ ! -d "$WORK/x264/.git" ]; then
        git init -q "$WORK/x264"
        git -C "$WORK/x264" fetch -q --depth 1 https://code.videolan.org/videolan/x264.git "$X264_COMMIT"
        git -C "$WORK/x264" checkout -q FETCH_HEAD
    fi
    (
        cd "$WORK/x264"
        X264_HOST=()
        [ "${#LAME_HOST[@]}" -gt 0 ] && X264_HOST=(--host=x86_64-apple-darwin)
        ./configure --prefix="$PREFIX" ${X264_HOST[@]+"${X264_HOST[@]}"} \
            --enable-static --enable-pic --disable-cli --disable-opencl \
            --disable-lavf --disable-swscale --disable-ffms --disable-gpac --disable-lsmash
        make -j"$JOBS"
        make install
    )
fi

# ---- opus (BSD-3-Clause), static, position-independent ----
if [ ! -f "$PREFIX/lib/libopus.a" ]; then
    echo ">> Building opus $OPUS_VERSION"
    fetch "$OPUS_URL" "$OPUS_SHA256" "opus-$OPUS_VERSION"
    (
        cd "$WORK/opus-$OPUS_VERSION"
        ./configure --prefix="$PREFIX" ${LAME_HOST[@]+"${LAME_HOST[@]}"} \
            --enable-static --disable-shared --with-pic --disable-doc \
            --disable-extra-programs --disable-dependency-tracking
        make -j"$JOBS"
        make install
    )
fi

# ---- dav1d (BSD-2-Clause), AV1 decoding, static, position-independent ----
if [ ! -f "$PREFIX/lib/libdav1d.a" ]; then
    echo ">> Building dav1d $DAV1D_TAG"
    checkout dav1d https://code.videolan.org/videolan/dav1d.git "$DAV1D_TAG"
    DAV1D_CROSS=()
    if [ "${#LAME_HOST[@]}" -gt 0 ]; then
        # The x86_64 macOS build on an arm64 runner: meson has to be told.
        cat > "$WORK/dav1d-cross.txt" <<'EOF'
[binaries]
c = 'clang'
ar = 'ar'
strip = 'strip'
nasm = 'nasm'

[built-in options]
c_args = ['-arch', 'x86_64']
c_link_args = ['-arch', 'x86_64']

[host_machine]
system = 'darwin'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
EOF
        DAV1D_CROSS=(--cross-file "$WORK/dav1d-cross.txt")
    fi
    (
        # The cross build's exported -arch flags are in the cross file.
        unset CFLAGS LDFLAGS
        meson setup "$WORK/dav1d/build" "$WORK/dav1d" --prefix="$PREFIX" --libdir=lib \
            ${DAV1D_CROSS[@]+"${DAV1D_CROSS[@]}"} \
            --default-library=static --buildtype=release -Db_staticpic=true \
            -Denable_tools=false -Denable_tests=false -Denable_docs=false
        ninja -C "$WORK/dav1d/build" install
    )
fi

# ---- libvpx (BSD-3-Clause), VP8 and VP9 encoding only, static ----
# ffmpeg decodes VP8 and VP9 itself; libvpx is here to write WebM.
if [ ! -f "$PREFIX/lib/libvpx.a" ]; then
    echo ">> Building libvpx $LIBVPX_TAG"
    checkout libvpx https://github.com/webmproject/libvpx.git "$LIBVPX_TAG"
    case "$TARGET" in
        x86_64-unknown-linux-gnu) VPX_TARGET=x86_64-linux-gcc ;;
        aarch64-unknown-linux-gnu) VPX_TARGET=arm64-linux-gcc ;;
        # darwin22 is macOS 13, the bundle's minimum.
        aarch64-apple-darwin) VPX_TARGET=arm64-darwin22-gcc ;;
        x86_64-apple-darwin) VPX_TARGET=x86_64-darwin22-gcc ;;
        x86_64-pc-windows-msvc) VPX_TARGET=x86_64-win64-gcc ;;
    esac
    (
        cd "$WORK/libvpx"
        # libvpx adds its own -arch; the cross build's exported flags would
        # say it twice.
        unset CFLAGS LDFLAGS
        ./configure --prefix="$PREFIX" --target="$VPX_TARGET" \
            --enable-static --disable-shared --enable-pic \
            --disable-examples --disable-tools --disable-docs --disable-unit-tests \
            --disable-vp8-decoder --disable-vp9-decoder \
            --enable-vp8-encoder --enable-vp9-encoder
        make -j"$JOBS"
        make install
    )
fi
# Static, so what they link against (libm, pthreads) has to come along, and
# ffmpeg asks pkg-config for --static only on Windows. Fold Libs.private into
# Libs; idempotent, as the line is gone after.
for pc in opus vpx; do
    perl -0pi -e 'if (/^Libs\.private:(.*)$/m) { my $p = $1; s/^Libs\.private:.*\n//m; s/^(Libs:.*)$/$1$p/m }' \
        "$PREFIX/lib/pkgconfig/$pc.pc"
done

case "$OS" in
    linux|windows)
        # ---- NVENC headers (MIT) ----
        if [ ! -f "$PREFIX/include/ffnvcodec/nvEncodeAPI.h" ]; then
            echo ">> Installing nv-codec-headers $NVCODEC_TAG"
            checkout nv-codec-headers https://github.com/FFmpeg/nv-codec-headers.git "$NVCODEC_TAG"
            make -C "$WORK/nv-codec-headers" install PREFIX="$PREFIX"
        fi
        ;;
esac

if [ "$OS" = linux ]; then
    # ---- libdrm and libva (MIT), static ----
    if [ ! -f "$PREFIX/lib/libdrm.a" ] && [ ! -f "$PREFIX/lib64/libdrm.a" ]; then
        echo ">> Building $LIBDRM_TAG"
        checkout libdrm https://gitlab.freedesktop.org/mesa/drm.git "$LIBDRM_TAG"
        meson setup "$WORK/libdrm/build" "$WORK/libdrm" --prefix="$PREFIX" --libdir=lib \
            --default-library=static --buildtype=release -Db_staticpic=true \
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
        # libva only builds shared libraries. Archive its (position-
        # independent) objects into static ones and drop the .so files so
        # ffmpeg links those.
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
            -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
            -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF \
            -DINSTALL_EXAMPLES=OFF -DBUILD_TOOLS=OFF
        cmake --build "$WORK/libvpl/build" -j"$JOBS"
        cmake --install "$WORK/libvpl/build"
    fi
    # These are static, so what they link against has to come along, and
    # their .pc files don't all say: libva-drm needs libdrm, libva dlopens
    # its driver, libvpl is C++.
    add_libs() { sed -i "s|^Libs:\(.*\)|Libs:\1 $2|" "$PREFIX/lib/pkgconfig/$1.pc"; }
    grep -q -- '-ldrm' "$PREFIX/lib/pkgconfig/libva-drm.pc" || add_libs libva-drm "-ldrm"
    grep -q -- '-ldl' "$PREFIX/lib/pkgconfig/libva.pc" || add_libs libva "-ldl -lpthread"
    grep -q -- '-lstdc++' "$PREFIX/lib/pkgconfig/vpl.pc" || add_libs vpl "-lstdc++"
fi

# ---- ffmpeg, shared ----
if [ ! -x "$PREFIX/bin/ffmpeg$EXT" ]; then
    echo ">> Building ffmpeg $FFMPEG_TAG"
    SRC="$WORK/ffmpeg"
    checkout ffmpeg "$FFMPEG_REPO" "$FFMPEG_TAG"
    (
        cd "$SRC"
        ./configure \
            --prefix="$PREFIX" \
            ${CROSS[@]+"${CROSS[@]}"} \
            ${PKG_CONFIG_FLAGS[@]+"${PKG_CONFIG_FLAGS[@]}"} \
            --extra-cflags="$EXTRA_CFLAGS" \
            --extra-ldflags="$EXTRA_LDFLAGS" \
            --enable-gpl \
            --disable-nonfree \
            --enable-version3 \
            --disable-static \
            --enable-shared \
            --disable-doc \
            --disable-ffplay \
            --disable-debug \
            --enable-libmp3lame \
            --enable-libx264 \
            --enable-libopus \
            --enable-libvpx \
            --enable-libdav1d \
            --disable-encoders \
            --enable-encoder=png,mjpeg,rawvideo,wrapped_avframe,pcm_s16le,flac,aac,libx264,libmp3lame,libopus,libvpx_vp8,libvpx_vp9${HW_ENCODERS:+,$HW_ENCODERS} \
            --disable-muxers \
            --enable-muxer=image2,image2pipe,rawvideo,segment,wav,flac,mp3,adts,mp4,mov,webm,matroska,avi,null \
            --disable-protocols \
            --enable-protocol=file,pipe,rtp,tcp,udp,http,https,tls,httpproxy \
            --disable-indevs \
            --enable-indev=lavfi \
            --disable-outdevs \
            "${PLATFORM[@]}"

        # Nothing nonfree may ship: refuse a build that has it.
        if ! grep -q '^#define CONFIG_NONFREE 0' config.h; then
            echo "ERROR: configure produced a nonfree build"
            exit 1
        fi

        make -j"$JOBS"
        make install
    )
fi

# ---- libxml2 (MIT) for MLT's xml module, static, position-independent ----
if [ ! -f "$PREFIX/lib/libxml2.a" ]; then
    echo ">> Building libxml2 $LIBXML2_VERSION"
    fetch "$LIBXML2_URL" "$LIBXML2_SHA256" "libxml2-$LIBXML2_VERSION"
    cmake -S "$WORK/libxml2-$LIBXML2_VERSION" -B "$WORK/libxml2-build" -G Ninja \
        -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_INSTALL_LIBDIR=lib \
        ${CMAKE_EXTRA[@]+"${CMAKE_EXTRA[@]}"} \
        -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBUILD_SHARED_LIBS=OFF \
        -DLIBXML2_WITH_ICONV=OFF -DLIBXML2_WITH_ICU=OFF -DLIBXML2_WITH_LZMA=OFF \
        -DLIBXML2_WITH_ZLIB=OFF -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_HTTP=OFF \
        -DLIBXML2_WITH_FTP=OFF -DLIBXML2_WITH_PROGRAMS=OFF -DLIBXML2_WITH_TESTS=OFF \
        -DLIBXML2_WITH_MODULES=OFF
    cmake --build "$WORK/libxml2-build" -j"$JOBS"
    cmake --install "$WORK/libxml2-build"
fi

# ---- Qt 6: qtbase and qtsvg, the least MLT's qt6 module links ----
# No ICU (its data alone is 30 MB), D-Bus, OpenGL, SQL or window-system
# integration: MLT draws with QPainter into images on the offscreen platform,
# which needs FreeType (Qt's own copy on macOS and Windows).
# Qt's own copies of zlib, libpng, libjpeg, PCRE2, HarfBuzz and
# double-conversion are used, so nothing else comes along.
if [ ! -f "$PREFIX/lib/cmake/Qt6Svg/Qt6SvgConfig.cmake" ]; then
    echo ">> Building Qt $QT_VERSION"
    fetch "$QT_URL/qtbase-everywhere-src-$QT_VERSION.tar.xz" "$QTBASE_SHA256" "qtbase-everywhere-src-$QT_VERSION"
    fetch "$QT_URL/qtsvg-everywhere-src-$QT_VERSION.tar.xz" "$QTSVG_SHA256" "qtsvg-everywhere-src-$QT_VERSION"
    # The x86_64 macOS cross build exports -arch flags for the autotools
    # builds above; Qt sets its own architectures and must not see them.
    (
    unset CFLAGS CXXFLAGS LDFLAGS
    cmake -S "$WORK/qtbase-everywhere-src-$QT_VERSION" -B "$WORK/qtbase-build" -G Ninja \
        -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
        ${CMAKE_EXTRA[@]+"${CMAKE_EXTRA[@]}"} \
        -DBUILD_SHARED_LIBS=ON -DQT_BUILD_EXAMPLES=OFF -DQT_BUILD_TESTS=OFF \
        -DQT_BUILD_BENCHMARKS=OFF -DQT_BUILD_MANUAL_TESTS=OFF \
        -DFEATURE_icu=OFF -DFEATURE_dbus=OFF -DFEATURE_glib=OFF \
        -DINPUT_opengl=no -DFEATURE_opengl=OFF -DFEATURE_vulkan=OFF -DFEATURE_egl=OFF \
        -DFEATURE_xcb=OFF -DFEATURE_xlib=OFF -DFEATURE_xkbcommon=OFF \
        -DFEATURE_wayland=OFF -DFEATURE_libudev=OFF -DFEATURE_evdev=OFF \
        -DFEATURE_libinput=OFF -DFEATURE_mtdev=OFF -DFEATURE_tslib=OFF \
        -DFEATURE_eglfs=OFF -DFEATURE_linuxfb=OFF -DFEATURE_vnc=OFF -DFEATURE_kms=OFF \
        -DFEATURE_gtk3=OFF -DFEATURE_sql=OFF -DFEATURE_testlib=OFF \
        -DFEATURE_printsupport=OFF -DFEATURE_sessionmanager=OFF \
        -DFEATURE_openssl=OFF -DFEATURE_zstd=OFF -DFEATURE_brotli=OFF \
        -DFEATURE_libproxy=OFF -DFEATURE_gssapi=OFF -DFEATURE_libresolv=OFF \
        -DFEATURE_system_zlib=OFF -DFEATURE_system_png=OFF -DFEATURE_system_jpeg=OFF \
        -DFEATURE_system_pcre2=OFF -DFEATURE_system_harfbuzz=OFF \
        -DFEATURE_system_doubleconversion=OFF -DFEATURE_system_libb2=OFF \
        -DFEATURE_backtrace=OFF -DFEATURE_freetype=ON \
        ${QT_PLATFORM[@]+"${QT_PLATFORM[@]}"} \
        ${QT_ARCHS[@]+"${QT_ARCHS[@]}"}
    cmake --build "$WORK/qtbase-build" -j"$JOBS"
    cmake --install "$WORK/qtbase-build"
    "$PREFIX/bin/qt-configure-module" "$WORK/qtsvg-everywhere-src-$QT_VERSION" \
        -- -B "$WORK/qtsvg-build" 2>/dev/null \
        || cmake -S "$WORK/qtsvg-everywhere-src-$QT_VERSION" -B "$WORK/qtsvg-build" -G Ninja \
            -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
            -DCMAKE_PREFIX_PATH="$PREFIX" ${CMAKE_EXTRA[@]+"${CMAKE_EXTRA[@]}"} \
            ${QT_ARCHS[@]+"${QT_ARCHS[@]}"} \
            -DQT_BUILD_EXAMPLES=OFF -DQT_BUILD_TESTS=OFF
    cmake --build "$WORK/qtsvg-build" -j"$JOBS"
    cmake --install "$WORK/qtsvg-build"
    )
fi

# ---- MLT ----
MLT_MODULES=(avformat kdenlive normalize plus plusgpl qt6 xml)
MLT_OFF=(decklink frei0r gdk glaxnimate_qt6 jackrack movit ndi oldfilm opencv openfx
    resample rtaudio rubberband rnnoise sdl1 sdl2 sox spatialaudio vidstab vorbis xine)
if [ ! -f "$WORK/mlt-build/.installed" ]; then
    echo ">> Building MLT $MLT_VERSION"
    fetch "$MLT_URL" "$MLT_SHA256" "mlt-$MLT_VERSION"
    # Our Qt has no OpenGL and no X11, which the qt6 module needs only for its
    # qglsl consumer (a GPU preview nobody renders through) and an unused
    # <X11/Xlib.h>. Drop both; idempotent, so a reused build dir is fine.
    QT_MOD="$WORK/mlt-$MLT_VERSION/src/modules/qt"
    sed -i.orig -e '/^ *consumer_qglsl\.cpp$/d' "$QT_MOD/CMakeLists.txt"
    sed -i.orig -e '/"qglsl"/d' "$QT_MOD/factory.c"
    sed -i.orig -e '/#include <X11\/Xlib.h>/d' "$QT_MOD/common.cpp"
    # On Windows (and in relocatable builds) MLT reads its modules only from
    # beside the executable; let MLT_REPOSITORY point elsewhere, as it does on
    # Linux, so the app's media/mlt folder is used.
    FACTORY="$WORK/mlt-$MLT_VERSION/src/framework/mlt_factory.c"
    if [ "$(grep -c 'getenv("MLT_REPOSITORY")' "$FACTORY")" = 1 ]; then
        perl -0pi -e 's/(#else\n        if \(directory\) \{)/#else\n        if ((directory == NULL || !strcmp(directory, "")) \&\& getenv("MLT_REPOSITORY"))\n            directory = getenv("MLT_REPOSITORY");\n        if (directory) {/' "$FACTORY"
        grep -c 'getenv("MLT_REPOSITORY")' "$FACTORY" | grep -q 3 || { echo "ERROR: the MLT_REPOSITORY patch did not apply"; exit 1; }
    fi
    MOD_FLAGS=()
    for m in "${MLT_MODULES[@]}"; do MOD_FLAGS+=("-DMOD_$(echo "$m" | tr '[:lower:]' '[:upper:]')=ON"); done
    for m in "${MLT_OFF[@]}"; do MOD_FLAGS+=("-DMOD_$(echo "$m" | tr '[:lower:]' '[:upper:]')=OFF"); done
    MLT_CFLAGS=""
    # melt opens an SDL preview window on macOS and Windows unless told not
    # to; it only ever renders here, and we build no SDL.
    [ "$OS" != linux ] && MLT_CFLAGS="-DMELT_NOSDL"
    # libxml2 is static: its headers must not ask for dllimport.
    [ "$OS" = windows ] && MLT_CFLAGS="$MLT_CFLAGS -DLIBXML_STATIC"
    cmake -S "$WORK/mlt-$MLT_VERSION" -B "$WORK/mlt-build" -G Ninja \
        -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
        -DCMAKE_PREFIX_PATH="$PREFIX" ${CMAKE_EXTRA[@]+"${CMAKE_EXTRA[@]}"} \
        -DCMAKE_C_FLAGS="$MLT_CFLAGS" -DCMAKE_CXX_FLAGS="$MLT_CFLAGS" \
        -DGPL=ON -DGPL3=ON -DBUILD_TESTING=OFF -DBUILD_DOCS=OFF -DCLANG_FORMAT=OFF \
        -DUSE_AVDEVICE=OFF -DUSE_LV2=OFF -DUSE_VST2=OFF -DRELOCATABLE=OFF \
        "${MOD_FLAGS[@]}"
    cmake --build "$WORK/mlt-build" -j"$JOBS"
    cmake --install "$WORK/mlt-build"
    touch "$WORK/mlt-build/.installed"
fi

# ---- Collect the bundle ----
STAGE="$WORK/stage"
rm -rf "$STAGE"
MEDIA="$STAGE/media"
mkdir -p "$MEDIA/lib" "$MEDIA/mlt" "$MEDIA/mlt-data" \
    "$MEDIA/qt-plugins/platforms" "$MEDIA/qt-plugins/imageformats" "$MEDIA/LICENSES"

# Where MLT and Qt install their pieces differ by platform.
if [ "$OS" = windows ]; then
    MLT_BIN="$PREFIX/melt.exe"
    [ -f "$MLT_BIN" ] || MLT_BIN="$PREFIX/bin/melt.exe"
    MLT_MOD_DIR="$PREFIX/lib/mlt"
    MLT_DATA_DIR="$PREFIX/share/mlt"
else
    MLT_BIN="$PREFIX/bin/melt-7"
    [ -f "$MLT_BIN" ] || MLT_BIN="$PREFIX/bin/melt"
    MLT_MOD_DIR="$PREFIX/lib/mlt-7"
    MLT_DATA_DIR="$PREFIX/share/mlt-7"
fi
[ -d "$MLT_MOD_DIR" ] || MLT_MOD_DIR="$(dirname "$(find "$PREFIX" -name 'libmltcore*' | head -1)")"
[ -d "$MLT_DATA_DIR" ] || MLT_DATA_DIR="$(dirname "$(find "$PREFIX/share" -maxdepth 2 -name profiles -type d | head -1)")"

cp "$PREFIX/bin/ffmpeg$EXT" "$STAGE/haruspex-ffmpeg-$TARGET$EXT"
cp "$PREFIX/bin/ffprobe$EXT" "$STAGE/haruspex-ffprobe-$TARGET$EXT"
cp "$MLT_BIN" "$STAGE/haruspex-melt-$TARGET$EXT"
cp "$MLT_MOD_DIR"/*mlt* "$MEDIA/mlt/"
# Only the modules we built: no .a or .dll.a import libraries.
rm -f "$MEDIA/mlt/"*.a
cp -R "$MLT_DATA_DIR"/. "$MEDIA/mlt-data/"
QT_PLUGINS="$PREFIX/plugins"
case "$OS" in
    linux) PLUG_EXT=so; PLUG_PRE=lib ;;
    macos) PLUG_EXT=dylib; PLUG_PRE=lib ;;
    windows) PLUG_EXT=dll; PLUG_PRE="" ;;
esac
cp "$QT_PLUGINS/platforms/${PLUG_PRE}qoffscreen.$PLUG_EXT" "$MEDIA/qt-plugins/platforms/"
for p in qjpeg qgif qico qsvg; do
    f="$QT_PLUGINS/imageformats/${PLUG_PRE}$p.$PLUG_EXT"
    [ -f "$f" ] && cp "$f" "$MEDIA/qt-plugins/imageformats/"
done

# Every file that is code, so the dependency walk and the rpaths can visit it.
code_files() {
    find "$STAGE" -type f \( -name "haruspex-*" -o -name "*.so*" -o -name "*.dylib" -o -name "*.dll" \)
}

# Copy into media/lib every library these files need that we built (it lives
# under $PREFIX, or MinGW's own folder on Windows), until nothing new turns up.
case "$OS" in
    linux)
        deps_of() { LD_LIBRARY_PATH="$PREFIX/lib" ldd "$1" 2>/dev/null | awk '/=> \// {print $1" "$3}'; }
        ;;
    macos)
        deps_of() { otool -L "$1" | tail -n +2 | awk '{print $1}' | while read -r d; do
            n="$(basename "$d")"
            [ -f "$PREFIX/lib/$n" ] && echo "$n $PREFIX/lib/$n"
        done; }
        ;;
    windows)
        # MSYS's ldd prints Windows-mapped paths (/d/a/...) that don't match
        # $PREFIX, so look each DLL up by name where we built it, or in
        # MinGW's folder; system DLLs are found in neither and stay out.
        deps_of() {
            PATH="$PREFIX:$PREFIX/bin:$PATH" ldd "$1" 2>/dev/null | awk '/=>/ {print $1}' |
                while read -r n; do
                    for d in "$PREFIX" "$PREFIX/bin" "$PREFIX/lib" /mingw64/bin; do
                        if [ -f "$d/$n" ]; then
                            echo "$n $d/$n"
                            break
                        fi
                    done
                done
        }
        ;;
esac
while :; do
    added=0
    while read -r f; do
        while read -r name path; do
            [ -z "$name" ] && continue
            case "$path" in
                "$PREFIX"/*|/mingw64/*) ;;
                *) continue ;;
            esac
            if [ ! -e "$MEDIA/lib/$name" ]; then
                cp -L "$path" "$MEDIA/lib/$name"
                added=1
            fi
        done < <(deps_of "$f")
    done < <(code_files)
    [ "$added" = 0 ] && break
done
if [ "$OS" = windows ]; then
    # Windows binaries look beside themselves first; the app's PATH covers the
    # rest. MLT's and ffmpeg's own DLLs are in bin/, which the walk above
    # copied. Anything still unresolved is a missing build piece.
    :
fi
for f in $(code_files); do
    if [ "$OS" = linux ] && LD_LIBRARY_PATH="$MEDIA/lib" ldd "$f" | grep -q 'not found'; then
        echo "ERROR: $f has unresolved libraries:"
        LD_LIBRARY_PATH="$MEDIA/lib" ldd "$f" | grep 'not found'
        exit 1
    fi
done

# Rpaths: binaries look in media/lib beside them (dev: src-tauri/binaries/)
# and in the installed resources (deb/rpm/AppImage: /usr/bin next to
# /usr/lib/Haruspex; .app: Contents/MacOS next to Contents/Resources).
# shellcheck disable=SC2016 # $ORIGIN is for the dynamic linker, not the shell
case "$OS" in
    linux)
        for f in "$STAGE"/haruspex-*; do
            patchelf --set-rpath '$ORIGIN/media/lib:$ORIGIN/../lib/Haruspex/binaries/media/lib' "$f"
        done
        for f in "$MEDIA"/lib/*.so*; do patchelf --set-rpath '$ORIGIN' "$f"; done
        for f in "$MEDIA"/mlt/*.so; do patchelf --set-rpath '$ORIGIN/../lib' "$f"; done
        for f in "$MEDIA"/qt-plugins/*/*.so; do patchelf --set-rpath '$ORIGIN/../../lib' "$f"; done
        for f in $(code_files); do strip --strip-unneeded "$f"; done
        ;;
    macos)
        relink() {
            local f="$1"
            otool -L "$f" | tail -n +2 | awk '{print $1}' | while read -r d; do
                n="$(basename "$d")"
                if [ -f "$MEDIA/lib/$n" ] && [ "$d" != "@rpath/$n" ]; then
                    install_name_tool -change "$d" "@rpath/$n" "$f"
                fi
            done
            # Drop the build prefix's rpaths, then add ours.
            otool -l "$f" | awk '/LC_RPATH/{getline; getline; print $2}' | while read -r rp; do
                install_name_tool -delete_rpath "$rp" "$f" 2>/dev/null || true
            done
            shift
            for rp in "$@"; do install_name_tool -add_rpath "$rp" "$f"; done
        }
        for f in "$MEDIA"/lib/*.dylib; do
            install_name_tool -id "@rpath/$(basename "$f")" "$f"
            relink "$f" "@loader_path"
        done
        for f in "$STAGE"/haruspex-*; do
            relink "$f" "@executable_path/media/lib" "@executable_path/../Resources/binaries/media/lib"
        done
        for f in "$MEDIA"/mlt/*; do relink "$f" "@loader_path/../lib"; done
        for f in "$MEDIA"/qt-plugins/*/*; do relink "$f" "@loader_path/../../lib"; done
        # Universal Qt in an x86_64 bundle: keep the x86_64 half.
        for f in $(code_files); do
            if lipo -info "$f" 2>/dev/null | grep -q 'are:'; then
                lipo -thin "${MAC_ARCH}" "$f" -output "$f.thin" && mv "$f.thin" "$f"
            fi
        done
        for f in $(code_files); do strip -x "$f" 2>/dev/null || true; done
        # The app is ad-hoc signed; arm64 won't load an unsigned dylib, and
        # every edit above voided the linker's signature.
        for f in $(code_files); do codesign --force -s - "$f"; done
        ;;
    windows)
        for f in $(code_files); do strip --strip-unneeded "$f" 2>/dev/null || true; done
        ;;
esac

# ---- Licences ----
cp "$WORK/ffmpeg/COPYING.GPLv3" "$MEDIA/LICENSES/ffmpeg-COPYING.GPLv3"
cp "$WORK/x264/COPYING" "$MEDIA/LICENSES/x264-COPYING"
cp "$WORK/ffmpeg/LICENSE.md" "$MEDIA/LICENSES/ffmpeg-LICENSE.md"
cp "$WORK/lame-$LAME_VERSION/COPYING" "$MEDIA/LICENSES/lame-COPYING"
cp "$WORK/libxml2-$LIBXML2_VERSION/Copyright" "$MEDIA/LICENSES/libxml2-Copyright"
cp "$WORK/opus-$OPUS_VERSION/COPYING" "$MEDIA/LICENSES/opus-COPYING"
cp "$WORK/dav1d/COPYING" "$MEDIA/LICENSES/dav1d-COPYING"
cp "$WORK/libvpx/LICENSE" "$MEDIA/LICENSES/libvpx-LICENSE"
cp "$WORK/libvpx/PATENTS" "$MEDIA/LICENSES/libvpx-PATENTS"
for f in "$WORK/mlt-$MLT_VERSION"/COPYING*; do cp "$f" "$MEDIA/LICENSES/mlt-$(basename "$f")"; done
mkdir -p "$MEDIA/LICENSES/qt"
cp "$WORK/qtbase-everywhere-src-$QT_VERSION/LICENSES/"* "$MEDIA/LICENSES/qt/"
if [ "$OS" = linux ]; then
    cp "$WORK/libva/COPYING" "$MEDIA/LICENSES/libva-COPYING"
    cp "$WORK/libvpl/LICENSE" "$MEDIA/LICENSES/libvpl-LICENSE"
fi
cat > "$MEDIA/LICENSES/README" <<EOF
Haruspex media bundle $MEDIA_TAG for $TARGET.
ffmpeg $FFMPEG_TAG (GPL-3.0-or-later build, with x264; nothing nonfree)
x264 $X264_COMMIT (GPL-2.0-or-later)
MLT $MLT_VERSION (LGPL-2.1-or-later; the qt6, plusgpl and normalize modules are GPL)
Qt $QT_VERSION qtbase and qtsvg (LGPL-3.0)
libxml2 $LIBXML2_VERSION (MIT), lame $LAME_VERSION (LGPL-2.0-or-later)
dav1d $DAV1D_TAG (BSD-2-Clause), opus $OPUS_VERSION (BSD-3-Clause)
libvpx $LIBVPX_TAG (BSD-3-Clause, with Google's VP8/VP9 patent grant)
Sources: https://github.com/FFmpeg/FFmpeg/tree/$FFMPEG_TAG
         https://github.com/mltframework/mlt/tree/v$MLT_VERSION
         $QT_URL
EOF

ARCHIVE="$OUT_DIR/media-$TARGET.tar.xz"
rm -f "$ARCHIVE"
tar -C "$STAGE" -cJf "$ARCHIVE" .
echo "   Built: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
