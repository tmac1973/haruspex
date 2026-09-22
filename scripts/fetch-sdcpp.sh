#!/bin/bash
# Fetch the stable-diffusion.cpp server binary (sd-server) and its private
# shared libraries.
#
# DOWNLOADED, not built from source — a deliberate departure from the original
# plan for this phase, which assumed upstream published no Vulkan server binary
# for our triples. It does: every release ships sd-server for Linux x86_64
# (Vulkan), Windows x64 (Vulkan) and macOS arm64 (Metal). Downloading a release
# asset pins the exact bytes, matches how pdfium/ruff/uv/node are already
# fetched, and saves every developer and every CI run a multi-minute Vulkan
# shader compile. llama-server and whisper-server are built locally for
# historical reasons that do not apply here.
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
SDCPP_VERSION="master-890-74988b2"

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
    x86_64-unknown-linux-gnu)  ASSET_RE='bin-Linux-.*x86_64-vulkan\.zip' ;;
    aarch64-apple-darwin)      ASSET_RE='bin-Darwin-.*arm64\.zip'        ;;
    x86_64-apple-darwin)       ASSET_RE='bin-Darwin-.*x86_64\.zip'       ;;
    x86_64-pc-windows-msvc)    ASSET_RE='bin-win-vulkan-x64\.zip'        ;;
    *)
        echo "WARN: no sd-server release asset for $TARGET — skipping."
        echo "      The local image backend will report itself unavailable."
        exit 0
        ;;
esac

SD_BIN="$BINARIES_DIR/sd-server-${TARGET}${EXT}"
SD_STAMP="$BINARIES_DIR/sd-server-${TARGET}.version"

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

command -v curl  >/dev/null || { echo "ERROR: curl is required";  exit 1; }
command -v unzip >/dev/null || { echo "ERROR: unzip is required"; exit 1; }

echo ">> Fetching sd-server (stable-diffusion.cpp $SDCPP_VERSION) for $TARGET..."

API="https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/tags/$SDCPP_VERSION"
URL=$(curl -sSL "$API" \
    | grep -o '"browser_download_url": *"[^"]*"' \
    | sed 's/.*"browser_download_url": *"\([^"]*\)".*/\1/' \
    | grep -E "$ASSET_RE" \
    | head -1)

if [ -z "$URL" ]; then
    echo "ERROR: no asset matching /$ASSET_RE/ in release $SDCPP_VERSION."
    echo "       Upstream may have renamed its assets; check the pattern above."
    exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "   $URL"
curl -sSL --fail -o "$TMP/sd.zip" "$URL"
unzip -q -o "$TMP/sd.zip" -d "$TMP/sd"

SRC=$(find "$TMP/sd" -name "sd-server${EXT}" -type f | head -1)
if [ -z "$SRC" ]; then
    echo "ERROR: the release asset contains no sd-server binary."
    exit 1
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
find "$SRC_DIR" -maxdepth 1 -type f ! -name "sd-server${EXT}" ! -name "sd-cli${EXT}" \
    -exec cp -P {} "$SD_LIBS/" \;

echo "$SDCPP_VERSION" > "$SD_STAMP"
echo "   Done: $SD_BIN"
echo "   Libraries: $SD_LIBS ($(find "$SD_LIBS" -type f | wc -l) files, $(du -sh "$SD_LIBS" | cut -f1))"
