#!/usr/bin/env bash
# Haruspex live-test runner, macOS part 1 of 2: machine-wide setup.
#
# Run from an ADMIN account on the Mac mini:
#   ./scripts/ci-runner/macos-1-admin.sh [--auto-login] [--allow-sleep]
#
# Installs Homebrew, Node 22, the GitHub CLI and (if it can) Xcode, enables UI
# automation, turns on Remote Login (SSH) for the CI user, and creates the
# `haruspex-ci` user the runner works as. Then log in as haruspex-ci and run
# part 2. Safe to re-run: every step skips what is already done.
#
# By default the Mac never sleeps, wakes on network access and powers back on
# after a power cut, so it is always there for remote-test.sh and the nightly
# run.
#
#   --auto-login   log haruspex-ci in at boot, so a restart (an update, a power
#                  cut) comes back ready to test. Needs FileVault off.
#   --allow-sleep  leave the power settings alone

set -euo pipefail

CI_USER=haruspex-ci
SHARED=/Users/Shared/haruspex-ci
KEEP_AWAKE=1
AUTO_LOGIN=0
for arg in "$@"; do
    case "$arg" in
        --allow-sleep) KEEP_AWAKE=0 ;;
        --auto-login) AUTO_LOGIN=1 ;;
        --keep-awake) ;; # the default now; accepted for old instructions
        -h | --help)
            sed -n '2,19p' "$0"
            exit 0
            ;;
        *)
            echo "unknown option: $arg" >&2
            exit 2
            ;;
    esac
done

step() { printf '\n==> %s\n' "$*"; }
todo=()

[[ "$(uname -s)" == Darwin ]] || {
    echo "This is the macOS script." >&2
    exit 1
}
[[ "$(uname -m)" == arm64 ]] || echo "warning: not Apple Silicon; the runner will be x64."
id -Gn | grep -qw admin || {
    echo "Run this from an admin account (it uses sudo)." >&2
    exit 1
}
sudo -v

step "Homebrew"
if ! command -v brew >/dev/null 2>&1 && [[ ! -x /opt/homebrew/bin/brew ]]; then
    NONINTERACTIVE=1 /bin/bash -c \
        "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
echo "ok: $(brew --version | head -1)"

step "Node 22 and the GitHub CLI"
brew install node@22 gh
# node@22 is keg-only; link it so `node` on PATH is 22 for every user.
brew link --overwrite --force node@22 >/dev/null
echo "ok: node $(node -v), $(gh --version | head -1)"

step "Xcode (the Appium Mac2 driver needs the full app, not just the command-line tools)"
if [[ ! -d /Applications/Xcode.app ]]; then
    brew install mas
    if mas install 497799835; then
        echo "ok: Xcode installed from the App Store"
    else
        todo+=("Install Xcode from the App Store (sign in to the App Store first), then re-run this script.")
    fi
fi
if [[ -d /Applications/Xcode.app ]]; then
    sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
    sudo xcodebuild -license accept
    sudo xcodebuild -runFirstLaunch
    # Lets XCTest drive the UI without a password prompt on every session.
    sudo automationmodetool enable-automationmode-without-authentication
    echo "ok: $(xcodebuild -version | head -1), UI automation enabled"
fi

step "The $CI_USER user"
if id "$CI_USER" >/dev/null 2>&1; then
    echo "ok: $CI_USER already exists"
else
    read -rsp "Choose a password for $CI_USER (you will log in with it once): " pw
    echo
    read -rsp "Again: " pw2
    echo
    [[ "$pw" == "$pw2" && -n "$pw" ]] || {
        echo "Passwords did not match." >&2
        exit 1
    }
    sudo sysadminctl -addUser "$CI_USER" -fullName "Haruspex CI" -password "$pw" \
        -home "/Users/$CI_USER"
    sudo createhomedir -c -u "$CI_USER" >/dev/null
    unset pw pw2
    echo "ok: created $CI_USER (a standard user, not an admin)"
fi

step "Remote Login (SSH), for remote-test.sh on your Linux box"
if sudo systemsetup -getremotelogin 2>/dev/null | grep -q ': On'; then
    echo "ok: Remote Login already on"
else
    # Restrict it to the CI user and you, created before turning it on so
    # it never opens to every account.
    sudo dseditgroup -o create -q com.apple.access_ssh 2>/dev/null || true
    sudo dseditgroup -o edit -a "$CI_USER" -t user com.apple.access_ssh
    sudo dseditgroup -o edit -a "$(id -un)" -t user com.apple.access_ssh
    sudo launchctl enable system/com.openssh.sshd
    sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist 2>/dev/null || true
    echo "ok: Remote Login on, for $CI_USER and $(id -un) only (key login set up in part 2)"
fi

step "Part 2 and the agent, where $CI_USER can reach them"
sudo rm -rf "$SHARED"
sudo mkdir -p "$SHARED"
sudo cp -R "$(dirname "$0")/." "$SHARED/"
sudo chmod -R a+rX "$SHARED"
echo "ok: $SHARED"

if [[ $KEEP_AWAKE == 1 ]]; then
    step "Always awake"
    # The display may sleep; the machine never does. womp: wake for network
    # access. autorestart: power on again after a power cut.
    sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1
    sudo systemsetup -setrestartfreeze on >/dev/null 2>&1 || true
    echo "ok: never sleeps, wakes for the network, restarts after a power cut or a freeze"
fi

if [[ $AUTO_LOGIN == 1 ]]; then
    step "Log $CI_USER in at boot"
    if fdesetup status | grep -q 'On'; then
        todo+=("Automatic login needs FileVault off (System Settings → Privacy & Security → FileVault); then re-run with --auto-login.")
    else
        echo "Automatic login stores $CI_USER's password; enter it:"
        if sudo sysadminctl -autologin set -userName "$CI_USER" -password -; then
            echo "ok: $CI_USER logs in at boot"
        else
            todo+=("Set automatic login by hand: System Settings → Users & Groups → Automatically log in as → $CI_USER.")
        fi
    fi
fi

step "Done"
if ((${#todo[@]})); then
    printf 'Still to do:\n'
    printf '  - %s\n' "${todo[@]}"
fi
cat <<EOF
Next:
  1. Log in as $CI_USER (Fast User Switching keeps your own session open).
  2. In Terminal, as $CI_USER:  $SHARED/macos-2-runner.sh
  3. Leave $CI_USER logged in. The UI tests need its desktop session.
EOF
