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

**No Apple account needed.** Apple's Command Line Tools, which Homebrew
installs, are enough for building, the `unit` suite and the
launch/kill/relaunch checks. Only the scripted UI tests (`e2e-mac`) need full
Xcode, which the App Store won't give out without an Apple account.

To add those later, run it again with `--with-xcode`. It installs Xcode and
Appium's Mac2 driver, then opens System Settings so you can allow
Accessibility and Screen Recording for Terminal. macOS doesn't let a script do
that.

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

## Undoing the old two-script setup

An earlier version (in #253) set the machines up with a separate
`haruspex-ci` user. If you ran it, clean up before running the new script.
No runner was ever registered on GitHub, so there's nothing to remove there.

**Windows,** in PowerShell opened with *Run as administrator*:

```powershell
# 1. The user, and its profile folder if it ever signed in
Remove-LocalUser haruspex-ci
Get-CimInstance Win32_UserProfile | Where-Object LocalPath -like '*\haruspex-ci' | Remove-CimInstance

# 2. The scripts the old part 1 copied out
Remove-Item -Recurse -Force C:\Users\Public\haruspex-ci

# 3. Only if you used -AutoLogon: stop Windows signing haruspex-ci in at boot
Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' AutoAdminLogon '0'
```

After step 3, also run `Autologon64.exe` from your Temp folder
(`%TEMP%\AutoLogon`) once and click **Disable**. That clears the stored
password.

If you used `-KeepAwake`, the old script also turned off the sign-in prompt
when the display wakes. The new script leaves your lock alone, so put it
back:

```powershell
powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 1
powercfg /setdcvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 1
powercfg /setactive SCHEME_CURRENT
```

**Keep these:** Git, Node, the GitHub CLI, the VS Build Tools, WebView2, and
the OpenSSH server and its firewall rule. Also keep the no-sleep settings.
The new script uses all of them and skips what's already installed.

**Mac:**

```bash
sudo sysadminctl -deleteUser haruspex-ci
sudo rm -rf /Users/Shared/haruspex-ci
sudo sysadminctl -autologin off    # only if you used --auto-login
```

The old Mac script also limited Remote Login to you and `haruspex-ci`.
Deleting the user leaves just you, which is what the new script sets up.
