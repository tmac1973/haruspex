# Haruspex shell integration for PowerShell (Windows PowerShell 5.1 and 7+).
#
# Dot-sourced AFTER the user's $PROFILE (the launcher loads profiles, then
# `. haruspex.ps1`) so we wrap their final `prompt`. Emits the same OSC 133
# markers as the bash/zsh hooks so the host's parser is unchanged:
#   A = prompt start, B = prompt end / command-line start,
#   C = command output start (+ cl=<base64> command line),
#   D = command end (+ exit code), plus OSC 7 cwd.
#
# Pure ASCII on purpose: Windows PowerShell 5.1 reads a BOM-less file as ANSI.

if ($global:__HspIntegrationLoaded) { return }
$global:__HspIntegrationLoaded = $true

# Set by the Enter handler when a real command is accepted, cleared by the
# prompt after it emits that command's D marker. Guards against a stray D on
# the first prompt or after an empty Enter.
$global:__HspCommandRan = $false

# Save the user's current prompt so we can call through to it. PowerShell always
# defines a default `prompt`, so this is non-null even without a custom profile.
$global:__HspOriginalPrompt = $function:prompt

function global:prompt {
    # $? and $LASTEXITCODE are volatile - capture them as the very first thing.
    $ok = $?
    $lastExit = $LASTEXITCODE

    $esc = [char]27
    $bel = [char]7
    $out = ''

    # D: end of the previous command (only when one actually ran).
    if ($global:__HspCommandRan) {
        $code = if ($ok) { 0 } elseif ($null -ne $lastExit) { $lastExit } else { 1 }
        $out += "$esc]133;D;$code$bel"
        $global:__HspCommandRan = $false
    }

    # OSC 7 cwd (before A so the post-command cwd pairs with D). Best-effort.
    try {
        $cwd = (Get-Location).ProviderPath
        if ($cwd) {
            $out += "$esc]7;file://$($env:COMPUTERNAME)/$($cwd -replace '\\','/')$bel"
        }
    } catch {}

    # A: prompt start.
    $out += "$esc]133;A$bel"

    # The user's real prompt text.
    $userPrompt = ''
    try {
        $userPrompt = [string](& $global:__HspOriginalPrompt)
    } catch {
        $userPrompt = "PS $((Get-Location).Path)> "
    }
    $out += $userPrompt

    # B: prompt end / command-line start.
    $out += "$esc]133;B$bel"

    # Restore $LASTEXITCODE in case anything above touched it.
    $global:LASTEXITCODE = $lastExit
    return $out
}

# C marker + command line via a PSReadLine Enter handler. Degrade silently if
# PSReadLine is unavailable - the terminal still works, capture just won't fire.
try {
    if (Get-Module -ListAvailable PSReadLine -ErrorAction SilentlyContinue) {
        Set-PSReadLineKeyHandler -Key Enter -BriefDescription HspAcceptLine -ScriptBlock {
            param($key, $arg)

            $line = ''
            $cursor = 0
            [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)

            # Only mark a command when the buffer is a complete, non-empty
            # statement. An incomplete buffer (open brace/quote) means Enter
            # should insert a newline, not run anything - so don't emit C.
            $errs = $null
            $null = [System.Management.Automation.Language.Parser]::ParseInput(
                $line, [ref]$null, [ref]$errs)
            $incomplete = $false
            if ($errs) {
                foreach ($e in $errs) { if ($e.IncompleteInput) { $incomplete = $true; break } }
            }

            if (-not $incomplete -and $line.Trim().Length -gt 0) {
                $esc = [char]27
                $bel = [char]7
                $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line))
                [Console]::Write("$esc]133;C;cl=$b64$bel")
                $global:__HspCommandRan = $true
            }

            # ValidateAndAcceptLine does the accept-vs-newline decision itself
            # (so multi-line input keeps working); fall back on older PSReadLine.
            try {
                [Microsoft.PowerShell.PSConsoleReadLine]::ValidateAndAcceptLine()
            } catch {
                [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
            }
        }
    }
} catch {}
