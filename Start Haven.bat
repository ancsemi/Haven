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

:: ── Check Node.js ──
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 goto :NODE_OK

color 0E
echo.
echo  [!] Node.js is not installed or not in PATH.
echo.
echo  You have two options:
echo    1) Press Y below to install it automatically (~30 MB)
echo    2) Or download it manually from https://nodejs.org
echo.
set /p "AUTOINSTALL=  Install Node.js automatically now? [Y/N]: "
if /i "%AUTOINSTALL%" NEQ "Y" goto :NODE_SKIP

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-node.ps1"
if %ERRORLEVEL% NEQ 0 goto :NODE_INSTALL_FAIL
echo.
echo  [OK] Node.js installed! Close this window and double-click Start Haven again.
echo      Node.js needs a fresh terminal to be recognized.
echo.
pause
exit /b 0

:NODE_INSTALL_FAIL
color 0C
echo.
echo  [ERROR] Automatic install failed. Please install manually from https://nodejs.org
echo.
pause
exit /b 1

:NODE_SKIP
echo.
echo  [*] No problem. Install Node.js from https://nodejs.org and try again.
echo.
pause
exit /b 1

:NODE_OK
for /f "tokens=*" %%v in ('node -v') do echo  [OK] Node.js %%v detected

:: ── Check dependencies ──
cd /d "%~dp0"
if exist "%~dp0node_modules\dotenv\" goto :DEPS_OK

echo  [*] First run detected - installing dependencies...
echo.
npm install
if %ERRORLEVEL% NEQ 0 goto :DEPS_FAIL
echo.
echo  [OK] Dependencies installed
echo.
goto :DEPS_OK

:DEPS_FAIL
color 0C
echo.
echo  [ERROR] npm install failed. Check the output above.
pause
exit /b 1

:DEPS_OK

:: ── SSL certs ──
if exist "%HAVEN_DATA%\certs\cert.pem" goto :SSL_DONE

echo  [*] Checking for SSL certificate tools...
if not exist "%HAVEN_DATA%\certs" mkdir "%HAVEN_DATA%\certs"

where openssl >nul 2>&1
if errorlevel 1 goto :NO_OPENSSL

echo  [*] Generating self-signed SSL certificate...
openssl req -x509 -newkey rsa:2048 -keyout "%HAVEN_DATA%\certs\key.pem" -out "%HAVEN_DATA%\certs\cert.pem" -days 3650 -nodes -subj "/CN=Haven" 2>nul
if exist "%HAVEN_DATA%\certs\cert.pem" goto :SSL_GEN_OK

echo  [!] SSL certificate generation failed.
echo      Haven will run in HTTP mode. See README for details.
goto :SSL_DONE

:SSL_GEN_OK
echo  [OK] SSL certificate generated in %HAVEN_DATA%\certs
goto :SSL_DONE

:NO_OPENSSL
echo  [!] OpenSSL not found - skipping cert generation.
echo      Haven will run in HTTP mode. See README for details.
echo      To enable HTTPS, install OpenSSL or provide certs manually.

:SSL_DONE
echo.
echo  [*] Data directory: %HAVEN_DATA%
echo  [*] Starting Haven server...
echo.

:: ── Start server ──
cd /d "%~dp0"
start /B node server.js

:: ── Wait for server to be ready ──
echo  [*] Waiting for server to start...
set RETRIES=0

:WAIT_LOOP
timeout /t 1 /nobreak >nul
set /a RETRIES+=1
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% EQU 0 goto :SERVER_READY
if %RETRIES% GEQ 15 goto :SERVER_FAIL
goto :WAIT_LOOP

:SERVER_FAIL
color 0C
echo.
echo  [ERROR] Server failed to start after 15 seconds.
echo  Check the output above for errors.
pause
exit /b 1

:SERVER_READY

:: ── Detect protocol ──
set "HAVEN_PROTO=http"
if not exist "%HAVEN_DATA%\certs\cert.pem" goto :SHOW_STATUS
if not exist "%HAVEN_DATA%\certs\key.pem" goto :SHOW_STATUS
set "HAVEN_PROTO=https"

:SHOW_STATUS
echo.
if "%HAVEN_PROTO%"=="https" goto :SHOW_HTTPS
goto :SHOW_HTTP

:SHOW_HTTPS
echo  ========================================
echo    Haven is LIVE on port 3000 (HTTPS)
echo  ========================================
echo.
echo  Local:    https://localhost:3000
echo  LAN:      https://YOUR_LOCAL_IP:3000
echo  Remote:   https://YOUR_PUBLIC_IP:3000
echo.
echo  First time? Your browser will show a security
echo  warning (self-signed cert). Click "Advanced"
echo  then "Proceed" to continue.
goto :OPEN_BROWSER

:SHOW_HTTP
echo  ========================================
echo    Haven is LIVE on port 3000 (HTTP)
echo  ========================================
echo.
echo  Local:    http://localhost:3000
echo  LAN:      http://YOUR_LOCAL_IP:3000
echo  Remote:   http://YOUR_PUBLIC_IP:3000
echo.
echo  NOTE: Running without SSL. Voice chat and
echo  remote connections work best with HTTPS.
echo  See README for how to enable HTTPS.

:OPEN_BROWSER
echo.
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
goto :KEEPALIVE
