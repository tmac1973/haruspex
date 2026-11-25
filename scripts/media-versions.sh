#!/bin/bash
# The versions in Haruspex's media bundle: ffmpeg, MLT (melt) and the Qt that
# MLT's qt6 module needs. Sourced by build-media.sh, fetch-media.sh and the
# Build media tools workflow, so a bump happens in one place.
#
# MEDIA_TAG names the media-<tag> release fetch-media.sh downloads. Bump its
# last number when the build changes without a version change, then run the
# Build media tools workflow before the next app release.

# shellcheck disable=SC2034 # read by the scripts that source this file
FFMPEG_TAG="n8.1.3"
# The MLT Kdenlive 26.08 is built against.
MLT_VERSION="7.40.0"
# The Qt 6 LTS Fedora 44 runs MLT 7.40 on.
QT_VERSION="6.11.3"
MEDIA_TAG="${FFMPEG_TAG}-mlt${MLT_VERSION}-2"
