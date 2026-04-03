@echo off
REM Wrapper to run Makefile targets on Windows via Git Bash.
REM Usage: make <target>   (from any Windows command prompt)
setlocal

set "BASH=C:\Program Files\Git\bin\bash.exe"
if not exist "%BASH%" (
    echo ERROR: Git Bash not found at %BASH%
    echo Install Git for Windows or update the path in make.bat
    exit /b 1
)

if "%~1"=="" (
    "%BASH%" -lc "make %*"
) else (
    "%BASH%" -lc "make %*"
)
