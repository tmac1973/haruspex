#!/usr/bin/env bash
# Runs every time OpenHands starts work on this repo. Report the environment
# loudly rather than letting the agent discover gaps forty turns in.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

for t in node npm git jq python3 uv; do
  printf '%-8s %s\n' "$t" "$(command -v "$t" >/dev/null && $t --version 2>&1 | head -1 || echo MISSING)"
done
if command -v cargo >/dev/null; then cargo --version; else
  echo "NOTE: no Rust toolchain here - src-tauri cannot be built or tested in this sandbox."
fi

[ -d node_modules ] || npm ci --no-audit --fund=false || { echo "npm ci failed"; exit 1; }

# Fail fast if the checkout itself is broken, before any model budget is spent.
npx svelte-check --threshold error --output human >/dev/null 2>&1 || \
  echo "NOTE: svelte-check reported problems on the untouched checkout - mention this in the PR body."
exit 0
