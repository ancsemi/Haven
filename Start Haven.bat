@echo off
title Haven Server
color 0A
echo.
echo  ========================================
echo       HAVEN - Private Chat Server
echo  ========================================
echo.

:: ── Data directory (%APPDATA%\Haven) ──────────────────────
set "HAVEN_DATA=%APPDATA%\Haven"
if not exist "%HAVEN_DATA%" mkdir "%HAVEN_DATA%"

:: Kill any existing Haven server on port 3000
echo  [*] Checking for existing server...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo  [!] Killing existing process on port 3000 (PID: %%a)
    taskkill /PID %%a /F >nul 2>&1
)

:: Check Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 goto :NODE_OK

color 0E
echo.
echo  [!] Node.js is not installed or not in PATH.
echo.
echo  You have two options:
echo.
echo    1) Copy and paste this command, then press Enter:
echo.
echo       winget install OpenJS.NodeJS.LTS
echo.
echo    2) Or download it manually from https://nodejs.org
echo.
echo  After installing, close this window and double-click Start Haven again.
echo.
set /p "AUTOINSTALL=  Would you like to install Node.js automatically now? [Y/N]: "
if /i "%AUTOINSTALL%" NEQ "Y" goto :NODE_SKIP

echo.
echo  [*] Installing Node.js via winget... This may take a minute.
echo.
winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if %ERRORLEVEL% NEQ 0 (
    color 0C
    echo.
    echo  [ERROR] Automatic install failed. Please install manually from https://nodejs.org
    echo.
    pause
    exit /b 1
)
echo.
echo  [OK] Node.js installed! Close this window and double-click Start Haven again.
echo      Node.js needs a fresh terminal to be recognized.
echo.
pause
exit /b 0

:NODE_SKIP
echo.
echo  [*] No problem. Install Node.js and try again.
echo.
pause
exit /b 1

:NODE_OK
echo  [OK] Node.js found: & node -v

:: Check if node_modules exists
if not exist "%~dp0node_modules\" (
    echo  [*] First run detected - installing dependencies...
    cd /d "%~dp0"
    npm install
    echo.
)

:: Check .env exists in APPDATA data directory
if not exist "%HAVEN_DATA%\.env" (
    if exist "%~dp0.env.example" (
        echo  [*] Creating .env in %HAVEN_DATA% from template...
        copy "%~dp0.env.example" "%HAVEN_DATA%\.env" >nul
    )
    echo  [!] IMPORTANT: Edit %HAVEN_DATA%\.env and change your settings before going live!
    echo.
)

:: Generate self-signed SSL certs in data directory if missing
if not exist "%HAVEN_DATA%\certs\cert.pem" (
    echo  [*] Generating self-signed SSL certificate...
    if not exist "%HAVEN_DATA%\certs" mkdir "%HAVEN_DATA%\certs"
    where openssl >nul 2>&1
    if errorlevel 1 (
        echo  [!] OpenSSL not found - skipping cert generation.
        echo      Haven will run in HTTP mode. See README for details.
        echo      To enable HTTPS, install OpenSSL or provide certs manually.
    ) else (
        openssl req -x509 -newkey rsa:2048 -keyout "%HAVEN_DATA%\certs\key.pem" -out "%HAVEN_DATA%\certs\cert.pem" -days 3650 -nodes -subj "/CN=Haven" 2>nul
        if exist "%HAVEN_DATA%\certs\cert.pem" (
            echo  [OK] SSL certificate generated in %HAVEN_DATA%\certs
        ) else (
            echo  [!] SSL certificate generation failed.
            echo      Haven will run in HTTP mode. See README for details.
        )
    )
    echo.
)

echo  [*] Data directory: %HAVEN_DATA%
echo  [*] Starting Haven server...
echo.

:: Start server in background
cd /d "%~dp0"
start /B node server.js

:: Wait for server to be ready
echo  [*] Waiting for server to start...
set RETRIES=0
:WAIT_LOOP
timeout /t 1 /nobreak >nul
set /a RETRIES+=1
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    if %RETRIES% GEQ 15 (
        color 0C
        echo  [ERROR] Server failed to start after 15 seconds.
        echo  Check the output above for errors.
        pause
        exit /b 1
    )
    goto WAIT_LOOP
)

:: Detect protocol based on whether certs exist and server can use them
set "HAVEN_PROTO=http"
if exist "%HAVEN_DATA%\certs\cert.pem" (
    if exist "%HAVEN_DATA%\certs\key.pem" (
        set "HAVEN_PROTO=https"
    )
)

echo.
if "%HAVEN_PROTO%"=="https" (
    echo  ========================================
    echo    Haven is LIVE on port 3000 ^(HTTPS^)
    echo  ========================================
    echo.
    echo  Local:    https://localhost:3000
    echo  LAN:      https://YOUR_LOCAL_IP:3000
    echo  Remote:   https://YOUR_PUBLIC_IP:3000
    echo.
    echo  First time? Your browser will show a security
    echo  warning ^(self-signed cert^). Click "Advanced"
    echo  then "Proceed" to continue.
) else (
    echo  ========================================
    echo    Haven is LIVE on port 3000 ^(HTTP^)
    echo  ========================================
    echo.
    echo  Local:    http://localhost:3000
    echo  LAN:      http://YOUR_LOCAL_IP:3000
    echo  Remote:   http://YOUR_PUBLIC_IP:3000
    echo.
    echo  NOTE: Running without SSL. Voice chat and
    echo  remote connections work best with HTTPS.
    echo  See README for how to enable HTTPS.
)
echo.

:: Open browser with correct protocol
echo  [*] Opening browser...
start %HAVEN_PROTO%://localhost:3000

echo.
echo  ----------------------------------------
echo   Server is running. Close this window
echo   or press Ctrl+C to stop the server.
echo  ----------------------------------------
echo.

:: Keep window open so server stays alive
:KEEPALIVE
timeout /t 3600 /nobreak >nul
goto KEEPALIVE
