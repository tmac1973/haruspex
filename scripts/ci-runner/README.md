# Test machines: the Mac mini and the Windows PC

Two ways to run tests on them, sharing one lock (`~/haruspex-ci/busy`) so they
never collide:

- **From your Linux box, on your working tree as it is now:**
  `scripts/ci-runner/remote-test.sh mac|windows|both [suite]`. SSH carries
  the files and the log. The suite runs in the CI user's desktop session,
  because UI tests need one and an SSH session has none.
- **From GitHub:** a self-hosted Actions runner on each machine, for the
  nightly live suite and `gh workflow run` on pushed code
  (`plan/misc_futures/` phase 14).

These are separate from CI's hosted `windows` and `macos` jobs, which compile
and unit-test on GitHub's machines. Those run only on a PR labelled
`windows-ci` / `macos-ci`, on a manual dispatch, and after a merge to main,
because they take ~15 minutes each.

Suites: `unit` (what CI runs) works now. `e2e-app`, `e2e-mac` and `live` arrive
with phase 14; until then they say so.

## One-time setup

Each machine runs as a dedicated standard user, `haruspex-ci`. Your own account
and its Haruspex data are never touched.

Get the scripts on each machine by cloning the repo, or pulling `main`, from
your own account. This file is `scripts/ci-runner/README.md` there too.

**Always reachable.** By default both scripts keep the machine awake: no sleep
or hibernation, wake on network access, and (Mac) power back on after a power
cut. Part 2 turns off the CI user's screensaver and screen lock, because a
locked desktop stops UI tests. Automatic login (`--auto-login`, `-AutoLogon`)
brings `haruspex-ci` back after an update restart, without a trip to the other
room. Pass `--allow-sleep` / `-AllowSleep` to leave the power settings alone.

**Mac mini**
1. From your admin account:
   `./scripts/ci-runner/macos-1-admin.sh --auto-login`.
   Automatic login needs FileVault off; the script says if it's on.
   If it can't install Xcode from the App Store, it says so; install Xcode,
   then run it again.
2. Log in as `haruspex-ci`, using Fast User Switching so your session stays
   open, and run:
   `/Users/Shared/haruspex-ci/macos-2-runner.sh --ssh-key "<your Linux public key>"`.
   The key is the output of `cat ~/.ssh/id_ed25519.pub` **on your Linux box**:
   the public half, safe to copy across.
3. Turn on the two permissions it opens: Accessibility and Screen Recording.
   macOS doesn't let a script do this.
4. Leave `haruspex-ci` logged in.

**Windows PC**
1. In an Administrator PowerShell:
   `powershell -ExecutionPolicy Bypass -File scripts\ci-runner\windows-1-admin.ps1 -AutoLogon`.
2. Sign in as `haruspex-ci` and run:
   `powershell -ExecutionPolicy Bypass -File C:\Users\Public\haruspex-ci\windows-2-runner.ps1 -SshKey "<your Linux public key>"`.
   The integrated AMD GPU is labelled `igpu`.
3. Leave `haruspex-ci` signed in.

Part 2 on each machine signs the GitHub CLI in through your browser, registers
the runner, and prints the `~/.ssh/config` entry to add on your Linux box
(`haruspex-mac`, `haruspex-win`). After that:

    scripts/ci-runner/remote-test.sh both

## Self-hosted runners on a public repo

A workflow from a pull request can be changed by that pull request, so a
stranger's PR could try to run code on these machines. Two settings keep that
from happening:

- Only `nightly.yml` uses the `haruspex-live` label, and it has no
  `pull_request` trigger.
- **Settings → Actions → General → "Require approval for all external
  contributors".** Then no outside PR runs any workflow until you approve it.
  Set it with:
  `gh api -X PUT repos/tmac1973/haruspex/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors`

To undo: run part 2 with `--uninstall` (macOS) or `-Uninstall` (Windows),
then delete the `haruspex-ci` user.
