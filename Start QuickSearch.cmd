@echo off
setlocal
cd /d "%~dp0"
title QuickSearch

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo QuickSearch needs Node.js to run the server-side proxy.
    echo Install the Node.js LTS version, then double-click this file again.
    echo.
    echo You can still open quicksearch.html directly, but proxy mode will be limited.
    echo.
    pause
    exit /b 1
)

node --max-old-space-size=128 launcher.js
if errorlevel 1 (
    echo.
    pause
)
