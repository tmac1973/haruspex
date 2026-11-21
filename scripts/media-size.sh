#!/bin/bash
# Prints, as Markdown, how much a media bundle adds to the installer over the
# static ffmpeg pair it replaces, and fails when that is over 45 MB.
#
# Usage: ./scripts/media-size.sh <media-<triple>.tar.xz> <triple>
set -euo pipefail
ARCHIVE="$1"
TARGET="$2"
LIMIT_MB=45
EXT=""
case "$TARGET" in *windows*) EXT=".exe" ;; esac
OLD="https://github.com/tmac1973/haruspex/releases/download/ffmpeg-n8.1.3"
DIR="$(mktemp -d)"
for t in ffmpeg ffprobe; do
    curl -fsSL -o "$DIR/haruspex-$t-$TARGET$EXT" "$OLD/haruspex-$t-$TARGET$EXT"
done
tar -C "$DIR" -cJf "$DIR/old.tar.xz" "haruspex-ffmpeg-$TARGET$EXT" "haruspex-ffprobe-$TARGET$EXT"
size() { wc -c < "$1" | tr -d ' '; }
new=$(size "$ARCHIVE")
old=$(size "$DIR/old.tar.xz")
added=$(( (new - old) / 1048576 ))
echo "### $TARGET"
echo "Bundle $((new / 1048576)) MB compressed; the static ffmpeg pair was $((old / 1048576)) MB; adds $added MB (limit $LIMIT_MB MB)."
if [ "$added" -gt "$LIMIT_MB" ]; then
    echo "::error::the media bundle adds $added MB, over the $LIMIT_MB MB limit" >&2
    exit 1
fi
