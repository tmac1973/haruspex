# The release-test skill's Windows live passes. Copy to the repo root as
# .remote-drive.ps1 (remote-test.sh sends it; the `drive` suite runs it), set
# the model, and delete the copy afterwards.
$ErrorActionPreference = 'Continue'
$out = Join-Path $HOME '.haruspex-test\drive-out'
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $out | Out-Null
$model = @('--base-url', 'http://compute:3000', '--model', '<model id>', '--show', '--timeout', '600')
$status = 0

# 1. A Windows folder: PowerShell commands.
$win = Join-Path $env:TEMP 'hx-drive-avg'
Remove-Item -Recurse -Force $win -ErrorAction SilentlyContinue
Copy-Item -Recurse 'e2e\fixtures\average-bug' $win
Write-Output "== drive: Windows folder $win"
node scripts/drive.mjs run @model --folder $win --out (Join-Path $out 'win-native') `
    --prompt 'Fix the bug in the project and run it to check.' `
    --prompt 'Using a PowerShell command, list the files in the project with their sizes.'
if ($LASTEXITCODE -ne 0) { $status = 1; Write-Output "!! windows-folder pass exited $LASTEXITCODE" }

# 2. A folder inside the WSL distro.
$distro = 'Ubuntu-24.04'
$src = (wsl.exe -d $distro -- wslpath -a ((Resolve-Path 'e2e\fixtures\average-bug').Path -replace '\\','/'))
wsl.exe -d $distro -- bash -lc "rm -rf ~/hx-drive-avg && cp -r '$src' ~/hx-drive-avg && echo copied"
$linuxHome = (wsl.exe -d $distro -- bash -lc 'echo $HOME').Trim()
$wslFolder = "\\wsl.localhost\$distro" + ($linuxHome -replace '/','\') + '\hx-drive-avg'
Write-Output "== drive: WSL folder $wslFolder"
node scripts/drive.mjs run @model --folder $wslFolder --out (Join-Path $out 'wsl') `
    --prompt 'Fix the bug in the project and run it to check.' `
    --prompt 'Run uname -a and tell me which Linux this is.'
if ($LASTEXITCODE -ne 0) { $status = 1; Write-Output "!! wsl pass exited $LASTEXITCODE" }

exit $status
