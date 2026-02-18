@echo off
:: ═══════════════════════════════════════════════════════════
:: Haven — One-Click Installer Bootstrap
:: Download this file and double-click to install Haven.
:: Everything is handled automatically.
:: ═══════════════════════════════════════════════════════════
title Haven Installer
color 0A
echo.
echo  ========================================
echo       HAVEN — One-Click Installer
echo  ========================================
echo.
echo  This will set up Haven, your private
echo  chat server. Everything is automatic —
echo  just follow the prompts.
echo.

:: ── Choose install location ──────────────────────────────
set "INSTALL_DIR=%USERPROFILE%\Haven"
echo  Haven will be installed to:
echo    %INSTALL_DIR%
echo.

:: ── Step 1: Check / Install Node.js ──────────────────────
echo  [1/3] Checking for Node.js...
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 goto :NODE_READY

echo.
echo  Haven needs Node.js to run. Don't worry,
echo  we'll install it for you automatically.
echo  (This downloads ~30 MB and takes about a minute)
echo.
echo  [*] Downloading Node.js 22 LTS...

:: Download and install Node.js using PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
  "$arch = if ([Environment]::Is64BitOperatingSystem) {'x64'} else {'x86'};" ^
  "$url = \"https://nodejs.org/dist/v22.15.0/node-v22.15.0-$arch.msi\";" ^
  "$msi = \"$env:TEMP\node-setup.msi\";" ^
  "Write-Host '  [*] Downloading...';" ^
  "$ProgressPreference = 'SilentlyContinue';" ^
  "Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing;" ^
  "Write-Host '  [*] Installing (you may see a UAC prompt)...';" ^
  "Start-Process msiexec.exe -ArgumentList \"/i `\"$msi`\" /qb\" -Wait;" ^
  "Remove-Item $msi -Force -ErrorAction SilentlyContinue;" ^
  "Write-Host '  [OK] Node.js installed!';"

if %ERRORLEVEL% NEQ 0 (
    color 0C
    echo.
    echo  [!] Node.js installation failed.
    echo      Please install it manually from https://nodejs.org
    echo      then run this installer again.
    echo.
    pause
    exit /b 1
)

:: Refresh PATH to pick up newly installed Node.js
set "PATH=%ProgramFiles%\nodejs;%PATH%"
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "PATH=%%B;%PATH%"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "PATH=%%B;%PATH%"

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    color 0E
    echo.
    echo  [!] Node.js was installed but needs a fresh terminal.
    echo      Please close this window and double-click
    echo      this installer again.
    echo.
    pause
    exit /b 0
)

:NODE_READY
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
echo        Node.js %NODE_VER% ready
echo.

:: ── Step 2: Download Haven ───────────────────────────────
echo  [2/3] Downloading Haven...

if exist "%INSTALL_DIR%\package.json" (
    echo        Haven already downloaded, updating...
    pushd "%INSTALL_DIR%"

    :: Try git pull if it's a git repo
    if exist ".git" (
        where git >nul 2>&1
        if %ERRORLEVEL% EQU 0 (
            git pull --ff-only origin main >nul 2>&1
            echo        Updated via git
        )
    )
    popd
    goto :HAVEN_READY
)

:: Try git clone first (faster, supports updates)
where git >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo        Cloning from GitHub...
    git clone --depth 1 https://github.com/ancsemi/Haven.git "%INSTALL_DIR%" 2>nul
    if %ERRORLEVEL% EQU 0 goto :HAVEN_READY
)

:: Fallback: download ZIP via PowerShell
echo        Downloading ZIP from GitHub...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
  "$zip = \"$env:TEMP\haven-download.zip\";" ^
  "$ProgressPreference = 'SilentlyContinue';" ^
  "Invoke-WebRequest -Uri 'https://github.com/ancsemi/Haven/archive/refs/heads/main.zip' -OutFile $zip -UseBasicParsing;" ^
  "Expand-Archive -Path $zip -DestinationPath $env:TEMP -Force;" ^
  "if (Test-Path '%INSTALL_DIR%') { Remove-Item '%INSTALL_DIR%' -Recurse -Force };" ^
  "Move-Item \"$env:TEMP\Haven-main\" '%INSTALL_DIR%';" ^
  "Remove-Item $zip -Force -ErrorAction SilentlyContinue;" ^
  "Write-Host '  [OK] Haven downloaded!';"

if not exist "%INSTALL_DIR%\package.json" (
    color 0C
    echo.
    echo  [!] Download failed. Check your internet connection
    echo      and try again.
    echo.
    pause
    exit /b 1
)

:HAVEN_READY
echo        Haven ready at %INSTALL_DIR%
echo.

:: ── Step 3: Launch GUI installer ─────────────────────────
echo  [3/3] Opening installer in your browser...
echo        (Keep this window open until setup is done)
echo.

node "%INSTALL_DIR%\installer\server.js"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  [!] Something went wrong. Check the output above.
    echo.
    pause
)
