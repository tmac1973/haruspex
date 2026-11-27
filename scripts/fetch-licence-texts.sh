#!/bin/bash
# Fetch the licence texts of the programs the app ships beside itself into
# licences/, which is committed: scripts/build-licences.mjs reads them for
# Settings → About → Licences, and a CI or dev build that only has stub
# sidecars still gets the full list. Run it when a pinned version changes
# (LLAMA_CPP_VERSION, UV_VERSION, …) and commit what changes.
#
# The media bundle (ffmpeg, ffprobe, melt) and Node/npm are not here: their
# archives carry their own licence files, which the bundle ships and
# build-licences.mjs reads from src-tauri/binaries/.
#
# Needs gh (signed in): it reads each file through the GitHub API.
#
# Usage: ./scripts/fetch-licence-texts.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
OUT="$ROOT/licences"

pin() { tr -d '[:space:]' < "$ROOT/$1"; }
LLAMA="$(pin LLAMA_CPP_VERSION)"
WHISPER="$(pin WHISPER_CPP_VERSION)"
UV="$(pin UV_VERSION)"
RUFF="$(pin RUFF_VERSION)"
SDCPP="$(sed -n 's/^SDCPP_VERSION="\(.*\)"/\1/p' "$SCRIPT_DIR/fetch-sdcpp.sh")"
PDFIUM="$(sed -n 's/^PDFIUM_VERSION="\${PDFIUM_VERSION:-\(.*\)}"/\1/p' "$SCRIPT_DIR/fetch-pdfium.sh")"
PYODIDE="$(sed -n 's/^PYODIDE_VERSION="\(.*\)"/\1/p' "$SCRIPT_DIR/fetch-pyodide.sh")"

# get <dest> <owner/repo> <ref> <path>
get() {
    mkdir -p "$(dirname "$OUT/$1")"
    gh api -H "Accept: application/vnd.github.raw+json" "repos/$2/contents/$4?ref=$3" > "$OUT/$1.part"
    mv -f "$OUT/$1.part" "$OUT/$1"
    echo "   $1 ($2@$3)"
}

echo "==> Licence texts into licences/"
get sidecars/llama.cpp/LICENSE ggml-org/llama.cpp "$LLAMA" LICENSE
for f in $(gh api "repos/ggml-org/llama.cpp/contents/licenses?ref=$LLAMA" --jq '.[].name'); do
    get "sidecars/llama.cpp/$f" ggml-org/llama.cpp "$LLAMA" "licenses/$f"
done
get sidecars/whisper.cpp/LICENSE ggml-org/whisper.cpp "$WHISPER" LICENSE

# Kokoros is built from its default branch, with espeak-ng (and its pcaudiolib
# and sonic) and ONNX Runtime (through the ort crate) linked in, and espeak-ng's
# data shipped beside it. Its crates are listed by build-sidecars.sh.
get sidecars/kokoros/LICENSE lucasjinreal/Kokoros main LICENSE
# ONNX Runtime's LICENSE is the standard MIT text for Microsoft Corporation
# (github.com/microsoft/onnxruntime); written from our template, since the
# ort crate downloads the static library without it.
sed 's/{holder}/Microsoft Corporation/' "$OUT/spdx/MIT.txt" > "$OUT/sidecars/kokoros/onnxruntime-LICENSE"
echo "   sidecars/kokoros/onnxruntime-LICENSE (standard MIT text)"
for f in COPYING COPYING.APACHE COPYING.BSD2 COPYING.UCD; do
    get "sidecars/kokoros/espeak-ng-$f" espeak-ng/espeak-ng master "$f"
done
get sidecars/kokoros/pcaudiolib-COPYING espeak-ng/pcaudiolib master COPYING
get sidecars/kokoros/sonic-LICENSE waywardgeek/sonic master LICENSE

get sidecars/stable-diffusion.cpp/LICENSE leejet/stable-diffusion.cpp "$SDCPP" LICENSE
get sidecars/stable-diffusion.cpp/ggml-LICENSE ggml-org/ggml master LICENSE
get sidecars/uv/LICENSE-MIT astral-sh/uv "$UV" LICENSE-MIT
get sidecars/uv/LICENSE-APACHE astral-sh/uv "$UV" LICENSE-APACHE
get sidecars/ruff/LICENSE astral-sh/ruff "$RUFF" LICENSE

# pdfium's notices (its own and its third-party code) are in the release archive.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
gh release download "$PDFIUM" -R bblanchon/pdfium-binaries -p pdfium-linux-x64.tgz -D "$TMP"
tar -xzf "$TMP/pdfium-linux-x64.tgz" -C "$TMP" LICENSE
mkdir -p "$OUT/sidecars/pdfium"
cp "$TMP/LICENSE" "$OUT/sidecars/pdfium/LICENSE"
echo "   sidecars/pdfium/LICENSE (bblanchon/pdfium-binaries@$PDFIUM)"

# Pyodide runs CPython; static/pyodide ships its runtime and standard library.
get sidecars/pyodide/CPython-LICENSE python/cpython 3.14 LICENSE

# npm packages that publish no licence file: the text from their repository.
get npm/pyodide/LICENSE pyodide/pyodide "$PYODIDE" LICENSE
get npm/sirv/license lukeed/sirv main license
get npm/@polka/url/license lukeed/polka main license
get npm/isarray/LICENSE juliangruber/isarray master LICENSE
get npm/@xterm/addon-serialize/LICENSE xtermjs/xterm.js master LICENSE
