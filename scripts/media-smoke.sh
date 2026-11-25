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
# The codecs and formats the video tools rely on: dav1d for AV1 (ComfyUI's
# clips), WebM with VP8/VP9 and Opus (video_mux_audio writes WebM with Opus),
# and MJPEG AVI with PCM (what the video upscalers read).
DECODERS="$("$FFMPEG" -hide_banner -decoders 2>&1 || true)"
ENCODERS="$("$FFMPEG" -hide_banner -encoders 2>&1 || true)"
MUXERS="$("$FFMPEG" -hide_banner -muxers 2>&1 || true)"
DEMUXERS="$("$FFMPEG" -hide_banner -demuxers 2>&1 || true)"
for want in decoder:libdav1d decoder:vp8 decoder:vp9 decoder:opus decoder:h264 \
    encoder:libx264 encoder:aac encoder:libopus encoder:libvpx encoder:libvpx-vp9 \
    encoder:mjpeg encoder:pcm_s16le encoder:png \
    muxer:mp4 muxer:webm muxer:matroska muxer:avi muxer:wav \
    demuxer:matroska,webm demuxer:mov,mp4,m4a,3gp,3g2,mj2 demuxer:avi; do
    name="${want#*:}"
    case "${want%%:*}" in
        decoder) list="$DECODERS" ;;
        encoder) list="$ENCODERS" ;;
        muxer) list="$MUXERS" ;;
        demuxer) list="$DEMUXERS" ;;
    esac
    if ! echo "$list" | grep -Eq "^ +[A-Z.]+ +$name( |\$)"; then
        echo "::error::ffmpeg has no ${want%%:*} $name"
        fail=1
    fi
done
[ "$fail" = 0 ] || exit 1

# An AV1 WebM (as ComfyUI writes) to MP4, that MP4 to WebM, and speech put
# under the AV1 clip the way video_mux_audio does.
CONV="$DIR/conv"
mkdir -p "$CONV"
command -v cygpath >/dev/null 2>&1 && CONV="$(cygpath -m "$CONV")"
AV1="$SCRIPT_DIR/fixtures/av1-smoke.webm"
command -v cygpath >/dev/null 2>&1 && AV1="$(cygpath -m "$AV1")"
"$FFMPEG" -v error -y -i "$AV1" -c:v libx264 -c:a aac "$CONV/from-av1.mp4"
"$FFMPEG" -v error -y -i "$CONV/from-av1.mp4" "$CONV/to.webm"
"$FFMPEG" -v error -y -f lavfi -i "sine=frequency=220:duration=1" "$CONV/speech.wav"
"$FFMPEG" -v error -y -i "$AV1" -i "$CONV/speech.wav" -map 0:v:0 -map 1:a:0 \
    -c:v copy -c:a libopus -b:a 96k -shortest -f webm "$CONV/muxed.webm"
# What upscale_input_args writes for the video upscalers.
"$FFMPEG" -v error -y -i "$CONV/muxed.webm" -map 0:v:0 -map "0:a:0?" -c:v mjpeg -q:v 2 \
    -pix_fmt yuvj420p -c:a pcm_s16le -f avi "$CONV/upscale.avi"
for f in from-av1.mp4 to.webm muxed.webm upscale.avi; do
    [ -s "$CONV/$f" ] || { echo "::error::ffmpeg wrote no $f"; exit 1; }
done
FRAMES="$("$FFMPEG" -v error -i "$CONV/from-av1.mp4" -map 0:v:0 -f null - -stats 2>&1 | grep -o 'frame= *[0-9]*' | tail -1 | tr -dc 0-9)"
[ "${FRAMES:-0}" -gt 0 ] || { echo "::error::the AV1 clip converted to an MP4 with no frames"; exit 1; }
echo "Conversions passed: AV1 WebM to MP4 ($FRAMES frames), MP4 to WebM, Opus speech muxed into WebM, MJPEG AVI."

# Captured first: grep -q stopping early would SIGPIPE melt under pipefail.
# (No associative arrays: macOS's bash is 3.2.)
TRANSITIONS="$("$MELT" -query transitions 2>&1 || true)"
FILTERS="$("$MELT" -query filters 2>&1 || true)"
PRODUCERS="$("$MELT" -query producers 2>&1 || true)"
CONSUMERS="$("$MELT" -query consumers 2>&1 || true)"
listed() {
    case "$1" in
        transition) echo "$TRANSITIONS" ;;
        filter) echo "$FILTERS" ;;
        producer) echo "$PRODUCERS" ;;
        consumer) echo "$CONSUMERS" ;;
    esac
}
for kind in transition:qtblend transition:luma transition:mix filter:volume \
    filter:avfilter.alimiter filter:panner filter:audiolevel filter:brightness \
    producer:avformat-novalidate producer:color producer:kdenlivetitle consumer:avformat; do
    service="${kind#*:}"
    if ! listed "${kind%%:*}" | grep -q -- "- $service\$"; then
        echo "::error::melt has no ${kind%%:*} $service"
        fail=1
    fi
done
if [ "$fail" != 0 ]; then
    echo "--- the bundle:"
    find "$DIR" -maxdepth 3 | sort | head -80
    echo "--- MLT_REPOSITORY=$MLT_REPOSITORY"
    "$MELT" -query filters 2>&1 | head -20
fi
[ "$fail" = 0 ] || exit 1

OUT="$DIR/smoke.mp4"
# melt reads it inside "avformat:…", which MSYS doesn't translate for a
# native Windows program.
command -v cygpath >/dev/null 2>&1 && OUT="$(cygpath -m "$OUT")"
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
