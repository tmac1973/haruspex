#!/usr/bin/env bash
# Haruspex live-test runner, macOS part 2 of 2: the runner itself.
#
# Run as haruspex-ci, logged in to its desktop session:
#   /Users/Shared/haruspex-ci/macos-2-runner.sh --ssh-key "ssh-ed25519 AAAA... you@linux"
#
# Installs Rust and Appium with the Mac2 driver for this user, the agent that
# runs remote-test.sh's suites in this desktop session, and your public key
# for SSH; registers a GitHub Actions runner (labels: self-hosted,
# haruspex-live, macos) and starts it at every login. Safe to re-run.
#
#   --ssh-key KEY  your Linux box's PUBLIC key (cat ~/.ssh/id_ed25519.pub);
#                  may be given again to add another
#   --reconfigure  register the runner again (e.g. after removing it on GitHub)
#   --uninstall    stop the runner and remove its registration

set -euo pipefail

REPO=tmac1973/haruspex
NAME=${RUNNER_NAME:-haruspex-mac-mini}
LABELS=haruspex-live,macos
DIR="$HOME/actions-runner"
MODE=install
SSH_KEYS=()
while (($#)); do
    case "$1" in
        --ssh-key)
            SSH_KEYS+=("${2:?--ssh-key needs the key}")
            shift
            ;;
        --reconfigure) MODE=reconfigure ;;
        --uninstall) MODE=uninstall ;;
        -h | --help)
            sed -n '2,17p' "$0"
            exit 0
            ;;
        *)
            echo "unknown option: $1" >&2
            exit 2
            ;;
    esac
    shift
done
HERE="$(cd "$(dirname "$0")" && pwd)"

step() { printf '\n==> %s\n' "$*"; }

[[ "$(id -un)" == haruspex-ci ]] || {
    echo "Run this as haruspex-ci (log in as that user)." >&2
    exit 1
}
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"

ensure_gh_auth() {
    if ! gh auth status >/dev/null 2>&1; then
        step "Sign the GitHub CLI in (a browser opens; the token stays on this machine)"
        gh auth login --hostname github.com --git-protocol https --web
    fi
}

if [[ $MODE == uninstall ]]; then
    step "Removing the runner"
    cd "$DIR"
    ./svc.sh stop || true
    ./svc.sh uninstall || true
    ensure_gh_auth
    ./config.sh remove --token "$(gh api -X POST "repos/$REPO/actions/runners/remove-token" -q .token)"
    launchctl bootout "gui/$(id -u)/com.haruspex.ci-run" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/com.haruspex.ci-run.plist"
    echo "ok: removed $NAME and the remote-test agent"
    exit 0
fi

step "Rust"
if [[ ! -x "$HOME/.cargo/bin/cargo" ]]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
        sh -s -- -y --profile minimal --component clippy rustfmt
fi
# shellcheck disable=SC1091
source "$HOME/.cargo/env"
echo "ok: $(cargo --version)"

step "Appium and the Mac2 driver"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
command -v appium >/dev/null 2>&1 || npm install -g appium
if appium driver list --installed 2>&1 | grep -q mac2; then
    appium driver update mac2 >/dev/null 2>&1 || true
else
    appium driver install mac2
fi
echo "ok: appium $(appium --version), mac2 driver installed"

step "GitHub Actions runner"
mkdir -p "$DIR"
cd "$DIR"
if [[ ! -x ./config.sh ]]; then
    arch=$([[ "$(uname -m)" == arm64 ]] && echo arm64 || echo x64)
    ensure_gh_auth
    tag=$(gh api repos/actions/runner/releases/latest -q .tag_name)
    ver=${tag#v}
    gh release download "$tag" --repo actions/runner \
        --pattern "actions-runner-osx-${arch}-${ver}.tar.gz" --dir "$DIR" --clobber
    tar xzf "actions-runner-osx-${arch}-${ver}.tar.gz"
    rm "actions-runner-osx-${arch}-${ver}.tar.gz"
    echo "ok: runner $ver unpacked"
fi

CI_PATH="$HOME/.npm-global/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH="$CI_PATH"
if [[ ! -f .runner || $MODE == reconfigure ]]; then
    ensure_gh_auth
    token=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" -q .token)
    ./config.sh --unattended --replace --url "https://github.com/$REPO" --token "$token" \
        --name "$NAME" --labels "$LABELS" --work _work
fi
# The service starts with launchd's minimal PATH and takes the runner's from
# this file. config.sh writes it from the shell; write it again so a re-run
# picks up anything installed since.
echo "$CI_PATH" >.path

./svc.sh install >/dev/null 2>&1 || true # already installed is fine
./svc.sh start
echo "ok: runner $NAME registered and running (starts at every login of $(id -un))"

step "SSH key and the remote-test agent"
mkdir -p "$HOME/.ssh" "$HOME/haruspex-ci" "$HOME/Library/LaunchAgents"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
for key in "${SSH_KEYS[@]+"${SSH_KEYS[@]}"}"; do
    [[ "$key" == ssh-* || "$key" == ecdsa-* ]] || {
        echo "That does not look like a public key: ${key:0:20}…" >&2
        exit 1
    }
    grep -qxF "$key" "$HOME/.ssh/authorized_keys" || echo "$key" >>"$HOME/.ssh/authorized_keys"
done
[[ -s "$HOME/.ssh/authorized_keys" ]] || echo "warning: no SSH key yet — re-run with --ssh-key \"\$(cat ~/.ssh/id_ed25519.pub)\" from your Linux box's key"
cp "$HERE/agent/ci-remote.sh" "$HERE/agent/run-suite.sh" "$HOME/haruspex-ci/"
chmod +x "$HOME/haruspex-ci/"*.sh
plist="$HOME/Library/LaunchAgents/com.haruspex.ci-run.plist"
cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.haruspex.ci-run</string>
  <key>ProgramArguments</key><array>
    <string>$HOME/haruspex-ci/ci-remote.sh</string><string>run</string>
  </array>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/com.haruspex.ci-run" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "ok: agent installed; remote-test.sh starts suites in this session"

step "No screensaver or screen lock for $(id -un)"
# A locked screen stops UI tests even though the machine is awake.
defaults -currentHost write com.apple.screensaver idleTime -int 0
echo "Turning off the screen lock asks for $(id -un)'s password:"
sysadminctl -screenLock off -password - || echo "warning: could not turn the screen lock off; do it in System Settings → Lock Screen"
echo "ok: screensaver off, no password after the display sleeps"

step "Two permissions macOS will not let a script grant"
cat <<EOF
In System Settings → Privacy & Security, turn these on:
  - Accessibility:    Terminal, and "Xcode Helper" (add it with + if absent;
                      /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/...)
  - Screen Recording: Terminal
The first Appium session also asks for them; approving the prompts works too.
EOF
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" || true

step "Done"
echo "Check it at https://github.com/$REPO/settings/actions/runners — it should say Idle."
cat <<EOF

On your Linux box, add to ~/.ssh/config:
  Host haruspex-mac
      HostName $(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname)
      User $(id -un)
Then:  scripts/ci-runner/remote-test.sh mac
EOF
