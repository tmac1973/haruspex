#!/bin/bash
# Lets a dev build use KDE Plasma's click-a-window capture (camera button →
# Window…). KWin only answers org.kde.KWin.ScreenShot2 for an executable that
# a .desktop file lists the interface for; the deb and rpm ship that line in
# src-tauri/linux/main.desktop. This writes a hidden entry pointing at this
# checkout's debug build. Without it, Window… falls back to Region….
#
# Usage: ./scripts/kwin-dev-desktop-entry.sh [--remove]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EXE="$PROJECT_ROOT/src-tauri/target/debug/haruspex"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
# One entry per checkout, so worktrees do not overwrite each other.
ID="haruspex-dev-$(printf '%s' "$PROJECT_ROOT" | sha1sum | cut -c1-8)"
ENTRY="$APPS/$ID.desktop"

if [ "$1" = "--remove" ]; then
    rm -f "$ENTRY"
    echo ">> Removed $ENTRY"
else
    mkdir -p "$APPS"
    cat > "$ENTRY" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Haruspex (dev)
Exec=$EXE
NoDisplay=true
X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2
DESKTOP
    echo ">> Wrote $ENTRY"
fi

# KWin reads entries through KService's cache.
if command -v kbuildsycoca6 >/dev/null; then
    kbuildsycoca6 >/dev/null 2>&1 || true
fi
