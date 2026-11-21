#!/bin/bash
# Sets, in the calling shell, the environment the media bundle's binaries run
# with: the library path and MLT's and Qt's folders under <dir>/media. The same
# table as src-tauri/src/media_env.rs. Source it: `. media-env.sh <dir>`.
_media="$(cd "$1/media" && pwd)"
case "$(uname -s)" in
    Darwin) export DYLD_LIBRARY_PATH="$_media/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" ;;
    MINGW*|MSYS*|CYGWIN*)
        export PATH="$_media/lib:$PATH"
        # Native Windows programs read the rest; give them Windows paths.
        _media="$(cygpath -m "$_media")"
        ;;
    *) export LD_LIBRARY_PATH="$_media/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
esac
export MLT_REPOSITORY="$_media/mlt"
export MLT_DATA="$_media/mlt-data"
export MLT_PROFILES_PATH="$_media/mlt-data/profiles"
export MLT_PRESETS_PATH="$_media/mlt-data/presets"
export QT_PLUGIN_PATH="$_media/qt-plugins"
export QT_QPA_PLATFORM=offscreen
unset _media
