#!/bin/bash
# Downloads the media bundle into src-tauri/binaries/: haruspex-ffmpeg,
# haruspex-ffprobe and haruspex-melt for the target, and binaries/media/ (the
# libraries they share, MLT's modules and data, Qt's plugins, the licences).
#
# The video tools and the cameras run them, so a user never installs ffmpeg or
# a video editor to render. They are built by .github/workflows/build-media.yml
# with scripts/build-media.sh and published to this repo's media-<tag> release
# with a SHA256SUMS file; the tag is in scripts/media-versions.sh. The archive
# is verified against SHA256SUMS: a mismatch is fatal, a missing sha256 tool
# or a failed download skips the bundle with a warning (the app then finds
# ffmpeg and melt on PATH or in Shotcut or Kdenlive, as before).
#
# Idempotent — skips the download when the .version stamp names the pinned tag
# and the three binaries are present.
#
# Usage: ./scripts/fetch-media.sh [--target <triple>]
#   MEDIA_RELEASE_URL overrides where the release is read from (a file:// URL
#   works, for an archive built locally).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"
# shellcheck source=media-versions.sh
. "$SCRIPT_DIR/media-versions.sh"
RELEASE_URL="${MEDIA_RELEASE_URL:-https://github.com/tmac1973/haruspex/releases/download/media-$MEDIA_TAG}"

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
        echo ">> WARN: no media bundle for $TARGET_TRIPLE — skipping"
        exit 0
        ;;
esac

TOOLS=(ffmpeg ffprobe melt)
ASSET="media-$TARGET_TRIPLE.tar.xz"
STAMP="$BINARIES_DIR/media-$TARGET_TRIPLE.version"

have_all() {
    for t in "${TOOLS[@]}"; do
        [ -x "$BINARIES_DIR/haruspex-$t-$TARGET_TRIPLE$EXT" ] || return 1
    done
    [ -d "$BINARIES_DIR/media/mlt" ]
}
if have_all && [ "$(cat "$STAMP" 2>/dev/null)" = "$MEDIA_TAG" ]; then
    echo ">> Media bundle already installed ($MEDIA_TAG)."
    exit 0
fi

if command -v sha256sum >/dev/null 2>&1; then
    sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
    sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
    echo ">> WARN: no sha256sum or shasum available — skipping the media bundle rather than installing it unverified"
    exit 0
fi

echo ">> Downloading the media bundle $MEDIA_TAG for $TARGET_TRIPLE..."
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if ! curl -fsSL -o "$TMP_DIR/SHA256SUMS" "$RELEASE_URL/SHA256SUMS"; then
    echo "   WARN: failed to download SHA256SUMS from $RELEASE_URL — skipping the media bundle."
    echo "         The video tools fall back to ffmpeg and melt on PATH or in Shotcut or Kdenlive."
    exit 0
fi
if ! curl -fsSL -o "$TMP_DIR/$ASSET" "$RELEASE_URL/$ASSET"; then
    echo "   WARN: failed to download $ASSET — skipping the media bundle."
    exit 0
fi
# SHA256SUMS lines are "<hash>  <name>" (or "<hash> *<name>").
EXPECTED="$(awk -v n="$ASSET" '{ f = $2; sub(/^\*/, "", f) } f == n { print $1; exit }' "$TMP_DIR/SHA256SUMS")"
if [ -z "$EXPECTED" ]; then
    echo "   ERROR: $ASSET is not listed in SHA256SUMS"
    exit 1
fi
ACTUAL="$(sha256_of "$TMP_DIR/$ASSET")"
if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "   ERROR: checksum mismatch for $ASSET"
    echo "          expected $EXPECTED"
    echo "          got      $ACTUAL"
    exit 1
fi

# Unpack beside, then move into place, so an interrupted extract never leaves
# binaries/media/ half one version and half another.
mkdir -p "$TMP_DIR/unpacked" "$BINARIES_DIR"
tar -xJf "$TMP_DIR/$ASSET" -C "$TMP_DIR/unpacked"
for t in "${TOOLS[@]}"; do
    name="haruspex-$t-$TARGET_TRIPLE$EXT"
    if [ ! -f "$TMP_DIR/unpacked/$name" ]; then
        echo "   ERROR: $ASSET has no $name"
        exit 1
    fi
done
rm -rf "$BINARIES_DIR/media.new"
mv "$TMP_DIR/unpacked/media" "$BINARIES_DIR/media.new"
rm -rf "${BINARIES_DIR:?}/media"
mv "$BINARIES_DIR/media.new" "$BINARIES_DIR/media"
for t in "${TOOLS[@]}"; do
    name="haruspex-$t-$TARGET_TRIPLE$EXT"
    # Replace rather than write through: a dev worktree's entries may be
    # symlinks to the main checkout's, or placeholder stubs.
    rm -f "$BINARIES_DIR/$name"
    mv "$TMP_DIR/unpacked/$name" "$BINARIES_DIR/$name"
    chmod +x "$BINARIES_DIR/$name"
    echo "   Installed: $BINARIES_DIR/$name"
done
rm -f "$BINARIES_DIR/haruspex-ffmpeg-$TARGET_TRIPLE.version"
echo "$MEDIA_TAG" > "$STAMP"
echo "   Installed: $BINARIES_DIR/media/ ($(du -sh "$BINARIES_DIR/media" | cut -f1))"
