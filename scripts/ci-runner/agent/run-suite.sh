#!/usr/bin/env bash
# Run one test suite on the source tree in ~/haruspex-src: the Mac agent's
# suite runner (Windows has run-suite.ps1).
#
#   unit      npm run check + test, cargo clippy + test (what CI runs)
#   e2e-app   npm run e2e:app     } added by plan/misc_futures phase 14;
#   e2e-mac   npm run e2e:mac     } until then they say so and fail
#   live      npm run e2e:live    }

set -euo pipefail
suite=${1:-unit}
cd "$HOME/haruspex-src"
export PATH="$HOME/.npm-global/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# Outside the source tree, which is replaced on every run: keeps incremental
# builds across runs.
export CARGO_TARGET_DIR="$HOME/haruspex-cache/target"

echo "== $suite on $(hostname) at $(date)"
# remote-test.sh records what it sent: the tree has no .git.
echo "== $(cat .remote-test-rev 2>/dev/null || echo 'unknown revision') · node $(node -v) · $(cargo --version)"

# npm ci only when the lockfile changed.
lock_hash=$(shasum -a 256 package-lock.json | cut -d' ' -f1)
stamp="$HOME/haruspex-cache/npm-lock.sha256"
mkdir -p "$HOME/haruspex-cache"
if [[ ! -d node_modules || "$(cat "$stamp" 2>/dev/null)" != "$lock_hash" ]]; then
    echo "== npm ci"
    npm ci
    echo "$lock_hash" >"$stamp"
fi

# tauri-build validates every externalBin path at compile time. Placeholders,
# as CI uses, unless real sidecars were fetched.
target=$(rustc --print host-tuple)
mkdir -p src-tauri/binaries/{node-modules,libs,sd-libs,espeak-ng-data/lang/placeholder}
for name in llama-server whisper-server koko ruff node uv sd-server; do
    bin="src-tauri/binaries/${name}-${target}"
    [[ -e "$bin" ]] || { echo '#!/bin/sh' >"$bin" && chmod +x "$bin"; }
done
for f in node-modules libs sd-libs espeak-ng-data espeak-ng-data/lang espeak-ng-data/lang/placeholder; do
    touch "src-tauri/binaries/$f/.placeholder"
done

npm_script() {
    if node -e "process.exit(require('./package.json').scripts['$1'] ? 0 : 1)"; then
        npm run "$1"
    else
        echo "!! npm script '$1' does not exist yet (plan/misc_futures phase 14)"
        return 1
    fi
}

case "$suite" in
    unit)
        echo "== npm run check"
        npm run check
        echo "== npm run test"
        npm run test
        echo "== cargo clippy"
        cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
        echo "== cargo test"
        cargo test --manifest-path src-tauri/Cargo.toml --lib
        ;;
    e2e-app) npm_script e2e:app ;;
    e2e-mac) npm_script e2e:mac ;;
    live) npm_script e2e:live ;;
    *)
        echo "unknown suite: $suite (unit, e2e-app, e2e-mac, live)"
        exit 2
        ;;
esac
echo "== $suite passed"
