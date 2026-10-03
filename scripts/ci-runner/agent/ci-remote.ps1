<#
The Windows machine's end of `remote-test.sh`. Installed to ~\haruspex-ci\ by
windows-2-runner.ps1; called over SSH as haruspex-ci.

  ci-remote.ps1 -Action start -Suite <suite>   unpack ~\haruspex-ci\src.tgz and
                                               start <suite> on the desktop
  ci-remote.ps1 -Action wait                   stream the log until the suite
                                               ends; exit with its exit code
  ci-remote.ps1 -Action run                    what the scheduled task runs

An SSH session has no desktop, and WebView2 and the UI tests need one, so the
suite always runs from the "Haruspex CI run" scheduled task, which runs in
haruspex-ci's interactive session.
#>
param(
    [ValidateSet('start', 'wait', 'run')][string]$Action = 'wait',
    [string]$Suite = 'unit'
)
$ErrorActionPreference = 'Stop'
$Ci = Join-Path $HOME 'haruspex-ci'
$Src = Join-Path $HOME 'haruspex-src'
$Lock = Join-Path $Ci 'busy'
$Log = Join-Path $Ci 'run.log'
$Done = Join-Path $Ci 'done'
$Task = 'Haruspex CI run'

switch ($Action) {
    'start' {
        if (Test-Path $Lock) { [Console]::Error.WriteLine("busy: $(Get-Content $Lock)"); exit 75 }
        Set-Content $Lock "remote-test $Suite since $(Get-Date)"
        New-Item -ItemType Directory -Force -Path $Src | Out-Null
        # Keep node_modules (npm ci decides whether to redo it) and nothing else,
        # so a file deleted locally is deleted here.
        Get-ChildItem -Force $Src | Where-Object Name -ne 'node_modules' |
            Remove-Item -Recurse -Force
        tar -xzf (Join-Path $Ci 'src.tgz') -C $Src
        if ($LASTEXITCODE -ne 0) { Remove-Item $Lock; throw 'could not unpack the source' }
        Remove-Item -Force -ErrorAction SilentlyContinue $Done, $Log
        Set-Content (Join-Path $Ci 'request') $Suite
        schtasks /run /tn $Task | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Remove-Item $Lock
            [Console]::Error.WriteLine('Could not start the in-session task. Is haruspex-ci signed in to its desktop?')
            exit 1
        }
        Write-Output "started $Suite"
    }
    'wait' {
        while (-not (Test-Path $Log)) { Start-Sleep 1 }
        $stream = [IO.File]::Open($Log, 'Open', 'Read', 'ReadWrite')
        $reader = New-Object IO.StreamReader($stream)
        while ($true) {
            $chunk = $reader.ReadToEnd()
            if ($chunk) { [Console]::Out.Write($chunk) }
            if (Test-Path $Done) {
                Start-Sleep 1
                [Console]::Out.Write($reader.ReadToEnd())
                break
            }
            Start-Sleep -Milliseconds 500
        }
        $reader.Close()
        exit ([int](Get-Content $Done))
    }
    'run' {
        $requested = if (Test-Path (Join-Path $Ci 'request')) { (Get-Content (Join-Path $Ci 'request')).Trim() } else { 'unit' }
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Ci 'run-suite.ps1') -Suite $requested *> $Log
        $code = $LASTEXITCODE
        Set-Content $Done $code
        Remove-Item -Force -ErrorAction SilentlyContinue $Lock
    }
}
