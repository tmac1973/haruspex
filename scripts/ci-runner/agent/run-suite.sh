#!/usr/bin/env bash
# Run one test suite on the source tree in ~/.haruspex-test/src: the Mac agent's
# suite runner (Windows has run-suite.ps1).
#
#   unit      npm run check + test, cargo clippy + test (what CI runs)
#   e2e-app   not on macOS: tauri-driver has no WKWebView support
#   smoke     the e2e build, launched in your desktop session: it starts its
#             (stub) model server, and after a kill -9 a relaunch clears it
#   e2e-mac   npm run e2e:mac     } added by plan/misc_futures phase 14;
#             (needs Xcode)       } until then they say so and fail
#   live      npm run e2e:live    }

set -euo pipefail
suite=${1:-unit}
cd "$HOME/.haruspex-test/src"
export PATH="$HOME/.npm-global/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# Outside the source tree, which is replaced on every run: keeps incremental
# builds across runs.
export CARGO_TARGET_DIR="$HOME/.haruspex-test/cache/target"

echo "== $suite on $(hostname) at $(date)"
# remote-test.sh records what it sent: the tree has no .git.
echo "== $(cat .remote-test-rev 2>/dev/null || echo 'unknown revision') · node $(node -v) · $(cargo --version)"

# npm ci only when the lockfile changed.
lock_hash=$(shasum -a 256 package-lock.json | cut -d' ' -f1)
stamp="$HOME/.haruspex-test/cache/npm-lock.sha256"
mkdir -p "$HOME/.haruspex-test/cache"
if [[ ! -d node_modules || "$(cat "$stamp" 2>/dev/null)" != "$lock_hash" ]]; then
    echo "== npm ci"
    npm ci
    echo "$lock_hash" >"$stamp"
fi

# tauri-build validates every externalBin path at compile time. Placeholders,
# as CI uses, unless real sidecars were fetched.
target=$(rustc --print host-tuple)
mkdir -p src-tauri/binaries/{node-modules,libs,sd-libs,espeak-ng-data/lang/placeholder}
for name in haruspex-{llama-server,whisper-server,koko,ruff,node,uv,sd-server}; do
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
    e2e-app)
        # tauri-driver drives WebKitGTK and WebView2 only; there is no
        # WebDriver for the app's WKWebView. The Mac's UI suite is e2e-mac.
        echo "e2e-app does not run on macOS: tauri-driver has no WKWebView support (use e2e-mac)"
        exit 2
        ;;
    smoke)
        # No WebDriver for WKWebView, so no settings to seed: a fresh install
        # with a model file in its folder starts the model server by itself.
        # macOS can't make a child die with its parent (sidecar_process.rs);
        # the guarantee here is the launch sweep (orphans.rs): kill the app
        # outright, launch it again, and the old server goes.
        export E2E_TARGET_DIR="$HOME/.haruspex-test/cache/target-e2e"
        npm run e2e:app:build
        id=com.haruspex.app.e2e
        rm -rf "$HOME/Library/Application Support/$id" "$HOME/Library/Caches/$id" "$HOME/Library/WebKit/$id"
        mkdir -p "$HOME/Library/Application Support/$id/models"
        echo 'not a real model' >"$HOME/Library/Application Support/$id/models/e2e-stub.gguf"
        E2E_STUB_PIDS=$(mktemp -d)
        export E2E_STUB_PIDS
        pidfile="$E2E_STUB_PIDS/haruspex-llama-server.pid"
        launch() {
            rm -f "$pidfile"
            "$E2E_TARGET_DIR/debug/haruspex" >>"$HOME/.haruspex-test/smoke-app.log" 2>&1 &
            app=$!
            for _ in $(seq 60); do [[ -s $pidfile ]] && break; sleep 1; done
            [[ -s $pidfile ]] || { echo "!! the app never started its model server"; kill -9 "$app"; exit 1; }
            server=$(cat "$pidfile")
            echo "== app $app started the model server $server"
        }
        : >"$HOME/.haruspex-test/smoke-app.log"
        launch
        screencapture -x "$HOME/.haruspex-test/smoke.png" 2>/dev/null || echo "(no screenshot: Screen Recording not allowed)"
        old=$server
        kill -9 "$app"
        sleep 2
        kill -0 "$old" 2>/dev/null && echo "== the model server $old outlived the app, as expected on macOS"
        launch
        for _ in $(seq 50); do kill -0 "$old" 2>/dev/null || break; sleep 0.2; done
        if kill -0 "$old" 2>/dev/null; then
            kill -9 "$old" "$server" "$app"
            echo "!! relaunching did not stop the orphaned model server $old"
            exit 1
        fi
        echo "== relaunching stopped the orphaned model server"
        kill -9 "$app"
        sleep 1
        kill -9 "$server" 2>/dev/null || true
        ;;
    e2e-mac) npm_script e2e:mac ;;
    live) npm_script e2e:live ;;
    *)
        echo "unknown suite: $suite (unit, e2e-app, smoke, e2e-mac, live)"
        exit 2
        ;;
esac
echo "== $suite passed"
