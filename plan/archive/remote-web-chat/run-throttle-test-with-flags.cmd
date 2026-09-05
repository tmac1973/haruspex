@echo off
REM Launches the throttle test in Edge with Chromium's anti-throttling flags —
REM the same ones Tauri passes to WebView2 via additionalBrowserArgs.
REM
REM Exists as a file because the equivalent PowerShell one-liner is long enough
REM that terminals wrap it, and a wrapped paste runs half a command.
REM
REM Keep it next to webview-throttle-test.html and double-click it.
setlocal
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" goto notfound
if not exist "%~dp0webview-throttle-test.html" goto nopage

REM The throwaway profile is not tidiness: without it, launching Edge while
REM Edge is already running just opens a tab in the existing process and the
REM flags are silently ignored — producing a clean-looking result from a
REM browser that never received them.
start "" "%EDGE%" ^
 --disable-background-timer-throttling ^
 --disable-backgrounding-occluded-windows ^
 --disable-renderer-backgrounding ^
 --no-first-run --no-default-browser-check ^
 --user-data-dir="%TEMP%\haruspex-throttle-test" ^
 "%~dp0webview-throttle-test.html"

echo Launched with anti-throttling flags.
echo.
echo Verify they took effect: open edge://version in THAT window and check the
echo "Command line" row lists the --disable-* flags. Then press Start, minimise,
echo and leave it 15+ minutes.
timeout /t 12 >nul
exit /b 0

:notfound
echo Could not find msedge.exe under Program Files.
pause
exit /b 1

:nopage
echo webview-throttle-test.html must be in this same folder.
pause
exit /b 1
