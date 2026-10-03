#!/usr/bin/env bash
# Set up this Mac as a Haruspex test machine. Run it once, as yourself (an
# admin user; system-wide steps use sudo):
#
#   ./scripts/ci-runner/setup-macos.sh --ssh-key "<your Linux public key>"
#
# Installs Homebrew, Node 22, the GitHub CLI, Xcode (if the App Store allows),
# Rust and Appium with the Mac2 driver; turns on Remote Login for you only;
# installs the agent that runs remote-test.sh's suites in your desktop
# session; registers a GitHub Actions runner (self-hosted, haruspex-live,
# macos) that starts when you log in; and keeps the Mac awake. Safe to re-run.
#
# Tests run as you, in your session. The test build of Haruspex has its own
# app identifier, so your own Haruspex data is never touched.
#
#   --ssh-key KEY  your Linux box's PUBLIC key (`cat ~/.ssh/<key>.pub` there);
#                  repeat to add more
#   --no-runner    skip the GitHub runner (remote-test.sh only)
#   --allow-sleep  leave the power settings alone
#   --uninstall    remove the runner and the agent

set -euo pipefail

REPO=tmac1973/haruspex
NAME=${RUNNER_NAME:-haruspex-mac}
LABELS=haruspex-live,macos
HERE="$(cd "$(dirname "$0")" && pwd)"
TEST="$HOME/.haruspex-test"
RUNNER="$TEST/actions-runner"
AGENT_LABEL=com.haruspex.test-run
SSH_KEYS=()
RUNNER_WANTED=1
KEEP_AWAKE=1
MODE=install
while (($#)); do
    case "$1" in
        --ssh-key)
            SSH_KEYS+=("${2:?--ssh-key needs the key}")
            shift
            ;;
        --no-runner) RUNNER_WANTED=0 ;;
        --allow-sleep) KEEP_AWAKE=0 ;;
        --uninstall) MODE=uninstall ;;
        -h | --help)
            sed -n '2,22p' "$0"
            exit 0
            ;;
        *)
            echo "unknown option: $1" >&2
            exit 2
            ;;
    esac
    shift
done

step() { printf '\n==> %s\n' "$*"; }
todo=()

[[ "$(uname -s)" == Darwin ]] || {
    echo "This is the macOS script." >&2
    exit 1
}
id -Gn | grep -qw admin || {
    echo "Your user needs admin rights for the system-wide steps (sudo)." >&2
    exit 1
}

brew_env() { eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"; }

ensure_gh_auth() {
    if ! gh auth status >/dev/null 2>&1; then
        step "Sign the GitHub CLI in (a browser opens; the token stays in your keychain)"
        gh auth login --hostname github.com --git-protocol https --web
    fi
}

if [[ $MODE == uninstall ]]; then
    brew_env
    if [[ -x "$RUNNER/svc.sh" ]]; then
        step "Removing the runner"
        (cd "$RUNNER" && ./svc.sh stop || true && ./svc.sh uninstall || true)
        ensure_gh_auth
        (cd "$RUNNER" && ./config.sh remove --token \
            "$(gh api -X POST "repos/$REPO/actions/runners/remove-token" -q .token)")
    fi
    launchctl bootout "gui/$(id -u)/$AGENT_LABEL" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
    echo "ok: runner and agent removed. $TEST holds build caches; delete it if you like."
    exit 0
fi

sudo -v

step "Homebrew"
if ! command -v brew >/dev/null 2>&1 && [[ ! -x /opt/homebrew/bin/brew ]]; then
    NONINTERACTIVE=1 /bin/bash -c \
        "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
brew_env
echo "ok: $(brew --version | head -1)"

step "Node 22 and the GitHub CLI"
brew install node@22 gh
brew link --overwrite --force node@22 >/dev/null # keg-only otherwise
echo "ok: node $(node -v), $(gh --version | head -1)"

step "Xcode (Appium's Mac2 driver needs the full app)"
if [[ ! -d /Applications/Xcode.app ]]; then
    brew install mas
    mas install 497799835 ||
        todo+=("Install Xcode from the App Store, then re-run this script.")
fi
if [[ -d /Applications/Xcode.app ]]; then
    sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
    sudo xcodebuild -license accept
    sudo xcodebuild -runFirstLaunch
    # XCTest drives the UI without a password prompt on every session.
    sudo automationmodetool enable-automationmode-without-authentication
    echo "ok: $(xcodebuild -version | head -1), UI automation enabled"
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
# A per-user npm prefix, so a global install needs no sudo.
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
command -v appium >/dev/null 2>&1 || npm install -g appium
if appium driver list --installed 2>&1 | grep -q mac2; then
    appium driver update mac2 >/dev/null 2>&1 || true
else
    appium driver install mac2
fi
echo "ok: appium $(appium --version), mac2 driver"

step "Remote Login (SSH), for remote-test.sh on your Linux box"
if sudo systemsetup -getremotelogin 2>/dev/null | grep -q ': On'; then
    echo "ok: Remote Login already on"
else
    # Restricted to you, set before turning it on so it never opens to all.
    sudo dseditgroup -o create -q com.apple.access_ssh 2>/dev/null || true
    sudo dseditgroup -o edit -a "$(id -un)" -t user com.apple.access_ssh
    sudo launchctl enable system/com.openssh.sshd
    sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist 2>/dev/null || true
    echo "ok: Remote Login on, for $(id -un) only"
fi
mkdir -p "$HOME/.ssh"
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
[[ ${#SSH_KEYS[@]} -gt 0 ]] ||
    todo+=("Add your Linux box's key: from Linux, ssh-copy-id -i ~/.ssh/<key>.pub $(id -un)@<this Mac>, or re-run with --ssh-key.")

step "The remote-test agent"
mkdir -p "$TEST" "$HOME/Library/LaunchAgents"
cp "$HERE/agent/ci-remote.sh" "$HERE/agent/run-suite.sh" "$TEST/"
chmod +x "$TEST/"*.sh
plist="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$AGENT_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$TEST/ci-remote.sh</string><string>run</string>
  </array>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$AGENT_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "ok: suites from remote-test.sh run in your session"

if [[ $RUNNER_WANTED == 1 ]]; then
    step "GitHub Actions runner"
    ensure_gh_auth
    mkdir -p "$RUNNER"
    cd "$RUNNER"
    if [[ ! -x ./config.sh ]]; then
        arch=$([[ "$(uname -m)" == arm64 ]] && echo arm64 || echo x64)
        tag=$(gh api repos/actions/runner/releases/latest -q .tag_name)
        ver=${tag#v}
        gh release download "$tag" --repo actions/runner \
            --pattern "actions-runner-osx-${arch}-${ver}.tar.gz" --dir "$RUNNER" --clobber
        tar xzf "actions-runner-osx-${arch}-${ver}.tar.gz"
        rm "actions-runner-osx-${arch}-${ver}.tar.gz"
    fi
    run_path="$HOME/.npm-global/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    export PATH="$run_path"
    if [[ ! -f .runner ]]; then
        token=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" -q .token)
        ./config.sh --unattended --replace --url "https://github.com/$REPO" --token "$token" \
            --name "$NAME" --labels "$LABELS" --work _work
    fi
    # launchd starts the service with a minimal PATH; the runner reads this.
    echo "$run_path" >.path
    ./svc.sh install >/dev/null 2>&1 || true # already installed is fine
    ./svc.sh start
    cd - >/dev/null
    echo "ok: runner $NAME running; it starts whenever you log in"
fi

if [[ $KEEP_AWAKE == 1 ]]; then
    step "Always awake"
    # The display may sleep; the Mac never does. womp: wake for network
    # access. autorestart: power on again after a power cut.
    sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1
    sudo systemsetup -setrestartfreeze on >/dev/null 2>&1 || true
    echo "ok: never sleeps, wakes for the network, restarts after a power cut"
fi

step "Two permissions macOS will not let a script grant"
cat <<EOF
System Settings → Privacy & Security:
  - Accessibility:    Terminal, and "Xcode Helper" if listed
  - Screen Recording: Terminal
The first UI test also asks; approving the prompts works too.
EOF
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" || true

step "Done"
if ((${#todo[@]})); then
    printf 'Still to do:\n'
    printf '  - %s\n' "${todo[@]}"
fi
cat <<EOF
On your Linux box, add to ~/.ssh/config:
  Host haruspex-mac
      HostName $(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname)
      User $(id -un)
      IdentityFile ~/.ssh/<the key you added>
Then:  scripts/ci-runner/remote-test.sh mac

UI suites need your session unlocked while they run; the unit suite does not.
EOF
