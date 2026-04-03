@echo off
REM Wrapper to run Makefile targets on Windows via Git Bash.
REM Usage: make <target>   (from x64 Native Tools Command Prompt)
REM
REM Uses bash -c (not -l) to preserve the MSVC environment from the
REM developer prompt. A login shell would prepend Git's /usr/bin which
REM shadows the MSVC link.exe with the POSIX link utility.
setlocal

set "BASH=C:\Program Files\Git\bin\bash.exe"
if not exist "%BASH%" (
    echo ERROR: Git Bash not found at %BASH%
    echo Install Git for Windows or update the path in make.bat
    exit /b 1
)

"%BASH%" -c "make %*"
