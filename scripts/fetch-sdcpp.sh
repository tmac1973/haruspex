#!/bin/bash
# Fetch the stable-diffusion.cpp server binary (sd-server) and its private
# shared libraries.
#
# DOWNLOADED on macOS and Windows, BUILT on Linux. Every release ships
# sd-server for Windows x64 (Vulkan) and macOS arm64 (Metal), and downloading
# one pins the exact bytes and saves a multi-minute Vulkan shader compile.
# The Linux asset is built on Ubuntu 26.04 since master-1126 and needs glibc
# 2.43 (`sqrtf@GLIBC_2.43` in ggml), newer than the ubuntu:25.10 the app is
# built in, so it would not start on Ubuntu 25.10, Fedora 43 or Debian 13.
# On Linux this builds the same tag with upstream's own release flags, which
# gives the same layout: the binary beside its libraries and ggml backends.
#
# This script produces files on disk and nothing else. It never downloads
# weights, never starts the server, and nothing in the app runs it.
#
# Usage: ./scripts/fetch-sdcpp.sh [--target <triple>]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"

# The pinned upstream release. An unpinned sidecar is a reproducibility hole:
# a fetch six months from now would land a different binary with different
# capabilities, and `capabilities.json` — which the local image backend
# declares from — would quietly stop describing what is on disk.
#
# Upstream publishes no semver tags; releases are named `master-<n>-<sha>`.
# Recorded in docs/image-generation.md too, and check-constants.mjs fails the
# build when the two disagree.
SDCPP_VERSION="master-1142-908965d"

TARGET=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --target) TARGET="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done
[ -z "$TARGET" ] && TARGET="$(rustc --print host-tuple)"

case "$TARGET" in
    *-windows-msvc) EXT=".exe" ;;
    *)              EXT=""     ;;
esac

# The asset is matched by PATTERN rather than by full name: upstream bakes the
# builder's OS version into the macOS asset ("…macOS-26.6.2-arm64.zip"), so a
# hardcoded name would break on the next release for a reason that has nothing
# to do with us.
case "$TARGET" in
    x86_64-unknown-linux-gnu)  ASSET_RE='' ;;  # built, see build_linux
    aarch64-apple-darwin)      ASSET_RE='bin-Darwin-.*arm64\.zip'        ;;
    x86_64-apple-darwin)       ASSET_RE='bin-Darwin-.*x86_64\.zip'       ;;
    x86_64-pc-windows-msvc)    ASSET_RE='bin-win-vulkan-x64\.zip'        ;;
    *)
        echo "WARN: no sd-server release asset for $TARGET — skipping."
        echo "      The local image backend will report itself unavailable."
        exit 0
        ;;
esac

SD_BIN="$BINARIES_DIR/haruspex-sd-server-${TARGET}${EXT}"
SD_STAMP="$BINARIES_DIR/haruspex-sd-server-${TARGET}.version"

# Its OWN directory, and this is not tidiness.
#
# The release ships its own ggml family — libggml-base.so, .so.0 and
# .so.0.19.0 — and `binaries/libs/` already holds llama.cpp's, whose
# unversioned and .so.0 names are IDENTICAL while the version behind them is
# not (0.22.0). Dropping these in beside them would overwrite the soname
# llama-server resolves at load time with an older ggml, and break the LLM
# sidecar in a way that looks nothing like an image-generation change.
# whisper.cpp survives sharing that directory only because its ggml files
# happen to carry distinct versioned names.
SD_LIBS="$BINARIES_DIR/sd-libs"

if [ -f "$SD_BIN" ] && [ -x "$SD_BIN" ] && [ "$(cat "$SD_STAMP" 2>/dev/null)" = "$SDCPP_VERSION" ]; then
    echo ">> sd-server already present ($SDCPP_VERSION), skipping."
    exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Build the pinned tag into $TMP/build/bin, as upstream's
# `ubuntu-latest-cmake-vulkan` job does: shared ggml with each backend and
# every CPU variant as a module that ggml picks at run time, and an $ORIGIN
# RUNPATH so the binary finds its libraries beside it.
build_linux() {
    command -v git   >/dev/null || { echo "ERROR: git is required";   exit 1; }
    command -v cmake >/dev/null || { echo "ERROR: cmake is required"; exit 1; }
    command -v glslc >/dev/null || {
        echo "ERROR: glslc is required to build sd-server's Vulkan backend."
        echo "       Install the Vulkan SDK, or your distro's glslc and Vulkan headers."
        exit 1
    }
    echo ">> Building sd-server (stable-diffusion.cpp $SDCPP_VERSION) for $TARGET..."
    # No fallback to the default branch: a typo'd tag must fail the build,
    # not ship master under the pinned version's stamp.
    if ! git clone --quiet --depth 1 --branch "$SDCPP_VERSION" \
        --recurse-submodules --shallow-submodules \
        https://github.com/leejet/stable-diffusion.cpp.git "$TMP/src"; then
        echo "ERROR: could not clone stable-diffusion.cpp at pinned tag '$SDCPP_VERSION'"
        exit 1
    fi
    cmake -S "$TMP/src" -B "$TMP/build" -DCMAKE_BUILD_TYPE=Release \
        -DSD_VULKAN=ON -DSD_BUILD_SHARED_LIBS=ON -DSD_BUILD_SHARED_GGML_LIB=ON \
        -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
        -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON -DCMAKE_INSTALL_RPATH='$ORIGIN'
    local nproc
    nproc=$(nproc 2>/dev/null || echo 4)
    cmake --build "$TMP/build" --config Release -j "$nproc"
    # A configure that lost Vulkan still builds, CPU only, and ships an engine
    # that is slow for no visible reason.
    if ! find "$TMP/build/bin" -name "libggml-vulkan.so*" | grep -q .; then
        echo "ERROR: the sd-server build produced no Vulkan backend."
        exit 1
    fi
}

if [ "$TARGET" = "x86_64-unknown-linux-gnu" ]; then
    build_linux
    SRC="$TMP/build/bin/sd-server"
else

command -v curl  >/dev/null || { echo "ERROR: curl is required";  exit 1; }
command -v unzip >/dev/null || { echo "ERROR: unzip is required"; exit 1; }

echo ">> Fetching sd-server (stable-diffusion.cpp $SDCPP_VERSION) for $TARGET..."

API="https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/tags/$SDCPP_VERSION"

# Authenticate when a token is there, and CHECK THE STATUS.
#
# api.github.com allows 60 unauthenticated requests per hour per IP, and CI
# runners share IPs, so a release build can get a 403 whose body is an error
# object with no asset URLs in it. Read with `curl -sSL` and piped into grep
# that looks exactly like "upstream renamed its assets" — which is what this
# used to report, sending you to check a pattern that was never wrong.
AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")

CODE=$(curl -sSL -o "$TMP/release.json" -w '%{http_code}' \
    -H "Accept: application/vnd.github+json" \
    "${AUTH[@]}" "$API")

if [ "$CODE" != "200" ]; then
    echo "ERROR: the GitHub API returned HTTP $CODE for"
    echo "       $API"
    if grep -qi "rate limit" "$TMP/release.json"; then
        echo "       Rate limited. Export GITHUB_TOKEN (any token raises the"
        echo "       limit to 5000/hour); CI passes secrets.GITHUB_TOKEN."
    fi
    exit 1
fi

# Matched on the asset URLs only. Deliberately not the two-step
# `grep -o '"browser_download_url": *"..."' | sed` this replaced: a quantified
# space in a BRE is the kind of thing GNU and BSD grep disagree about, and this
# script has to work on a macOS runner as well as a Linux one.
URL=$(grep -o 'https://[^"]*\.zip' "$TMP/release.json" \
    | grep -E "$ASSET_RE" \
    | head -1)

if [ -z "$URL" ]; then
    echo "ERROR: no asset matching /$ASSET_RE/ in release $SDCPP_VERSION."
    echo "       Upstream may have renamed its assets. It currently ships:"
    grep -o 'https://[^"]*\.zip' "$TMP/release.json" | sed 's#.*/#         #'
    exit 1
fi

echo "   $URL"
curl -sSL --fail -o "$TMP/sd.zip" "$URL"
unzip -q -o "$TMP/sd.zip" -d "$TMP/sd"

SRC=$(find "$TMP/sd" -name "sd-server${EXT}" -type f | head -1)
if [ -z "$SRC" ]; then
    echo "ERROR: the release asset contains no sd-server binary."
    exit 1
fi
fi

mkdir -p "$BINARIES_DIR" "$SD_LIBS"
# Replace rather than merge: a stale library from an older pin next to a new
# binary is the failure this whole pinning exercise exists to prevent.
rm -f "$SD_LIBS"/*
cp "$SRC" "$SD_BIN"
chmod +x "$SD_BIN"

# Everything but the binaries themselves. sd-cli is the one-shot command-line
# tool; we drive the server, and shipping a second entry point we never call
# is weight with no purpose.
SRC_DIR=$(dirname "$SRC")
# Links too, as plain files: a build names each library by its soname
# through symlinks, and the release zips held copies.
find "$SRC_DIR" -maxdepth 1 \( -type f -o -type l \) ! -name "sd-server${EXT}" ! -name "sd-cli${EXT}" \
    -exec cp -L {} "$SD_LIBS/" \;

echo "$SDCPP_VERSION" > "$SD_STAMP"
echo "   Done: $SD_BIN"
echo "   Libraries: $SD_LIBS ($(find "$SD_LIBS" -type f | wc -l) files, $(du -sh "$SD_LIBS" | cut -f1))"
