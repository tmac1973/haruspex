<#
.SYNOPSIS
    Installs everything needed to build Haruspex from source on a fresh
    Windows 11 machine.

.DESCRIPTION
    Uses winget to install the system prerequisites: Git (+ Git Bash),
    Node.js LTS, Rust (MSVC toolchain), Visual Studio 2022 Build Tools
    with the C++ workload, CMake, the Vulkan SDK, and the WebView2
    runtime. Each package is skipped if already present. After the
    prerequisites are installed, you start a NEW terminal (so PATH
    picks up the changes), clone the repo, and run `dev-setup.sh`
    under Git Bash — it auto-detects the Windows target and builds
    the llama-server / whisper-server / koko sidecars natively.

.NOTES
    - winget is required. Windows 11 22H2+ ships it; if yours is
      missing, install "App Installer" from the Microsoft Store.
    - Several installers (notably VS Build Tools) will request admin
      via UAC. Accept the prompt when it appears. You do NOT need to
      launch this script from an elevated PowerShell — UAC elevation
      per package is enough.
    - Expect 15-30 minutes end-to-end on a cold machine. VS Build
      Tools is the longest individual step (~5-10 GB download).

.EXAMPLE
    # From a regular PowerShell window:
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
    .\scripts\windows-setup.ps1

.EXAMPLE
    # Skip a package that's already handled some other way:
    .\scripts\windows-setup.ps1 -SkipVulkan -SkipBuildTools
#>

[CmdletBinding()]
param(
    [switch]$SkipGit,
    [switch]$SkipNode,
    [switch]$SkipRust,
    [switch]$SkipBuildTools,
    [switch]$SkipCMake,
    [switch]$SkipVulkan,
    [switch]$SkipWebView2
)

$ErrorActionPreference = 'Stop'

function Write-Header {
    param([string]$Text)
    Write-Host ""
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host "================================================" -ForegroundColor Cyan
}

function Write-Step {
    param([string]$Text)
    Write-Host ">> $Text" -ForegroundColor Yellow
}

function Write-OK {
    param([string]$Text)
    Write-Host "   [OK] $Text" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Text)
    Write-Host "   [WARN] $Text" -ForegroundColor DarkYellow
}

function Write-Err {
    param([string]$Text)
    Write-Host "   [ERR] $Text" -ForegroundColor Red
}

# Check if a winget package is already installed. We match on package id
# rather than trying to probe PATH because PATH updates only apply to
# future shells, so a freshly-installed package looks "missing" in the
# current session even though it was just installed.
function Test-WingetPackage {
    param([string]$Id)
    $output = winget list --id $Id --exact --accept-source-agreements 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    # winget list prints a table when the package is found, a "No installed
    # package found" message otherwise. The table path ALWAYS includes the
    # exact id string on one of the data lines.
    return ($output -match [regex]::Escape($Id))
}

function Install-WingetPackage {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$DisplayName,
        [string]$OverrideArgs = $null
    )

    Write-Step "Checking $DisplayName ($Id)..."
    if (Test-WingetPackage -Id $Id) {
        Write-OK "$DisplayName already installed."
        return
    }

    Write-Host "   Installing $DisplayName via winget..." -ForegroundColor Gray
    $wingetArgs = @(
        'install',
        '--id', $Id,
        '--exact',
        '--silent',
        '--accept-source-agreements',
        '--accept-package-agreements'
    )
    if ($OverrideArgs) {
        $wingetArgs += '--override'
        $wingetArgs += $OverrideArgs
    }

    & winget @wingetArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Err "winget install failed for $Id (exit $LASTEXITCODE)."
        throw "Failed to install $DisplayName"
    }
    Write-OK "$DisplayName installed."
}

# ==========================================================
# Preflight
# ==========================================================
Write-Header "Haruspex Windows Build Setup"

# Ensure winget is available.
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Err "winget is not installed or not on PATH."
    Write-Host "   Install 'App Installer' from the Microsoft Store and re-run this script." -ForegroundColor Yellow
    Write-Host "   Direct link: https://apps.microsoft.com/detail/9NBLGGH4NNS1" -ForegroundColor Yellow
    exit 1
}
Write-OK "winget found: $(winget --version)"

# Sanity-check the OS — Haruspex targets Windows 10 1809+ / Windows 11.
$osVersion = [System.Environment]::OSVersion.Version
if ($osVersion.Major -lt 10) {
    Write-Err "Windows 10+ required. Detected: $osVersion"
    exit 1
}
Write-OK "Windows $($osVersion.Major).$($osVersion.Minor) build $($osVersion.Build)"

# ==========================================================
# Install packages
# ==========================================================

# 1. Git (provides git AND Git Bash, which runs the existing
#    dev-setup.sh / build-sidecars.sh scripts natively on Windows).
if (-not $SkipGit) {
    Write-Header "Git (includes Git Bash)"
    Install-WingetPackage -Id 'Git.Git' -DisplayName 'Git for Windows'
} else {
    Write-Warn "Skipping Git (per -SkipGit)."
}

# 2. Node.js LTS — Tauri's frontend build needs npm and a modern Node.
#    Haruspex's package.json engines field requires 22+.
if (-not $SkipNode) {
    Write-Header "Node.js LTS"
    Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -DisplayName 'Node.js LTS (22.x)'
} else {
    Write-Warn "Skipping Node.js (per -SkipNode)."
}

# 3. Visual Studio 2022 Build Tools with the C++ workload.
#    This is what the Rust MSVC toolchain + CMake's Ninja/MSBuild
#    generators need to link Windows binaries. The --override flag
#    tells the VS installer which workloads/components to include
#    (otherwise the default install has no compilers).
#
#    Components installed:
#      - Microsoft.VisualStudio.Workload.VCTools
#          "Desktop development with C++" workload bundle
#      - Microsoft.VisualStudio.Component.VC.Tools.x86.x64
#          MSVC v143 x64/x86 compiler + linker
#      - Microsoft.VisualStudio.Component.Windows11SDK.22621
#          Windows 11 SDK (needed for webview2 / WinRT headers)
#      - Microsoft.VisualStudio.Component.VC.CMake.Project
#          MSBuild/Ninja + CMake integration (separate from Kitware CMake)
if (-not $SkipBuildTools) {
    Write-Header "Visual Studio 2022 Build Tools (C++ workload)"
    $vsArgs = '--wait --passive --norestart ' +
              '--add Microsoft.VisualStudio.Workload.VCTools ' +
              '--add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 ' +
              '--add Microsoft.VisualStudio.Component.Windows11SDK.22621 ' +
              '--add Microsoft.VisualStudio.Component.VC.CMake.Project ' +
              '--includeRecommended'
    Install-WingetPackage `
        -Id 'Microsoft.VisualStudio.2022.BuildTools' `
        -DisplayName 'Visual Studio 2022 Build Tools' `
        -OverrideArgs $vsArgs
} else {
    Write-Warn "Skipping VS Build Tools (per -SkipBuildTools)."
}

# 4. Rust toolchain via rustup.
#    On Windows, rustup's default host triple is x86_64-pc-windows-msvc,
#    which is what we want. The rustup installer drops rustup-init.exe
#    on PATH and runs it non-interactively.
if (-not $SkipRust) {
    Write-Header "Rust (MSVC toolchain)"
    Install-WingetPackage -Id 'Rustlang.Rustup' -DisplayName 'Rustup'
    # rustup.exe may not be on the current shell's PATH yet — use the
    # well-known install location directly for the initial toolchain
    # install if needed. Idempotent: does nothing if stable-msvc is
    # already the default.
    $rustupPath = Join-Path $env:USERPROFILE '.cargo\bin\rustup.exe'
    if (Test-Path $rustupPath) {
        Write-Host "   Ensuring stable-msvc toolchain is installed..." -ForegroundColor Gray
        & $rustupPath toolchain install stable-msvc 2>&1 | Out-Null
        & $rustupPath default stable-msvc 2>&1 | Out-Null
        Write-OK "Rust toolchain: $(& $rustupPath show active-toolchain 2>&1)"
    } else {
        Write-Warn "rustup.exe not found at $rustupPath after install — start a new terminal and run: rustup default stable-msvc"
    }
} else {
    Write-Warn "Skipping Rust (per -SkipRust)."
}

# 5. CMake (the Kitware-distributed one, separate from VS's embedded
#    CMake). build-sidecars.sh calls `cmake` directly and expects it
#    on PATH.
if (-not $SkipCMake) {
    Write-Header "CMake"
    Install-WingetPackage -Id 'Kitware.CMake' -DisplayName 'CMake'
} else {
    Write-Warn "Skipping CMake (per -SkipCMake)."
}

# 6. Vulkan SDK.
#    Needed for GPU acceleration in llama-server and whisper-server.
#    build-sidecars.sh checks for VULKAN_SDK env var + headers at
#    $VULKAN_SDK/Include/vulkan and enables -DGGML_VULKAN=ON when
#    present. Without this, the sidecars fall back to CPU — they still
#    build and run, just without GPU acceleration.
#
#    The installer sets VULKAN_SDK system-wide automatically.
if (-not $SkipVulkan) {
    Write-Header "Vulkan SDK"
    Install-WingetPackage -Id 'KhronosGroup.VulkanSDK' -DisplayName 'Vulkan SDK'
} else {
    Write-Warn "Skipping Vulkan SDK (per -SkipVulkan) — sidecars will be CPU-only."
}

# 7. WebView2 Runtime.
#    Required by the installed Haruspex app at runtime. Usually
#    preinstalled on Windows 11, but winget makes this idempotent
#    so we check rather than assume.
if (-not $SkipWebView2) {
    Write-Header "WebView2 Runtime"
    Install-WingetPackage -Id 'Microsoft.EdgeWebView2Runtime' -DisplayName 'WebView2 Runtime'
} else {
    Write-Warn "Skipping WebView2 (per -SkipWebView2)."
}

# ==========================================================
# Done
# ==========================================================
Write-Header "Setup complete"

Write-Host @"

Next steps:

  1. CLOSE THIS POWERSHELL WINDOW AND OPEN A NEW ONE.
     PATH updates from the installers only apply to new shells.

  2. Open Git Bash (installed by the Git step above) from the Start
     menu. The existing build scripts are bash — Git Bash runs them
     natively on Windows.

  3. Clone the repo and run dev-setup:

     git clone https://github.com/tmac1973/haruspex.git
     cd haruspex
     ./scripts/dev-setup.sh

     dev-setup.sh auto-detects the Windows target, builds the three
     sidecars (llama-server, whisper-server, koko), downloads PDFium,
     and pulls the Whisper/Kokoro model files.

  4. Build the release installer:

     npm run tauri build

     The .msi and .exe installers land in:
     src-tauri/target/release/bundle/

Notes:
  - First sidecar build takes 20-40 minutes depending on your machine
    (llama.cpp has a lot of translation units). Subsequent runs are
    incremental and much faster.
  - The LLM model itself is downloaded by the app's first-run wizard,
    not by this script — it's too big (~5 GB) to bundle.
  - If the build fails with 'link.exe' errors mentioning Git's sh.exe,
    that's the MSVC linker getting shadowed by Git's coreutils link.
    scripts/msvc-path-fix.sh handles this automatically inside
    build-sidecars.sh, so it should not bite you. If it does, run
    the build from a 'Developer Command Prompt for VS 2022' instead
    of Git Bash.

"@ -ForegroundColor White
