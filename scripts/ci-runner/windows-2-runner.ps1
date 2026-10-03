<#
Haruspex live-test runner, Windows part 2 of 2: the runner itself.

Run as haruspex-ci, signed in to its desktop, in a normal PowerShell:
  powershell -ExecutionPolicy Bypass -File C:\Users\Public\haruspex-ci\windows-2-runner.ps1 -SshKey "ssh-ed25519 AAAA... you@linux"

Installs Rust for this user, the agent that runs remote-test.sh's suites on
this desktop, and your public key for SSH; registers a GitHub Actions runner
(labels: self-hosted, haruspex-live, windows, plus igpu or gpu when there is
one) and starts it at every logon of this user, in the desktop session the UI
tests need. Safe to re-run.

  -SshKey       your Linux box's PUBLIC key (cat ~/.ssh/id_ed25519.pub)
  -Gpu          override the detected label (an AMD/Intel integrated GPU is igpu)
  -Reconfigure  register again (e.g. after removing it on GitHub)
  -Uninstall    stop the runner and remove its registration
#>
param(
    [string[]]$SshKey = @(),
    [ValidateSet('auto', 'none', 'igpu', 'gpu')][string]$Gpu = 'auto',
    [switch]$Reconfigure,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$Repo = 'tmac1973/haruspex'
$Name = if ($env:RUNNER_NAME) { $env:RUNNER_NAME } else { 'haruspex-windows' }
$Dir = Join-Path $HOME 'actions-runner'
$TaskName = 'Haruspex CI runner'
$RunTask = 'Haruspex CI run'

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }

if ($env:USERNAME -ne 'haruspex-ci') { throw 'Run this as haruspex-ci (sign in as that user).' }

# winget installed these machine-wide in part 1; a fresh shell may not see them yet.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
    [Environment]::GetEnvironmentVariable('Path', 'User')

function Ensure-GhAuth {
    gh auth status *> $null
    if ($LASTEXITCODE -ne 0) {
        Step 'Sign the GitHub CLI in (a browser opens; the token stays on this machine)'
        gh auth login --hostname github.com --git-protocol https --web
    }
}

if ($Uninstall) {
    Step 'Removing the runner'
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $RunTask -Confirm:$false -ErrorAction SilentlyContinue
    Get-Process Runner.Listener, Runner.Worker -ErrorAction SilentlyContinue | Stop-Process -Force
    Ensure-GhAuth
    $token = gh api -X POST "repos/$Repo/actions/runners/remove-token" -q .token
    & (Join-Path $Dir 'config.cmd') remove --token $token
    Write-Host "ok: removed $Name"
    exit 0
}

Step 'Rust'
$cargo = Join-Path $HOME '.cargo\bin\cargo.exe'
if (-not (Test-Path $cargo)) {
    $init = Join-Path $env:TEMP 'rustup-init.exe'
    Invoke-WebRequest 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -OutFile $init
    & $init -y --profile minimal --component clippy rustfmt
    if ($LASTEXITCODE -ne 0) { throw 'rustup-init failed' }
}
$env:Path = (Join-Path $HOME '.cargo\bin') + ';' + $env:Path
Write-Host "ok: $(cargo --version)"

Step 'Labels'
if ($Gpu -eq 'auto') {
    $names = (Get-CimInstance Win32_VideoController).Name -join '; '
    # Discrete first: an RX/RTX/Arc card. Otherwise an AMD or Intel GPU is the
    # integrated one sharing system RAM.
    # "Arc(TM) Graphics" alone is Intel's integrated GPU; the cards are "Arc(TM) A770" etc.
    $Gpu = if ($names -match 'Radeon RX|GeForce|RTX|Quadro|Arc\(TM\) [AB]\d') { 'gpu' }
           elseif ($names -match 'Radeon|AMD|Intel.*(Graphics|Iris|UHD)') { 'igpu' }
           else { 'none' }
    Write-Host "detected: $names -> $Gpu"
}
$labels = 'haruspex-live,windows'
if ($Gpu -ne 'none') { $labels += ",$Gpu" }
Write-Host "ok: labels self-hosted,$labels"

Step 'GitHub Actions runner'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Set-Location $Dir
if (-not (Test-Path '.\config.cmd')) {
    Ensure-GhAuth
    $tag = gh api repos/actions/runner/releases/latest -q .tag_name
    $ver = $tag.TrimStart('v')
    $zip = "actions-runner-win-x64-$ver.zip"
    gh release download $tag --repo actions/runner --pattern $zip --dir $Dir --clobber
    Expand-Archive -Force (Join-Path $Dir $zip) $Dir
    Remove-Item (Join-Path $Dir $zip)
    Write-Host "ok: runner $ver unpacked"
}
if (-not (Test-Path '.\.runner') -or $Reconfigure) {
    Ensure-GhAuth
    $token = gh api -X POST "repos/$Repo/actions/runners/registration-token" -q .token
    # Not --runasservice: a service has no desktop, and WebView2 needs one.
    .\config.cmd --unattended --replace --url "https://github.com/$Repo" --token $token `
        --name $Name --labels $labels --work _work
    if ($LASTEXITCODE -ne 0) { throw 'runner configuration failed' }
}

Step 'Start the runner at every logon of this user'
$action = New-ScheduledTaskAction -Execute (Join-Path $Dir 'run.cmd') -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
if (-not (Get-Process Runner.Listener -ErrorAction SilentlyContinue)) {
    Start-ScheduledTask -TaskName $TaskName
}
Write-Host "ok: runner $Name running, and starts at every logon of $env:USERNAME"

Step "No screensaver or lock for $env:USERNAME"
# A locked desktop stops UI tests even though the machine is awake.
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaveActive -Value '0'
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaverIsSecure -Value '0'
Write-Host 'ok: screensaver off'

Step 'SSH key and the remote-test agent'
$sshDir = Join-Path $HOME '.ssh'
$keys = Join-Path $sshDir 'authorized_keys'
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
if (-not (Test-Path $keys)) { New-Item -ItemType File -Path $keys | Out-Null }
foreach ($key in $SshKey) {
    if ($key -notmatch '^(ssh-|ecdsa-)') { throw "That does not look like a public key: $($key.Substring(0, [Math]::Min(20, $key.Length)))" }
    if (-not (Select-String -Path $keys -SimpleMatch $key -Quiet)) { Add-Content -Path $keys -Value $key }
}
# sshd ignores a key file others can write to.
icacls $keys /inheritance:r /grant "${env:USERNAME}:F" /grant 'SYSTEM:F' | Out-Null
if ((Get-Item $keys).Length -eq 0) {
    Write-Host 'warning: no SSH key yet - re-run with -SshKey "<contents of ~/.ssh/id_ed25519.pub>"' -ForegroundColor Yellow
}
$agent = Join-Path $HOME 'haruspex-ci'
New-Item -ItemType Directory -Force -Path $agent | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot 'agent\ci-remote.ps1'), (Join-Path $PSScriptRoot 'agent\run-suite.ps1') $agent
# Started on demand by ci-remote.ps1 (schtasks /run), on this desktop.
$runAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$agent\ci-remote.ps1`" -Action run"
$runSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3) -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName $RunTask -Action $runAction -Settings $runSettings `
    -Principal $principal -Force | Out-Null
Write-Host 'ok: agent installed; remote-test.sh starts suites on this desktop'

Step 'Done'
Write-Host "Check it at https://github.com/$Repo/settings/actions/runners - it should say Idle."
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -in 'Dhcp', 'Manual' -and $_.IPAddress -notlike '169.*' } | Select-Object -First 1).IPAddress
Write-Host @"

On your Linux box, add to ~/.ssh/config:
  Host haruspex-win
      HostName $ip
      User $env:USERNAME
Then:  scripts/ci-runner/remote-test.sh windows
"@
