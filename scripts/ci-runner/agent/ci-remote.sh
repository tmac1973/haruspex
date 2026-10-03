#!/usr/bin/env bash
# The Mac's end of `remote-test.sh`. Installed to ~/.haruspex-test/ by
# setup-macos.sh; called over SSH as you.
#
#   ci-remote.sh direct <suite>  unpack ~/.haruspex-test/src.tgz and run <suite>
#                                right here, streaming its output (suites that
#                                need no desktop: unit)
#   ci-remote.sh start <suite>   unpack it and start <suite> in the desktop
#                                session (via the LaunchAgent)
#   ci-remote.sh wait            stream the log until the suite ends; exit
#                                with its exit code
#   ci-remote.sh run             what the LaunchAgent runs (not for SSH)
#
# SSH sessions are outside the GUI session, and UI tests need the GUI, so the
# suite itself always runs under launchd in the logged-in session.

set -euo pipefail

CI="$HOME/.haruspex-test"
SRC="$CI/src"
LABEL=com.haruspex.ci-run
LOCK="$CI/busy"
LOG="$CI/run.log"
DONE="$CI/done"

prepare() {
    if [[ -e "$LOCK" ]]; then
        echo "busy: $(cat "$LOCK")" >&2
        exit 75
    fi
    echo "remote-test $1 since $(date)" >"$LOCK"
    # Keep node_modules (npm ci decides whether to redo it) and nothing else,
    # so a file deleted locally is deleted here.
    mkdir -p "$SRC"
    find "$SRC" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
    tar -xzf "$CI/src.tgz" -C "$SRC"
    rm -f "$DONE" "$LOG"
}

case "${1:-}" in
    direct)
        suite=${2:-unit}
        prepare "$suite"
        trap 'rm -f "$LOCK"' EXIT
        "$CI/run-suite.sh" "$suite" 2>&1 | tee "$LOG"
        exit "${PIPESTATUS[0]}"
        ;;
    start)
        suite=${2:-unit}
        prepare "$suite"
        echo "$suite" >"$CI/request"
        launchctl kickstart -k "gui/$(id -u)/$LABEL" || {
            rm -f "$LOCK"
            echo "Could not start the in-session agent. Are you logged in to the Mac's desktop?" >&2
            exit 1
        }
        echo "started $suite"
        ;;
    wait)
        while [[ ! -e "$LOG" ]]; do sleep 1; done
        tail -n +1 -f "$LOG" &
        tailer=$!
        while [[ ! -e "$DONE" ]]; do sleep 1; done
        sleep 1
        kill "$tailer" 2>/dev/null || true
        exit "$(cat "$DONE")"
        ;;
    run)
        suite=$(cat "$CI/request" 2>/dev/null || echo unit)
        set +e
        (exec "$CI/run-suite.sh" "$suite") >"$LOG" 2>&1
        code=$?
        set -e
        echo "$code" >"$DONE"
        rm -f "$LOCK"
        ;;
    *)
        sed -n '2,13p' "$0"
        exit 2
        ;;
esac
