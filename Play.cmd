@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-tournament-room.ps1" %*
if errorlevel 1 (
    echo.
    echo Tournament Room could not start. See the message above.
    if "%~1"=="" pause
    exit /b 1
)
