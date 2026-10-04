<#
Run one test suite on the source tree in ~\.haruspex-test\src: the Windows agent's
suite runner (the Mac has run-suite.sh).

  unit      npm run check + test, cargo clippy + test (what CI runs)
  e2e-app   the real-app tests: build with stub sidecars, then drive it
            through tauri-driver and msedgedriver (needs you signed in)
  live      npm run e2e:live    } added by plan/misc_futures phase 14
                                } part 3; until then it says so and fails
#>
param([string]$Suite = 'unit')
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $HOME '.haruspex-test\src')
$env:Path = (Join-Path $HOME '.cargo\bin') + ';' +
    [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
    [Environment]::GetEnvironmentVariable('Path', 'User')
$cache = Join-Path $HOME '.haruspex-test\cache'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
# Outside the source tree, which is replaced on every run: keeps incremental
# builds across runs.
$env:CARGO_TARGET_DIR = Join-Path $cache 'target'

function Run($label, [scriptblock]$cmd) {
    Write-Output "== $label"
    & $cmd
    if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" }
}

$rev = if (Test-Path '.remote-test-rev') { Get-Content '.remote-test-rev' } else { 'unknown revision' }
Write-Output "== $Suite on $env:COMPUTERNAME at $(Get-Date)"
Write-Output "== $rev - node $(node -v) - $(cargo --version)"

# npm ci only when the lockfile changed.
$hash = (Get-FileHash package-lock.json -Algorithm SHA256).Hash
$stamp = Join-Path $cache 'npm-lock.sha256'
if (-not (Test-Path node_modules) -or -not (Test-Path $stamp) -or (Get-Content $stamp) -ne $hash) {
    Run 'npm ci' { npm ci }
    Set-Content $stamp $hash
}

# tauri-build validates every externalBin path at compile time. Placeholders,
# as CI uses, unless real sidecars were fetched.
$target = (rustc --print host-tuple)
foreach ($d in 'node-modules', 'libs', 'sd-libs', 'espeak-ng-data\lang\placeholder') {
    New-Item -ItemType Directory -Force -Path "src-tauri\binaries\$d" | Out-Null
}
foreach ($name in 'llama-server', 'whisper-server', 'koko', 'ruff', 'node', 'uv', 'sd-server') {
    $bin = "src-tauri\binaries\$name-$target.exe"
    if (-not (Test-Path $bin)) { Set-Content -Path $bin -Value '@echo off' }
}
foreach ($d in 'node-modules', 'libs', 'sd-libs', 'espeak-ng-data', 'espeak-ng-data\lang', 'espeak-ng-data\lang\placeholder') {
    Set-Content -Path "src-tauri\binaries\$d\.placeholder" -Value ''
}

function Npm-Script($name) {
    $scripts = (Get-Content package.json -Raw | ConvertFrom-Json).scripts
    if (-not $scripts.$name) { throw "npm script '$name' does not exist yet (plan/misc_futures phase 14)" }
    Run "npm run $name" { npm run $name }
}

try {
    switch ($Suite) {
        'unit' {
            Run 'npm run check' { npm run check }
            Run 'npm run test' { npm run test }
            Run 'cargo clippy' { cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings }
            Run 'cargo test' { cargo test --manifest-path src-tauri/Cargo.toml --lib }
        }
        'e2e-app' {
            # tauri-driver, and an msedgedriver matching this machine's WebView2.
            if (-not (Get-Command tauri-driver -ErrorAction SilentlyContinue)) {
                Run 'install tauri-driver' { cargo install tauri-driver --locked }
            }
            if (-not (Get-Command msedgedriver-tool -ErrorAction SilentlyContinue)) {
                Run 'install msedgedriver-tool' { cargo install --git https://github.com/chippers/msedgedriver-tool --locked }
            }
            Run 'fetch msedgedriver' { msedgedriver-tool }
            $env:MSEDGEDRIVER = Join-Path (Get-Location) 'msedgedriver.exe'
            # In the cache: the source tree is replaced on every run.
            $env:E2E_TARGET_DIR = Join-Path $cache 'target-e2e'
            Npm-Script 'e2e:app:build'
            Npm-Script 'e2e:app'
        }
        'live' { Npm-Script 'e2e:live' }
        default { throw "unknown suite: $Suite (unit, e2e-app, live)" }
    }
    Write-Output "== $Suite passed"
    exit 0
} catch {
    Write-Output "!! $_"
    exit 1
}
