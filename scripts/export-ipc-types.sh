#!/usr/bin/env bash
# Regenerate the committed TS types for IPC boundary structs (ts-rs) and
# the IPC command-name constant. Run after changing any #[ts(export)]
# struct or the generate_handler![] list; CI fails if these are stale.
set -euo pipefail
cd "$(dirname "$0")/.."

TS_RS_EXPORT_DIR="$PWD/src/lib/ipc/gen" cargo test --manifest-path src-tauri/Cargo.toml export_bindings
node scripts/check-ipc.mjs --write
echo "IPC bindings regenerated."
