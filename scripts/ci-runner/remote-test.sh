#!/usr/bin/env bash
# Run a test suite on the Mac mini or the Windows machine, from here, against
# your working tree as it is now (uncommitted changes included).
#
#   scripts/ci-runner/remote-test.sh mac|windows|both [suite]
#
# suite: unit (default), e2e-app, e2e-mac, live — see agent/run-suite.sh.
#
# Hosts are SSH aliases, haruspex-mac and haruspex-win, from ~/.ssh/config
# (the setup scripts print the entry to add). Override with
# HARUSPEX_MAC_HOST / HARUSPEX_WIN_HOST.
#
# It packs the files git tracks or would track (so target/ and node_modules
# stay here), copies them over, starts the suite in the CI user's desktop
# session, streams the log, and exits with the suite's result. With `both`,
# the two run at once and the logs go to files, printed when each finishes.

set -euo pipefail

target=${1:-}
suite=${2:-unit}
MAC=${HARUSPEX_MAC_HOST:-haruspex-mac}
WIN=${HARUSPEX_WIN_HOST:-haruspex-win}
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)

usage() {
    sed -n '2,16p' "$0"
    exit 2
}

pack() {
    local out=$1
    (
        cd "$root"
        # Written first, so `ls-files -o` lists it with the untracked files.
        git describe --always --dirty >.remote-test-rev
        git ls-files -co --exclude-standard -z |
            tar --null --ignore-failed-read -T - -czf "$out" 2>/dev/null
        rm -f .remote-test-rev
    )
}

run_on() {
    local os=$1 host=$2 tgz=$3
    echo "-- $os ($host): copying $(du -h "$tgz" | cut -f1)"
    scp -q "$tgz" "$host:haruspex-ci/src.tgz"
    if [[ $os == mac ]]; then
        ssh "$host" '~/haruspex-ci/ci-remote.sh start' "$suite"
        ssh "$host" '~/haruspex-ci/ci-remote.sh wait'
    else
        ssh "$host" "powershell -NoProfile -ExecutionPolicy Bypass -File haruspex-ci\\ci-remote.ps1 -Action start -Suite $suite"
        ssh "$host" "powershell -NoProfile -ExecutionPolicy Bypass -File haruspex-ci\\ci-remote.ps1 -Action wait"
    fi
}

[[ -n $target ]] || usage
[[ $suite =~ ^[a-z0-9-]+$ ]] || {
    echo "bad suite name: $suite" >&2
    exit 2
}
tgz=$(mktemp --suffix=.tgz)
trap 'rm -f "$tgz"' EXIT
pack "$tgz"

case "$target" in
    mac) run_on mac "$MAC" "$tgz" ;;
    windows | win) run_on windows "$WIN" "$tgz" ;;
    both)
        logs=$(mktemp -d)
        run_on mac "$MAC" "$tgz" </dev/null >"$logs/mac.log" 2>&1 &
        mac_pid=$!
        run_on windows "$WIN" "$tgz" </dev/null >"$logs/windows.log" 2>&1 &
        win_pid=$!
        echo "running on both; logs in $logs"
        status=0
        for os in mac windows; do
            pid=$([[ $os == mac ]] && echo $mac_pid || echo $win_pid)
            if wait "$pid"; then result=passed; else result=FAILED; status=1; fi
            echo
            echo "======== $os: $result ========"
            tail -n 40 "$logs/$os.log"
        done
        exit $status
        ;;
    *) usage ;;
esac
