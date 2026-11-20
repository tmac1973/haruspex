#!/bin/bash
# Unpacks a media bundle and checks it works: the services Kdenlive and
# Shotcut projects use load, and a two-track qtblend project renders to an
# H.264 MP4 with both tracks in it.
#
# Usage: ./scripts/media-smoke.sh <media-<triple>.tar.xz> <triple>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ARCHIVE="$1"
TARGET="$2"
EXT=""
case "$TARGET" in *windows*) EXT=".exe" ;; esac
DIR="$(mktemp -d)"
tar -xJf "$ARCHIVE" -C "$DIR"
# shellcheck source=media-env.sh
. "$SCRIPT_DIR/media-env.sh" "$DIR"
MELT="$DIR/haruspex-melt-$TARGET$EXT"
FFMPEG="$DIR/haruspex-ffmpeg-$TARGET$EXT"

"$MELT" -version
"$FFMPEG" -hide_banner -buildconf | head -5

fail=0
# Captured first: grep -q stopping early would SIGPIPE melt under pipefail.
declare -A LISTED
for k in transitions filters producers consumers; do
    LISTED[$k]="$("$MELT" -query "$k" 2>&1 || true)"
done
for kind in transition:qtblend transition:luma transition:mix filter:volume \
    filter:avfilter.alimiter filter:panner filter:audiolevel filter:brightness \
    producer:avformat-novalidate producer:color producer:kdenlivetitle consumer:avformat; do
    service="${kind#*:}"
    if ! grep -q -- "- $service\$" <<<"${LISTED[${kind%%:*}s]}"; then
        echo "::error::melt has no ${kind%%:*} $service"
        fail=1
    fi
done
[ "$fail" = 0 ] || exit 1

OUT="$DIR/smoke.mp4"
"$MELT" "$SCRIPT_DIR/fixtures/qtblend-smoke.mlt" -consumer "avformat:$OUT" \
    vcodec=libx264 acodec=aac 2>&1 | tail -5
[ -s "$OUT" ] || { echo "::error::melt wrote no smoke.mp4"; exit 1; }

# A pixel from a quarter, as R G B. A 2×2 crop (4:2:0 can't crop to one
# pixel), of which the first pixel is kept.
pixel() {
    "$FFMPEG" -v error -ss 1 -i "$OUT" -vf "crop=2:2:$1:$2" -frames:v 1 \
        -f rawvideo -pix_fmt rgb24 - | od -An -tu1 -N3 | tr -s ' '
}
TOP_LEFT="$(pixel 40 30)"
BOTTOM_RIGHT="$(pixel 280 200)"
echo "top-left:$TOP_LEFT bottom-right:$BOTTOM_RIGHT"
read -r _ _ b1 <<<"$TOP_LEFT"
read -r r2 _ b2 <<<"$BOTTOM_RIGHT"
if [ "$b1" -lt 60 ] || [ "$r2" -lt 180 ] || [ "$b2" -gt 60 ]; then
    echo "::error::qtblend did not composite the two tracks"
    exit 1
fi
echo "Smoke test passed: $(du -h "$OUT" | cut -f1) MP4, both tracks composited."
