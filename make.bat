@echo off
REM Wrapper to run Makefile targets on Windows via Git Bash.
REM Usage: make <target>   (from x64 Native Tools Command Prompt)
REM
REM Finds the MSVC link.exe and prepends its directory to PATH so it
REM takes priority over Git's /usr/bin/link.exe (a POSIX utility).
setlocal

set "BASH=C:\Program Files\Git\bin\bash.exe"
if not exist "%BASH%" (
    echo ERROR: Git Bash not found at %BASH%
    echo Install Git for Windows or update the path in make.bat
    exit /b 1
)

REM Find MSVC link.exe and prepend its directory to PATH
for /f "tokens=*" %%i in ('where link.exe 2^>nul ^| findstr /i "MSVC HostX64"') do (
    set "MSVC_LINK=%%~dpi"
    goto :found_link
)
echo WARN: Could not find MSVC link.exe — linking may fail
goto :run

:found_link
echo Using MSVC linker from: %MSVC_LINK%
set "PATH=%MSVC_LINK%;%PATH%"

:run
"%BASH%" -c "make %*"
