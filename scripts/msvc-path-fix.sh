#!/bin/bash
# On Windows (Git Bash), Git ships a POSIX link.exe in /usr/bin that shadows
# the MSVC linker. Find the real MSVC link.exe and prepend its directory to
# PATH so it takes priority.
#
# Usage: source scripts/msvc-path-fix.sh

case "$(rustc --print host-tuple 2>/dev/null)" in
    *-windows-msvc)
        MSVC_LINK=$(cmd //c "where link.exe" 2>/dev/null | grep -i "MSVC\|Visual Studio\|HostX64" | head -1 | tr -d '\r')
        if [ -n "$MSVC_LINK" ]; then
            MSVC_LINK_DIR=$(dirname "$MSVC_LINK")
            MSVC_LINK_DIR=$(cygpath -u "$MSVC_LINK_DIR" 2>/dev/null || echo "$MSVC_LINK_DIR")
            export PATH="$MSVC_LINK_DIR:$PATH"
            echo "MSVC linker: $MSVC_LINK"
        else
            echo "WARN: Could not find MSVC link.exe — linking may fail"
        fi
        ;;
esac
