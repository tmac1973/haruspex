<#
Haruspex live-test runner, Windows part 1 of 2: machine-wide setup.

Run in an ADMINISTRATOR PowerShell on the Windows machine:
  powershell -ExecutionPolicy Bypass -File scripts\ci-runner\windows-1-admin.ps1 [-AutoLogon] [-AllowSleep]

Installs Git, Node 22, the GitHub CLI, the Visual Studio C++ build tools,
WebView2 and the OpenSSH server (for remote-test.sh on your Linux box), and
creates the `haruspex-ci` user the runner works as. Then log in as
haruspex-ci and run part 2. Safe to re-run: every step skips what is already
done.

By default the PC never sleeps or hibernates and asks for no sign-in when the
display wakes, so it is always there for remote-test.sh and the nightly run.

  -AutoLogon   log haruspex-ci in automatically at boot (Sysinternals Autologon;
               the password is stored as an LSA secret, not in plain text), so
               an update restart comes back ready to test. Recommended.
  -AllowSleep  leave the power settings alone
#>
#Requires -RunAsAdministrator
param(
    [switch]$AutoLogon,
    [switch]$AllowSleep,
    [switch]$KeepAwake  # the default now; accepted for old instructions
)
$ErrorActionPreference = 'Stop'
$CiUser = 'haruspex-ci'
$Shared = 'C:\Users\Public\haruspex-ci'
$todo = @()

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }

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

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'winget is missing. Install "App Installer" from the Microsoft Store, then re-run.'
}

Step 'Git, Node, the GitHub CLI, WebView2'
Install-WingetPackage 'Git.Git'
# Node 22 to match CI; the LTS package when winget has no 22-pinned one.
winget show --id OpenJS.NodeJS.22 --exact --accept-source-agreements *> $null
if ($LASTEXITCODE -eq 0) { Install-WingetPackage 'OpenJS.NodeJS.22' } else { Install-WingetPackage 'OpenJS.NodeJS.LTS' }
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { $todo += "Node is v$nodeMajor; the build needs 22 or newer." }
Install-WingetPackage 'GitHub.cli'
Install-WingetPackage 'Microsoft.EdgeWebView2Runtime'

Step 'Visual Studio 2022 Build Tools (C++), which Rust needs to link'
Install-WingetPackage 'Microsoft.VisualStudio.2022.BuildTools' `
    '--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'

Step "The $CiUser user"
if (Get-LocalUser -Name $CiUser -ErrorAction SilentlyContinue) {
    Write-Host "ok: $CiUser already exists"
    if ($AutoLogon) { $password = Read-Host "Password of $CiUser (for auto-logon)" -AsSecureString }
} else {
    $password = Read-Host "Choose a password for $CiUser" -AsSecureString
    New-LocalUser -Name $CiUser -Password $password -FullName 'Haruspex CI' `
        -Description 'Runs the Haruspex nightly live tests' -PasswordNeverExpires | Out-Null
    Add-LocalGroupMember -Group 'Users' -Member $CiUser
    Write-Host "ok: created $CiUser (a standard user, not an administrator)"
}

Step 'OpenSSH server, for remote-test.sh on your Linux box'
$sshd = Get-WindowsCapability -Online -Name 'OpenSSH.Server*'
if ($sshd.State -ne 'Installed') { Add-WindowsCapability -Online -Name $sshd.Name | Out-Null }
Set-Service sshd -StartupType Automatic
Start-Service sshd
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
        -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Private | Out-Null
}
Write-Host 'ok: sshd running at boot, port 22 open on private networks (key login set up in part 2)'

Step "Part 2 and the agent, where $CiUser can reach them"
if (Test-Path $Shared) { Remove-Item -Recurse -Force $Shared }
New-Item -ItemType Directory -Force -Path $Shared | Out-Null
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot '*') $Shared
Write-Host "ok: $Shared"

if ($AutoLogon) {
    Step "Automatic logon as $CiUser"
    $zip = Join-Path $env:TEMP 'AutoLogon.zip'
    Invoke-WebRequest 'https://download.sysinternals.com/files/AutoLogon.zip' -OutFile $zip
    Expand-Archive -Force $zip (Join-Path $env:TEMP 'AutoLogon')
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password))
    & (Join-Path $env:TEMP 'AutoLogon\Autologon64.exe') $CiUser $env:COMPUTERNAME $plain /accepteula
    Remove-Variable plain
    Write-Host "ok: Windows will log in as $CiUser at boot"
}

if (-not $AllowSleep) {
    Step 'Always awake'
    foreach ($kind in 'standby-timeout', 'hibernate-timeout') {
        powercfg /change "$kind-ac" 0
        powercfg /change "$kind-dc" 0
    }
    # Also turns off Fast Startup, whose half-shutdown skips the logon the
    # runner starts at.
    powercfg /hibernate off
    # No sign-in prompt when the display wakes; a locked desktop stops UI tests.
    powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
    powercfg /setdcvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
    powercfg /setactive SCHEME_CURRENT
    Unregister-ScheduledTask -TaskName 'Haruspex CI wake' -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host 'ok: never sleeps or hibernates; no sign-in when the display wakes'
}

Step 'Graphics'
Get-CimInstance Win32_VideoController | ForEach-Object { Write-Host "  $($_.Name)" }
Write-Host '  Part 2 labels the runner igpu or gpu from this; pass -Gpu none|igpu|gpu to override.'

Step 'Done'
if (-not $AutoLogon) {
    $todo += "After a restart (Windows Update), sign $CiUser in again, or re-run with -AutoLogon so it happens by itself."
}
foreach ($t in $todo) { Write-Host "Still to do: $t" -ForegroundColor Yellow }
Write-Host @"
Next:
  1. Sign in as $CiUser (Switch user keeps your own session open).
  2. In PowerShell, as ${CiUser}:
       powershell -ExecutionPolicy Bypass -File $Shared\windows-2-runner.ps1
  3. Leave $CiUser signed in. WebView2 and the UI tests need its desktop.
"@
