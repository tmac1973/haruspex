#!/usr/bin/env bash
# Placeholder sidecar binaries and resource dirs for CI. tauri-build checks that
# every externalBin and resource glob exists at compile time; CI has no real
# sidecars, and doesn't need them. The real-app tests replace the binaries with
# e2e/sidecar-stub after building (e2e/app/build.mjs).
set -euo pipefail
bin="$(git rev-parse --show-toplevel)/src-tauri/binaries"
mkdir -p "$bin"
cd "$bin"
TARGET=$(rustc --print host-tuple)
for name in haruspex-llama-server haruspex-whisper-server haruspex-koko haruspex-ruff haruspex-node haruspex-uv haruspex-sd-server; do
    [[ -e "${name}-${TARGET}" ]] && continue
    echo '#!/bin/sh' >"${name}-${TARGET}"
    chmod +x "${name}-${TARGET}"
done
for dir in node-modules libs sd-libs espeak-ng-data espeak-ng-data/lang espeak-ng-data/lang/placeholder; do
    mkdir -p "$dir"
    touch "$dir/.placeholder"
done
