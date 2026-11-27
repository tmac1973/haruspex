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

# raw <owner/repo> <ref> <path> <file>: a file from GitHub into <file>. Some
# orgs (webmproject) refuse the OAuth app behind gh's token, so a refusal is
# tried again without it.
raw() {
    local url="repos/$1/contents/$3?ref=$2"
    gh api -H "Accept: application/vnd.github.raw+json" "$url" > "$4" 2>/dev/null ||
        curl -fsSL -H "Accept: application/vnd.github.raw+json" "https://api.github.com/$url" > "$4"
}

# get <dest> <owner/repo> <ref> <path>
get() {
    mkdir -p "$(dirname "$OUT/$1")"
    raw "$2" "$3" "$4" "$OUT/$1.part"
    mv -f "$OUT/$1.part" "$OUT/$1"
    echo "   $1 ($2@$3)"
}

# vendored <dest> <label> <owner/repo> <ref> <path> [<pattern>]: the licence of
# code a project bundles, headed by <label> (where the code is). With a
# pattern, the file is a source file whose licence is a comment in it: the
# first /* … */ block matching it.
vendored() {
    mkdir -p "$(dirname "$OUT/$1")"
    raw "$3" "$4" "$5" "$TMP/vendored"
    node -e '
        const [file, label, pattern] = process.argv.slice(1);
        let text = require("fs").readFileSync(file, "utf8");
        if (pattern) {
            const block = (text.match(/\/\*[\s\S]*?\*\//g) ?? []).find((b) => new RegExp(pattern, "i").test(b));
            if (!block) { console.error(`no licence comment matching ${pattern} in ${label}`); process.exit(1); }
            let lines = block.slice(2, -2).split("\n");
            // A column of stars down the comment goes, and lines of nothing but stars.
            if (lines.slice(1).every((l) => !l.trim() || /^\s*\*/.test(l)))
                lines = lines.map((l) => (/^\s*\*+\s*$/.test(l) ? "" : l.replace(/^\s*\* ?/, "")));
            const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
            text = lines.map((l) => l.slice(indent)).join("\n");
        }
        process.stdout.write(`${label}\n\n${text.trim()}\n`);
    ' "$TMP/vendored" "$2" "${6:-}" > "$OUT/$1.part"
    mv -f "$OUT/$1.part" "$OUT/$1"
    echo "   $1 ($3@$4 $5)"
}

# submodule <owner/repo> <ref> <path>: the commit a submodule is pinned to.
submodule() { gh api "repos/$1/contents/$3?ref=$2" --jq .sha; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Licence texts into licences/"
get sidecars/llama.cpp/LICENSE ggml-org/llama.cpp "$LLAMA" LICENSE
for f in $(gh api "repos/ggml-org/llama.cpp/contents/licenses?ref=$LLAMA" --jq '.[].name'); do
    get "sidecars/llama.cpp/$f" ggml-org/llama.cpp "$LLAMA" "licenses/$f"
done
# What llama.cpp builds in from vendor/. nlohmann/json is LICENSE-jsonhpp above.
L=sidecars/llama.cpp
lv() { vendored "$L/$1" "$2" ggml-org/llama.cpp "$LLAMA" "$2" "${3:-}"; }
lv vendor-cpp-httplib vendor/cpp-httplib/LICENSE
lv vendor-hash-rotate-bits vendor/hash/rotate-bits/LICENSE.md
lv vendor-hash-sha256 vendor/hash/sha256/LICENSE
lv vendor-hash-xxhash vendor/hash/xxhash/LICENSE
lv vendor-hash-sha1 vendor/hash/sha1/sha1.c 'public domain'
lv vendor-miniaudio vendor/miniaudio/miniaudio.h 'choice of the following licenses'
lv vendor-sheredom-subprocess vendor/sheredom/subprocess.h 'free and unencumbered'
lv vendor-stb-image vendor/stb/stb_image.h 'available under 2 licenses'

get sidecars/whisper.cpp/LICENSE ggml-org/whisper.cpp "$WHISPER" LICENSE
# What whisper-server builds in: the server's httplib.h and json.hpp, and
# common-whisper's miniaudio and stb_vorbis for decoding audio.
W=sidecars/whisper.cpp
wv() { vendored "$W/$1" "$2" ggml-org/whisper.cpp "$WHISPER" "$2" "$3"; }
vendored "$W/vendor-cpp-httplib" "examples/server/httplib.h (cpp-httplib)" \
    yhirose/cpp-httplib master LICENSE
vendored "$W/vendor-nlohmann-json" "examples/json.hpp (nlohmann/json)" \
    nlohmann/json develop LICENSE.MIT
wv vendor-miniaudio examples/miniaudio.h 'choice of the following licenses'
wv vendor-stb-vorbis examples/stb_vorbis.c 'available under 2 licenses'

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
# What sd-server builds in from thirdparty/ (upstream's release builds with the
# libwebp and libwebm submodules), and the web UI it serves.
D=sidecars/stable-diffusion.cpp
sv() { vendored "$D/$1" "$2" leejet/stable-diffusion.cpp "$SDCPP" "$2" "${3:-}"; }
sv vendor-darts-clone thirdparty/LICENSE.darts_clone.txt
sv vendor-oniguruma thirdparty/oniguruma/COPYING
sv vendor-utf8proc thirdparty/utf8proc/LICENSE.md
sv vendor-miniz thirdparty/miniz.h 'Permission is hereby granted'
sv vendor-miniz-public-domain thirdparty/miniz.h 'free and unencumbered'
sv vendor-stb-image thirdparty/stb_image.h 'available under 2 licenses'
sv vendor-stb-image-write thirdparty/stb_image_write.h 'available under 2 licenses'
vendored "$D/vendor-stb-image-resize" "thirdparty/stb_image_resize.h (nothings/stb)" \
    nothings/stb master LICENSE
vendored "$D/vendor-zip" "thirdparty/zip.c (kuba--/zip)" kuba--/zip master LICENSE.txt
vendored "$D/vendor-nlohmann-json" "thirdparty/json.hpp (nlohmann/json)" \
    nlohmann/json develop LICENSE.MIT
vendored "$D/vendor-cpp-httplib" "thirdparty/httplib.h (cpp-httplib)" \
    yhirose/cpp-httplib master LICENSE
WEBP="$(submodule leejet/stable-diffusion.cpp "$SDCPP" thirdparty/libwebp)"
vendored "$D/vendor-libwebp" thirdparty/libwebp/COPYING webmproject/libwebp "$WEBP" COPYING
vendored "$D/vendor-libwebp-patents" thirdparty/libwebp/PATENTS webmproject/libwebp "$WEBP" PATENTS
WEBM="$(submodule leejet/stable-diffusion.cpp "$SDCPP" thirdparty/libwebm)"
vendored "$D/vendor-libwebm" thirdparty/libwebm/LICENSE.TXT webmproject/libwebm "$WEBM" LICENSE.TXT
vendored "$D/vendor-libwebm-patents" thirdparty/libwebm/PATENTS.TXT webmproject/libwebm "$WEBM" PATENTS.TXT
UI="$(submodule leejet/stable-diffusion.cpp "$SDCPP" examples/server/frontend)"
vendored "$D/vendor-sdcpp-webui" "examples/server/frontend (sdcpp-webui)" leejet/sdcpp-webui "$UI" LICENSE

# The npm code built into that page, at the versions its pnpm-lock.yaml pins:
# Vue's runtime (its compilers run only at build time), plugin-vue's export
# helper and Vite's module-preload polyfill. Vite's LICENSE.md goes on to the
# licences of its own build-time dependencies, which never reach the page.
raw leejet/sdcpp-webui "$UI" pnpm-lock.yaml "$TMP/pnpm-lock.yaml"
lockver() {
    sed -n '/^packages:/,/^snapshots:/p' "$TMP/pnpm-lock.yaml" |
        sed -n "s/^  '\{0,1\}$(printf '%s' "$1" | sed 's/[/.]/\\&/g')@\([^':(]*\).*/\1/p" | head -1
}
# webui <dest> <npm package> [<line the text stops before>]
webui() {
    local version tgz
    version="$(lockver "$1")"
    [ -n "$version" ] || { echo "ERROR: $1 is not in sdcpp-webui's pnpm-lock.yaml" >&2; exit 1; }
    tgz="$TMP/npm/${1//\//_}"
    mkdir -p "$tgz"
    curl -fsSL "https://registry.npmjs.org/$1/-/${1##*/}-$version.tgz" | tar -xz -C "$tgz"
    local file
    file="$(find "$tgz/package" -maxdepth 1 -type f -iname 'licen[cs]e*' | sort | head -1)"
    [ -n "$file" ] || { echo "ERROR: no licence file in $1@$version" >&2; exit 1; }
    local name="${1#@}"
    name="webui-${name//\//-}"
    mkdir -p "$OUT/$D"
    {
        printf 'examples/server/frontend: %s %s (npm)\n\n' "$1" "$version"
        if [ -n "${2:-}" ]; then sed "/^$2/,\$d" "$file"; else cat "$file"; fi
    } > "$OUT/$D/$name"
    echo "   $D/$name ($1@$version)"
}
for p in vue @vue/runtime-dom @vue/runtime-core @vue/reactivity @vue/shared @vitejs/plugin-vue; do
    webui "$p"
done
webui vite '# Licenses of bundled dependencies'
get sidecars/uv/LICENSE-MIT astral-sh/uv "$UV" LICENSE-MIT
get sidecars/uv/LICENSE-APACHE astral-sh/uv "$UV" LICENSE-APACHE
get sidecars/ruff/LICENSE astral-sh/ruff "$RUFF" LICENSE

# pdfium's notices (its own and its third-party code) are in the release archive.
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
