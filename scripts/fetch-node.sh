#!/bin/bash
# Downloads Node.js into src-tauri/binaries/ — both the interpreter and npm.
# Used to install and launch npm-published MCP servers without asking the user
# to install Node.
#
# Unlike ruff and uv, Node is NOT a single file. The official distribution is
# an archive holding `bin/node` AND the npm CLI as a JavaScript tree under
# `lib/node_modules/npm` (Windows puts both at the archive root). The binary
# alone cannot run npm, so this script installs two things:
#
#   src-tauri/binaries/node-<triple>[.exe]   -> a Tauri externalBin sidecar
#   src-tauri/binaries/node-modules/npm/     -> a Tauri bundle resource
#   src-tauri/binaries/node-modules/node-LICENSE
#
# Node's LICENSE ships alongside the npm tree because MIT requires the notice
# to travel with the redistributed binary, and the binary itself carries none.
# npm's own LICENSE (Artistic-2.0, a different license) is already inside its
# tree. See NOTICE.md.
#
# npm is then invoked as `node <npm-cli.js>`, never through a platform shim,
# so nothing depends on a PATH we do not control. See src-tauri/src/runtimes.rs.
#
# The release publishes SHASUMS256.txt, so the archive is verified rather than
# trusted. A checksum mismatch is fatal; a missing sha256 tool skips the
# install rather than proceeding unverified.
#
# Idempotent — skips the download if both pieces are already present.
#
# Usage: ./scripts/fetch-node.sh [--target <triple>]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"
NPM_DEST_DIR="$BINARIES_DIR/node-modules"

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

NODE_VERSION="$(cat "$PROJECT_ROOT/NODE_VERSION" 2>/dev/null | tr -d '[:space:]')"
case "$TARGET_TRIPLE" in
    x86_64-unknown-linux-gnu)  NODE_SLUG="linux-x64"    ; NODE_ARCHIVE_EXT="tar.xz" ; NODE_EXE="node" ;;
    aarch64-unknown-linux-gnu) NODE_SLUG="linux-arm64"  ; NODE_ARCHIVE_EXT="tar.xz" ; NODE_EXE="node" ;;
    x86_64-apple-darwin)       NODE_SLUG="darwin-x64"   ; NODE_ARCHIVE_EXT="tar.gz" ; NODE_EXE="node" ;;
    aarch64-apple-darwin)      NODE_SLUG="darwin-arm64" ; NODE_ARCHIVE_EXT="tar.gz" ; NODE_EXE="node" ;;
    x86_64-pc-windows-msvc)    NODE_SLUG="win-x64"      ; NODE_ARCHIVE_EXT="zip"    ; NODE_EXE="node.exe" ;;
    *) NODE_SLUG="" ;;
esac

if [ -z "$NODE_SLUG" ]; then
    echo ">> WARN: unknown target $TARGET_TRIPLE for Node — skipping"
    exit 0
fi
if [ -z "$NODE_VERSION" ]; then
    echo ">> WARN: NODE_VERSION file missing or empty — skipping Node"
    exit 0
fi

NODE_DEST="$BINARIES_DIR/node-$TARGET_TRIPLE"
# Windows sidecars need the .exe suffix on top of the triple for Tauri.
case "$TARGET_TRIPLE" in *windows*) NODE_DEST="$NODE_DEST.exe" ;; esac

# Both halves must be present — a node binary with no npm tree cannot install
# an MCP server, so a partial install has to re-fetch rather than look done.
if [ -f "$NODE_DEST" ] && [ -f "$NPM_DEST_DIR/npm/bin/npm-cli.js" ]; then
    echo ">> Node already installed."
    exit 0
fi

# Pick whichever checksum tool this platform has. Refusing to install beats
# installing something we could not verify.
if command -v sha256sum >/dev/null 2>&1; then
    sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
    sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
    echo ">> WARN: no sha256sum or shasum available — skipping Node rather than installing it unverified"
    exit 0
fi

NODE_DIR="node-v$NODE_VERSION-$NODE_SLUG"
NODE_ASSET="$NODE_DIR.$NODE_ARCHIVE_EXT"
NODE_BASE_URL="https://nodejs.org/dist/v$NODE_VERSION"

echo ">> Downloading Node $NODE_VERSION ($NODE_SLUG)..."
mkdir -p "$BINARIES_DIR"
TMP_DIR=$(mktemp -d)
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

if ! curl -fsSL -o "$TMP_DIR/$NODE_ASSET" "$NODE_BASE_URL/$NODE_ASSET"; then
    echo "   WARN: failed to download Node — npm MCP servers will be unavailable"
    exit 0
fi
if ! curl -fsSL -o "$TMP_DIR/SHASUMS256.txt" "$NODE_BASE_URL/SHASUMS256.txt"; then
    echo "   WARN: failed to download SHASUMS256.txt — skipping Node rather than installing it unverified"
    exit 0
fi

EXPECTED="$(grep " $NODE_ASSET\$" "$TMP_DIR/SHASUMS256.txt" | cut -d' ' -f1)"
if [ -z "$EXPECTED" ]; then
    echo "   ERROR: $NODE_ASSET has no entry in SHASUMS256.txt"
    exit 1
fi
ACTUAL="$(sha256_of "$TMP_DIR/$NODE_ASSET")"
if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "   ERROR: checksum mismatch for $NODE_ASSET"
    echo "     expected $EXPECTED"
    echo "     actual   $ACTUAL"
    exit 1
fi
echo "   Checksum verified."

case "$NODE_ARCHIVE_EXT" in
    tar.xz|tar.gz) tar -xf "$TMP_DIR/$NODE_ASSET" -C "$TMP_DIR" ;;
    zip)           unzip -q "$TMP_DIR/$NODE_ASSET" -d "$TMP_DIR" ;;
esac

EXTRACTED="$TMP_DIR/$NODE_DIR"
if [ ! -d "$EXTRACTED" ]; then
    echo "   ERROR: expected $NODE_DIR inside the archive"
    exit 1
fi

# The interpreter: bin/node on unix, node.exe at the root on Windows.
FOUND_NODE=$(find "$EXTRACTED" -maxdepth 2 -type f -name "$NODE_EXE" | head -1)
if [ -z "$FOUND_NODE" ]; then
    echo "   ERROR: $NODE_EXE not found inside the archive"
    exit 1
fi
cp "$FOUND_NODE" "$NODE_DEST"
chmod +x "$NODE_DEST"
echo "   Installed: $NODE_DEST"

# The npm tree: lib/node_modules/npm on unix, node_modules/npm on Windows.
if [ -d "$EXTRACTED/lib/node_modules/npm" ]; then
    FOUND_NPM="$EXTRACTED/lib/node_modules/npm"
elif [ -d "$EXTRACTED/node_modules/npm" ]; then
    FOUND_NPM="$EXTRACTED/node_modules/npm"
else
    echo "   ERROR: npm not found inside the archive"
    exit 1
fi

# Replace rather than merge — a stale tree from an older Node would otherwise
# leave orphaned files behind that npm never overwrites.
rm -rf "$NPM_DEST_DIR/npm"
mkdir -p "$NPM_DEST_DIR"
cp -R "$FOUND_NPM" "$NPM_DEST_DIR/npm"
echo "   Installed: $NPM_DEST_DIR/npm"

if [ -f "$EXTRACTED/LICENSE" ]; then
    cp "$EXTRACTED/LICENSE" "$NPM_DEST_DIR/node-LICENSE"
    echo "   Installed: $NPM_DEST_DIR/node-LICENSE"
else
    echo "   ERROR: Node LICENSE not found inside the archive"
    exit 1
fi
