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

:: Read PORT from .env (default 3000)
set "HAVEN_PORT=3000"
if exist "%HAVEN_DATA%\.env" (
    for /f "tokens=1,* delims==" %%A in ('findstr /B /I "PORT=" "%HAVEN_DATA%\.env"') do (
        set "HAVEN_PORT=%%B"
    )
)

:: Kill any existing Haven server on the configured port
echo  [*] Checking for existing server...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%HAVEN_PORT%" ^| findstr "LISTENING"') do (
    echo  [!] Killing existing process on port %HAVEN_PORT% (PID: %%a)
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
echo    1) Press Y below to install it automatically (downloads ~30 MB)
echo.
echo    2) Or download it manually from https://nodejs.org
echo.
set /p "AUTOINSTALL=  Would you like to install Node.js automatically now? [Y/N]: "
if /i "%AUTOINSTALL%" NEQ "Y" goto :NODE_SKIP

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-node.ps1"
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
echo  [*] No problem. Install Node.js from https://nodejs.org and try again.
echo.
pause
exit /b 1

:NODE_OK
for /f "tokens=1 delims=v." %%v in ('node -v 2^>nul') do set "NODE_MAJOR=%%v"
echo  [OK] Node.js found: & node -v

:: Warn if Node major version is very new (native modules may lack prebuilts).
:: Don't hard-refuse on a version number — Node 24 is the current LTS and
:: better-sqlite3 ships prebuilts for it.  The real gate is the functional
:: native-module load check after npm install below.
if defined NODE_MAJOR (
    if %NODE_MAJOR% GEQ 25 (
        color 0E
        echo.
        echo  [!] WARNING: Node.js v%NODE_MAJOR% detected. Haven is tested on Node 18-24.
        echo      If the native module check fails below, install
        echo      Node.js 24 LTS from https://nodejs.org
        echo.
    )
)

:: Always install/update dependencies (fast when already up-to-date)
cd /d "%~dp0"
echo  [*] Checking dependencies...
call npm install --no-audit --no-fund 2>&1
if %ERRORLEVEL% NEQ 0 (
    color 0C
    echo.
    echo  [ERROR] npm install failed. Check the errors above.
    echo.
    pause
    exit /b 1
)
:: Verify native modules actually load on this Node version (the honest
:: compatibility test — version-number guessing refuses working setups).
node -e "require('better-sqlite3')" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    color 0C
    echo.
    echo  [ERROR] The better-sqlite3 native module failed to load on Node v%NODE_MAJOR%.
    echo          Install Node.js 24 LTS from https://nodejs.org and try again.
    echo.
    pause
    exit /b 1
)
echo  [OK] Dependencies ready
echo.

:: Check .env exists in APPDATA data directory
if not exist "%HAVEN_DATA%\.env" (
    if exist "%~dp0.env.example" (
        echo  [*] Creating .env in %HAVEN_DATA% from template...
        copy "%~dp0.env.example" "%HAVEN_DATA%\.env" >nul
    )
    echo  [!] IMPORTANT: Edit %HAVEN_DATA%\.env and change your settings before going live!
    echo.
)

:: Detect local IP for SSL certificate SAN (Subject Alternative Name)
set "LOCAL_IP=127.0.0.1"
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R /C:"IPv4 Address"') do (
    for /f "tokens=*" %%B in ("%%A") do (
        if not "%%B"=="" set "LOCAL_IP=%%B"
    )
)

:: Generate self-signed SSL certs in data directory if missing (skip if FORCE_HTTP=true)
:: Restructured to use goto labels instead of a compound else-if + call subroutine.
:: The previous approach caused cmd.exe to exit rather than return from the subroutine
:: on some Windows versions when call :_gen_ssl_cert was nested inside an else-if block.
:: With goto labels, %OPENSSL_CMD% is referenced as a plain statement (not inside any
:: compound block) so it expands correctly at execution time without a workaround. (#5351, #5358)
if /I "%FORCE_HTTP%"=="true" (
    echo  [*] FORCE_HTTP=true -- skipping SSL certificate generation
    echo.
    goto :ssl_done
)
if exist "%HAVEN_DATA%\certs\cert.pem" goto :ssl_done

echo  [*] Generating self-signed SSL certificate...
if not exist "%HAVEN_DATA%\certs" mkdir "%HAVEN_DATA%\certs"

:: Try to find openssl on PATH first, then check common install locations
set "OPENSSL_CMD="
where openssl >nul 2>&1
if not errorlevel 1 set "OPENSSL_CMD=openssl"

if not defined OPENSSL_CMD (
    for %%D in (
        "C:\Program Files\OpenSSL-Win64\bin"
        "C:\Program Files\OpenSSL\bin"
        "C:\Program Files (x86)\OpenSSL-Win32\bin"
        "C:\OpenSSL-Win64\bin"
        "C:\OpenSSL-Win32\bin"
        "C:\OpenSSL\bin"
    ) do (
        if exist "%%~D\openssl.exe" if not defined OPENSSL_CMD (
            set "OPENSSL_CMD=%%~D\openssl.exe"
            echo  [*] Found OpenSSL at %%~D
        )
    )
)

if not defined OPENSSL_CMD (
    echo  [!] OpenSSL not found on PATH or in common install directories.
    echo      Haven will run in HTTP mode. See README for details.
    echo      To enable HTTPS, install OpenSSL or add it to your PATH.
    echo      Common install location: C:\Program Files\OpenSSL-Win64\bin
    echo.
    goto :ssl_done
)

:: SAN (Subject Alternative Name) is required by modern browsers for HTTPS.
:: %OPENSSL_CMD% is a plain statement here (outside any compound block) so it
:: expands at execution time — no subroutine needed. (#5351, #5358)
"%OPENSSL_CMD%" req -x509 -newkey rsa:2048 -keyout "%HAVEN_DATA%\certs\key.pem" -out "%HAVEN_DATA%\certs\cert.pem" -days 3650 -nodes -subj "/CN=Haven" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:%LOCAL_IP%"
if exist "%HAVEN_DATA%\certs\cert.pem" (
    echo  [OK] SSL certificate generated in %HAVEN_DATA%\certs
) else (
    echo  [!] SSL certificate generation failed.
    echo      Haven will run in HTTP mode. See README for details.
)
echo.
:ssl_done

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
netstat -ano | findstr ":%HAVEN_PORT%" | findstr "LISTENING" >nul 2>&1
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
if /I "%FORCE_HTTP%"=="true" (
    set "HAVEN_PROTO=http"
) else if exist "%HAVEN_DATA%\certs\cert.pem" (
    if exist "%HAVEN_DATA%\certs\key.pem" (
        set "HAVEN_PROTO=https"
    )
)

echo.
if "%HAVEN_PROTO%"=="https" (
    echo  ========================================
    echo    Haven is LIVE on port %HAVEN_PORT% ^(HTTPS^)
    echo  ========================================
    echo.
    echo  Local:    https://localhost:%HAVEN_PORT%
    echo  LAN:      https://YOUR_LOCAL_IP:%HAVEN_PORT%
    echo  Remote:   https://YOUR_PUBLIC_IP:%HAVEN_PORT%
    echo.
    echo  First time? Your browser will show a security
    echo  warning ^(self-signed cert^). Click "Advanced"
    echo  then "Proceed" to continue.
) else (
    echo  ========================================
    echo    Haven is LIVE on port %HAVEN_PORT% ^(HTTP^)
    echo  ========================================
    echo.
    echo  Local:    http://localhost:%HAVEN_PORT%
    echo  LAN:      http://YOUR_LOCAL_IP:%HAVEN_PORT%
    echo  Remote:   http://YOUR_PUBLIC_IP:%HAVEN_PORT%
    echo.
    echo  NOTE: Running without SSL. Voice chat and
    echo  remote connections work best with HTTPS.
    echo  See README for how to enable HTTPS.
)
echo.

:: ── Open browser automatically ──────────────────────────────
echo  [*] Opening browser...
start %HAVEN_PROTO%://localhost:%HAVEN_PORT%
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


