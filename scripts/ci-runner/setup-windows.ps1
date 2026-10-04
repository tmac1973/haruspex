<#
Set up this PC as a Haruspex test machine. Run it once, from YOUR account, in
PowerShell opened with "Run as administrator" (your account needs admin
rights):

  powershell -ExecutionPolicy Bypass -File scripts\ci-runner\setup-windows.ps1 -SshKey "<your Linux public key>"

Installs Git, Node 22, the GitHub CLI, the Visual Studio C++ build tools,
WebView2, Rust and the OpenSSH server; installs the agent that runs
remote-test.sh's suites on your desktop; registers a GitHub Actions runner
(self-hosted, haruspex-live, windows, plus igpu or gpu) that starts when you
sign in; and keeps the PC awake. Safe to re-run.

Tests run as you, on your desktop. The test build of Haruspex has its own app
identifier, so your own Haruspex data is never touched.

  -SshKey      your Linux box's PUBLIC key (`cat ~/.ssh/<key>.pub` there)
  -Gpu         override the detected label: none, igpu or gpu
  -NoRunner    skip the GitHub runner (remote-test.sh only)
  -AllowSleep  leave the power settings alone
  -Uninstall   remove the runner, the agent and the tasks
#>
#Requires -RunAsAdministrator
param(
    [string[]]$SshKey = @(),
    [ValidateSet('auto', 'none', 'igpu', 'gpu')][string]$Gpu = 'auto',
    [switch]$NoRunner,
    [switch]$AllowSleep,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$Repo = 'tmac1973/haruspex'
$Name = if ($env:RUNNER_NAME) { $env:RUNNER_NAME } else { 'haruspex-windows' }
$Test = Join-Path $HOME '.haruspex-test'
$Runner = Join-Path $Test 'actions-runner'
$RunnerTask = 'Haruspex test runner'
$RunTask = 'Haruspex test run'
$Me = "$env:USERDOMAIN\$env:USERNAME"
$todo = @()

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
        [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Join-Path $HOME '.cargo\bin')
}

function Ensure-GhAuth {
    gh auth status *> $null
    if ($LASTEXITCODE -ne 0) {
        Step 'Sign the GitHub CLI in (a browser opens; the token stays in your credential store)'
        gh auth login --hostname github.com --git-protocol https --web
    }
}

function Install-WingetPackage($id, $override = $null) {
    $installed = winget list --id $id --exact --accept-source-agreements 2>$null | Select-String -SimpleMatch $id
    if ($installed) { Write-Host "ok: $id already installed"; return }
    $wingetArgs = @('install', '--id', $id, '--exact', '--silent',
        '--accept-source-agreements', '--accept-package-agreements')
    if ($override) { $wingetArgs += @('--override', $override) }
    winget @wingetArgs
    if ($LASTEXITCODE -ne 0) { throw "winget could not install $id (exit $LASTEXITCODE)" }
    Write-Host "ok: installed $id"
}

# Elevation must not have switched accounts: the per-user parts (Rust, the
# tasks, the runner) go in $HOME and must be yours.
$console = (Get-CimInstance Win32_ComputerSystem).UserName
if ($console -and $console -ne $Me) {
    throw "This PowerShell runs as $Me, but $console is signed in. Run it from your own account (make that account an administrator), not as a separate admin user."
}

if ($Uninstall) {
    Step 'Removing the runner, the agent and the tasks'
    Refresh-Path
    Unregister-ScheduledTask -TaskName $RunnerTask -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $RunTask -Confirm:$false -ErrorAction SilentlyContinue
    Get-Process Runner.Listener, Runner.Worker -ErrorAction SilentlyContinue | Stop-Process -Force
    if (Test-Path (Join-Path $Runner '.runner')) {
        Ensure-GhAuth
        $token = gh api -X POST "repos/$Repo/actions/runners/remove-token" -q .token
        & (Join-Path $Runner 'config.cmd') remove --token $token
    }
    Write-Host "ok: removed. $Test holds build caches; delete it if you like."
    exit 0
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'winget is missing. Install "App Installer" from the Microsoft Store, then re-run.'
}

Step 'Git, Node 22, the GitHub CLI, WebView2'
Install-WingetPackage 'Git.Git'
winget show --id OpenJS.NodeJS.22 --exact --accept-source-agreements *> $null
if ($LASTEXITCODE -eq 0) { Install-WingetPackage 'OpenJS.NodeJS.22' } else { Install-WingetPackage 'OpenJS.NodeJS.LTS' }
Install-WingetPackage 'GitHub.cli'
Install-WingetPackage 'Microsoft.EdgeWebView2Runtime'
Refresh-Path
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { $todo += "Node is v$nodeMajor; the build needs 22 or newer." }

Step 'Visual Studio 2022 Build Tools (C++), which Rust needs to link'
Install-WingetPackage 'Microsoft.VisualStudio.2022.BuildTools' `
    '--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'

Step 'Rust'
if (-not (Test-Path (Join-Path $HOME '.cargo\bin\cargo.exe'))) {
    $init = Join-Path $env:TEMP 'rustup-init.exe'
    Invoke-WebRequest 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -OutFile $init
    & $init -y --profile minimal --component clippy rustfmt
    if ($LASTEXITCODE -ne 0) { throw 'rustup-init failed' }
}
Refresh-Path
Write-Host "ok: $(cargo --version)"

Step 'OpenSSH server, for remote-test.sh on your Linux box'
$sshd = Get-WindowsCapability -Online -Name 'OpenSSH.Server*'
if ($sshd.State -ne 'Installed') { Add-WindowsCapability -Online -Name $sshd.Name | Out-Null }
Set-Service sshd -StartupType Automatic
Start-Service sshd
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
        -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Private | Out-Null
}
# For an administrator, Windows' sshd reads keys from ProgramData, not ~\.ssh,
# and only when that file is writable by Administrators and SYSTEM alone.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
$keys = if ($isAdmin) { 'C:\ProgramData\ssh\administrators_authorized_keys' } else { Join-Path $HOME '.ssh\authorized_keys' }
New-Item -ItemType Directory -Force -Path (Split-Path $keys) | Out-Null
if (-not (Test-Path $keys)) { New-Item -ItemType File -Path $keys | Out-Null }
foreach ($key in $SshKey) {
    if ($key -notmatch '^(ssh-|ecdsa-)') { throw "That does not look like a public key: $($key.Substring(0, [Math]::Min(20, $key.Length)))" }
    if (-not (Select-String -Path $keys -SimpleMatch $key -Quiet)) { Add-Content -Path $keys -Value $key }
}
if ($isAdmin) {
    icacls $keys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
} else {
    icacls $keys /inheritance:r /grant "${Me}:F" /grant 'SYSTEM:F' | Out-Null
}
if ((Get-Item $keys).Length -eq 0) { $todo += 'Add your Linux public key: re-run with -SshKey "<key>".' }
Write-Host "ok: sshd running at boot; your keys in $keys"

Step 'The remote-test agent'
New-Item -ItemType Directory -Force -Path $Test | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot 'agent\ci-remote.ps1'), (Join-Path $PSScriptRoot 'agent\run-suite.ps1') $Test
# On your desktop session, started on demand by ci-remote.ps1 (schtasks /run).
$principal = New-ScheduledTaskPrincipal -UserId $Me -LogonType Interactive
$runAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$Test\ci-remote.ps1`" -Action run"
$runSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3) -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName $RunTask -Action $runAction -Settings $runSettings `
    -Principal $principal -Force | Out-Null
Write-Host 'ok: suites from remote-test.sh run on your desktop'

if (-not $NoRunner) {
    Step 'GitHub Actions runner'
    if ($Gpu -eq 'auto') {
        $names = (Get-CimInstance Win32_VideoController).Name -join '; '
        # Discrete cards first. "Arc(TM) Graphics" alone is Intel's integrated GPU.
        $Gpu = if ($names -match 'Radeon RX|GeForce|RTX|Quadro|Arc\(TM\) [AB]\d') { 'gpu' }
               elseif ($names -match 'Radeon|AMD|Intel.*(Graphics|Iris|UHD)') { 'igpu' }
               else { 'none' }
        Write-Host "graphics: $names -> $Gpu"
    }
    $labels = 'haruspex-live,windows'
    if ($Gpu -ne 'none') { $labels += ",$Gpu" }
    Ensure-GhAuth
    New-Item -ItemType Directory -Force -Path $Runner | Out-Null
    Push-Location $Runner
    if (-not (Test-Path '.\config.cmd')) {
        $tag = gh api repos/actions/runner/releases/latest -q .tag_name
        $ver = $tag.TrimStart('v')
        $zip = "actions-runner-win-x64-$ver.zip"
        gh release download $tag --repo actions/runner --pattern $zip --dir $Runner --clobber
        Expand-Archive -Force (Join-Path $Runner $zip) $Runner
        Remove-Item (Join-Path $Runner $zip)
    }
    if (-not (Test-Path '.\.runner')) {
        $token = gh api -X POST "repos/$Repo/actions/runners/registration-token" -q .token
        # Not --runasservice: a service has no desktop, and WebView2 needs one.
        .\config.cmd --unattended --replace --url "https://github.com/$Repo" --token $token `
            --name $Name --labels $labels --work _work
        if ($LASTEXITCODE -ne 0) { throw 'runner configuration failed' }
    }
    Pop-Location
    $action = New-ScheduledTaskAction -Execute (Join-Path $Runner 'run.cmd') -WorkingDirectory $Runner
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Me
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries
    Register-ScheduledTask -TaskName $RunnerTask -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force | Out-Null
    if (-not (Get-Process Runner.Listener -ErrorAction SilentlyContinue)) { Start-ScheduledTask -TaskName $RunnerTask }
    Write-Host "ok: runner $Name (self-hosted,$labels) running; it starts whenever you sign in"
}

if (-not $AllowSleep) {
    Step 'Always awake'
    foreach ($kind in 'standby-timeout', 'hibernate-timeout') {
        powercfg /change "$kind-ac" 0
        powercfg /change "$kind-dc" 0
    }
    # Also turns off Fast Startup, whose half-shutdown skips the sign-in the
    # runner starts at.
    powercfg /hibernate off
    Write-Host 'ok: never sleeps or hibernates (the display still turns off, and your lock screen is unchanged)'
}

Step 'Done'
foreach ($t in $todo) { Write-Host "Still to do: $t" -ForegroundColor Yellow }
# The interface carrying the default route. The first IPv4 address can be a
# WSL or Hyper-V virtual switch (172.16-31.x) that nothing else can reach.
$route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Sort-Object RouteMetric | Select-Object -First 1
$ip = if ($route) {
    (Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex | Select-Object -First 1).IPAddress
} else { '?' }
Write-Host @"
This PC: hostname $env:COMPUTERNAME, address $ip
On your Linux box, add to ~/.ssh/config (the hostname survives a new DHCP
lease if your DNS registers DHCP clients; otherwise use the address):
  Host haruspex-win
      HostName $env:COMPUTERNAME
      User $env:USERNAME
      IdentityFile ~/.ssh/<the key you added>
Then:  scripts/ci-runner/remote-test.sh windows

UI suites need you signed in; the unit suite needs only that the PC is on.
"@
