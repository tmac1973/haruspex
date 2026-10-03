# Test machines: the Mac mini and the Windows PC

The Mac and the Windows PC are your own machines, and tests run as **you**, in
your session. Your Haruspex data is never touched:
- the `unit` suite never launches the app;
- the UI suites (phase 14) will run a test build with its own app identifier,
  `com.haruspex.app.e2e`, so it keeps its data in its own folder.

There are two ways to run tests on them. They share one lock
(`~/.haruspex-test/busy`), so they never collide.

- **From your Linux box, against your working tree as it is now:**
  `scripts/ci-runner/remote-test.sh mac|windows|both [suite]`.
  - SSH carries the files and the log.
  - `unit` runs over SSH, so the machine can be locked or nobody signed in.
  - UI suites run on your desktop, so you must be logged in and unlocked, and
    windows will pop up while they run.
- **From GitHub:** a self-hosted Actions runner, for the nightly live suite
  and `gh workflow run` on pushed code (`plan/misc_futures/` phase 14).

Suites:
- `unit`, what CI runs: works now.
- `e2e-app`, `e2e-mac` and `live`: arrive with phase 14; until then they say
  so.

These machines are separate from CI's hosted `windows` and `macos` jobs.
Those compile and unit-test on GitHub's machines, and run only on a PR
labelled `windows-ci` / `macos-ci`, on a manual dispatch, and after a merge
to main.

## Setup: one script per machine, run once, as yourself

Clone the repo, or pull `main`, in your account on each machine. Have your
Linux box's **public** SSH key ready: the output of `cat ~/.ssh/<key>.pub` on
Linux. It's safe to copy anywhere.

**Mac.** In Terminal, as your user (it needs admin rights; system steps ask
for your password through `sudo`):

    ./scripts/ci-runner/setup-macos.sh --ssh-key "<your Linux public key>"

If it can't install Xcode from the App Store, it says so; install Xcode, then
run it again. When it opens System Settings, allow Accessibility and Screen
Recording for Terminal. macOS doesn't let a script do that.

**Windows.** In PowerShell opened with *Run as administrator*, from your own
account:

    powershell -ExecutionPolicy Bypass -File scripts\ci-runner\setup-windows.ps1 -SshKey "<your Linux public key>"

Your account must be the one with admin rights. If elevating asks for a
different administrator, the script stops, because everything it sets up is
per-user.

Each script:
- installs the toolchain;
- turns on SSH with key login;
- installs the agent that runs suites on your desktop;
- signs the GitHub CLI in through your browser, where your password manager
  is available;
- registers the runner (`self-hosted, haruspex-live, macos` /
  `windows, igpu`) to start whenever you log in;
- keeps the machine awake.

Your screen lock and login settings are left alone. Re-running is safe.
`--no-runner` / `-NoRunner` skips the runner. `--uninstall` / `-Uninstall`
removes everything except the build cache in `~/.haruspex-test`.

Each script ends by printing the entry to add to `~/.ssh/config` on your
Linux box (`haruspex-mac`, `haruspex-win`). Then, from Linux:

    scripts/ci-runner/remote-test.sh both

## Security

**The runner runs workflow code as you,** with your files and signed-in
tools. Only code in this repo reaches it:
- Only `nightly.yml` will use the `haruspex-live` label, and it has no
  `pull_request` trigger.
- No outside contributor's PR runs any workflow until you approve it. The
  fork-PR approval policy is `all_external_contributors`.

Approve outside PRs only after reading what they change in `.github/`.
