@echo off
title Haven Installer
color 0A
echo.
echo  ========================================
echo       HAVEN - Installer
echo  ========================================
echo.
echo  Welcome! This will set up your private
echo  chat server. Nothing complicated - just
echo  follow the steps in the browser window.
echo.

:: ── Check for Node.js ────────────────────────────────────
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 goto :NODE_READY

echo  Haven needs Node.js to run. Don't worry,
echo  we'll install it for you automatically.
echo.
echo  [*] Installing Node.js (this takes about a minute)...
echo.

:: Use the existing install-node.ps1 helper
call powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-node.ps1"
if %ERRORLEVEL% NEQ 0 (
    color 0C
    echo.
    echo  [!] Node.js installation failed.
    echo      Please install it manually from https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Refresh PATH so we can find the newly installed node
set "PATH=%ProgramFiles%\nodejs;%PATH%"
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "PATH=%%B;%PATH%"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "PATH=%%B;%PATH%"

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    color 0E
    echo.
    echo  [!] Node.js was installed but needs a fresh terminal.
    echo      Please close this window and double-click
    echo      "Install Haven" again.
    echo.
    pause
    exit /b 0
)

:NODE_READY
echo  [OK] Node.js found: & node -v
echo.
echo  [*] Opening installer in your browser...
echo      (Keep this window open until setup is done)
echo.

:: Launch the web-based GUI installer
node "%~dp0installer\server.js"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  [!] Something went wrong. Check the output above.
    echo.
    pause
)
