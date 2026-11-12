#!/bin/bash
# Downloads our LGPL ffmpeg and ffprobe into src-tauri/binaries/ as
# haruspex-ffmpeg-<triple>[.exe] and haruspex-ffprobe-<triple>[.exe].
#
# The video tools and the cameras run them, so a user never has to install
# ffmpeg. They are built by .github/workflows/build-ffmpeg.yml with
# scripts/build-ffmpeg.sh (LGPL only: no x264/x265) and published to this
# repo's release tagged ffmpeg-<tag>, with a SHA256SUMS file. Each binary is
# verified against SHA256SUMS; a mismatch is fatal, a missing sha256 tool or a
# failed download skips ffmpeg with a warning (the app then finds ffmpeg on
# PATH or in Kdenlive, as before).
#
# Idempotent — skips the download when the .version stamp names the pinned tag
# and both binaries are present.
#
# Usage: ./scripts/fetch-ffmpeg.sh [--target <triple>]
#   FFMPEG_RELEASE_URL overrides where the release is read from.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"

# The ffmpeg tag the release was built from. Bump it here and in
# build-ffmpeg.yml together, then run that workflow before a release.
FFMPEG_TAG="n8.1.3"
RELEASE_URL="${FFMPEG_RELEASE_URL:-https://github.com/tmac1973/haruspex/releases/download/ffmpeg-$FFMPEG_TAG}"

TARGET_TRIPLE=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --target) TARGET_TRIPLE="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done
if [ -z "$TARGET_TRIPLE" ]; then
    TARGET_TRIPLE="$(rustc --print host-tuple)"
fi

case "$TARGET_TRIPLE" in
    x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu|x86_64-apple-darwin|aarch64-apple-darwin) EXT="" ;;
    x86_64-pc-windows-msvc) EXT=".exe" ;;
    *)
        echo ">> WARN: no bundled ffmpeg for $TARGET_TRIPLE — skipping"
        exit 0
        ;;
esac

FFMPEG_ASSET="haruspex-ffmpeg-$TARGET_TRIPLE$EXT"
FFPROBE_ASSET="haruspex-ffprobe-$TARGET_TRIPLE$EXT"
STAMP="$BINARIES_DIR/haruspex-ffmpeg-$TARGET_TRIPLE.version"

if [ -x "$BINARIES_DIR/$FFMPEG_ASSET" ] && [ -x "$BINARIES_DIR/$FFPROBE_ASSET" ] \
    && [ "$(cat "$STAMP" 2>/dev/null)" = "$FFMPEG_TAG" ]; then
    echo ">> ffmpeg already installed ($FFMPEG_TAG)."
    exit 0
fi

if command -v sha256sum >/dev/null 2>&1; then
    sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
    sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
    echo ">> WARN: no sha256sum or shasum available — skipping ffmpeg rather than installing it unverified"
    exit 0
fi

echo ">> Downloading ffmpeg $FFMPEG_TAG for $TARGET_TRIPLE..."
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if ! curl -fsSL -o "$TMP_DIR/SHA256SUMS" "$RELEASE_URL/SHA256SUMS"; then
    echo "   WARN: failed to download SHA256SUMS from $RELEASE_URL — skipping ffmpeg."
    echo "         The video tools fall back to an ffmpeg on PATH or in Kdenlive."
    exit 0
fi

for asset in "$FFMPEG_ASSET" "$FFPROBE_ASSET"; do
    if ! curl -fsSL -o "$TMP_DIR/$asset" "$RELEASE_URL/$asset"; then
        echo "   WARN: failed to download $asset — skipping ffmpeg."
        exit 0
    fi
    # SHA256SUMS lines are "<hash>  <name>" (or "<hash> *<name>").
    EXPECTED="$(awk -v n="$asset" '{ f = $2; sub(/^\*/, "", f) } f == n { print $1; exit }' "$TMP_DIR/SHA256SUMS")"
    if [ -z "$EXPECTED" ]; then
        echo "   ERROR: $asset is not listed in SHA256SUMS"
        exit 1
    fi
    ACTUAL="$(sha256_of "$TMP_DIR/$asset")"
    if [ "$ACTUAL" != "$EXPECTED" ]; then
        echo "   ERROR: checksum mismatch for $asset"
        echo "          expected $EXPECTED"
        echo "          got      $ACTUAL"
        exit 1
    fi
done

mkdir -p "$BINARIES_DIR"
for asset in "$FFMPEG_ASSET" "$FFPROBE_ASSET"; do
    # Replace rather than write through: a dev worktree's entries may be
    # symlinks to the main checkout's, or placeholder stubs.
    rm -f "$BINARIES_DIR/$asset"
    cp "$TMP_DIR/$asset" "$BINARIES_DIR/$asset"
    chmod +x "$BINARIES_DIR/$asset"
    echo "   Installed: $BINARIES_DIR/$asset"
done
rm -f "$STAMP"
echo "$FFMPEG_TAG" > "$STAMP"
