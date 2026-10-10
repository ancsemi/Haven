<# 
  Haven: Let's Encrypt SSL Certificate Setup (Windows)

  This script uses win-acme (ACME client for Windows) to obtain a free
  Let's Encrypt certificate for your Haven server.

  Prerequisites:
    - A domain name pointing to this machine's public IP (A record)
    - Port 80 open/forwarded for the ACME HTTP-01 challenge
    - Run as Administrator

  Usage:
    .\setup-ssl.ps1 -Domain yourdomain.com [-Email you@email.com]

  The certificate files (cert.pem + key.pem) will be placed in Haven's
  data directory (%APPDATA%\Haven\certs\) where server.js auto-detects them.
#>

param(
  [Parameter(Mandatory=$true)]
  [string]$Domain,

  [Parameter(Mandatory=$false)]
  [string]$Email = ""
)

$ErrorActionPreference = "Stop"

# ── Paths ─────────────────────────────────────────────────
$HavenData = Join-Path $env:APPDATA "Haven"
$CertsDir  = Join-Path $HavenData "certs"
$TempDir   = Join-Path $env:TEMP "haven-ssl-setup"

if (-not (Test-Path $CertsDir)) { New-Item -ItemType Directory -Path $CertsDir -Force | Out-Null }
if (-not (Test-Path $TempDir))  { New-Item -ItemType Directory -Path $TempDir -Force | Out-Null }

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "  Haven SSL Certificate Setup" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Domain:    $Domain"
Write-Host "Certs dir: $CertsDir"
Write-Host ""

# ── Check for existing certs ─────────────────────────────
if ((Test-Path (Join-Path $CertsDir "cert.pem")) -and (Test-Path (Join-Path $CertsDir "key.pem"))) {
  Write-Host "[!] Existing certificates found in $CertsDir" -ForegroundColor Yellow
  $overwrite = Read-Host "    Overwrite? (y/N)"
  if ($overwrite -ne "y" -and $overwrite -ne "Y") {
    Write-Host "Aborted." -ForegroundColor Red
    exit 0
  }
  # Backup existing certs
  $backup = Join-Path $CertsDir "backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  Copy-Item (Join-Path $CertsDir "cert.pem") $backup -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $CertsDir "key.pem") $backup -ErrorAction SilentlyContinue
  Write-Host "    Backed up existing certs to $backup" -ForegroundColor Gray
}

# ── Method selection ──────────────────────────────────────
Write-Host ""
Write-Host "Choose certificate method:" -ForegroundColor Cyan
Write-Host "  [1] Let's Encrypt via win-acme (recommended, auto-renews)"
Write-Host "  [2] Let's Encrypt via certbot  (if you have certbot installed)"
Write-Host "  [3] Self-signed certificate    (for localhost/LAN only)"
Write-Host ""
$method = Read-Host "Select (1/2/3)"

switch ($method) {
  "1" {
    # ── win-acme (ACME client for Windows) ────────────────
    $wacmeDir = Join-Path $TempDir "win-acme"
    $wacmeExe = Join-Path $wacmeDir "wacs.exe"

    if (-not (Test-Path $wacmeExe)) {
      Write-Host ""
      Write-Host "[*] Downloading win-acme..." -ForegroundColor Cyan
      $wacmeUrl = "https://github.com/win-acme/win-acme/releases/download/v2.2.9.1/win-acme.v2.2.9.1.x64.pluggable.zip"
      $zipPath  = Join-Path $TempDir "win-acme.zip"
      
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri $wacmeUrl -OutFile $zipPath -UseBasicParsing
      
      Write-Host "[*] Extracting..." -ForegroundColor Cyan
      Expand-Archive -Path $zipPath -DestinationPath $wacmeDir -Force
      Remove-Item $zipPath -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path $wacmeExe)) {
      Write-Host "[!] win-acme download failed. Try method 2 or 3." -ForegroundColor Red
      exit 1
    }

    Write-Host ""
    Write-Host "[*] Running win-acme for $Domain..." -ForegroundColor Cyan
    Write-Host "    Port 80 must be open for the HTTP challenge." -ForegroundColor Yellow
    Write-Host ""

    # Build arguments for unattended mode
    $args = @(
      "--target", "manual",
      "--host", $Domain,
      "--validation", "selfhosting",
      "--store", "pemfiles",
      "--pemfilespath", $CertsDir
    )
    if ($Email) {
      $args += @("--emailaddress", $Email)
    }
    $args += @("--accepttos", "--closeonfinish")

    & $wacmeExe $args

    # win-acme outputs files with different names, so rename to what Haven expects
    $pemFiles = Get-ChildItem $CertsDir -Filter "*.pem" | Sort-Object LastWriteTime -Descending
    $chainFile = $pemFiles | Where-Object { $_.Name -match "chain|fullchain|crt" } | Select-Object -First 1
    $keyFile   = $pemFiles | Where-Object { $_.Name -match "key" } | Select-Object -First 1

    if ($chainFile -and $chainFile.Name -ne "cert.pem") {
      Copy-Item $chainFile.FullName (Join-Path $CertsDir "cert.pem") -Force
    }
    if ($keyFile -and $keyFile.Name -ne "key.pem") {
      Copy-Item $keyFile.FullName (Join-Path $CertsDir "key.pem") -Force
    }
  }

  "2" {
    # ── certbot ───────────────────────────────────────────
    $certbot = Get-Command certbot -ErrorAction SilentlyContinue
    if (-not $certbot) {
      Write-Host "[!] certbot not found. Install from https://certbot.eff.org/" -ForegroundColor Red
      Write-Host "    Or use method 1 (win-acme) instead." -ForegroundColor Yellow
      exit 1
    }

    Write-Host ""
    Write-Host "[*] Running certbot for $Domain..." -ForegroundColor Cyan

    $certbotArgs = @(
      "certonly", "--standalone",
      "-d", $Domain,
      "--non-interactive", "--agree-tos"
    )
    if ($Email) {
      $certbotArgs += @("-m", $Email)
    } else {
      $certbotArgs += "--register-unsafely-without-email"
    }

    & certbot $certbotArgs

    # Copy certs to Haven's directory
    $liveDir = "C:\Certbot\live\$Domain"
    if (Test-Path $liveDir) {
      Copy-Item (Join-Path $liveDir "fullchain.pem") (Join-Path $CertsDir "cert.pem") -Force
      Copy-Item (Join-Path $liveDir "privkey.pem")   (Join-Path $CertsDir "key.pem") -Force
    } else {
      Write-Host "[!] Certbot succeeded but live directory not found at $liveDir" -ForegroundColor Yellow
      Write-Host "    Check certbot output and copy fullchain.pem -> cert.pem, privkey.pem -> key.pem" -ForegroundColor Yellow
      exit 1
    }
  }

  "3" {
    # ── Self-signed (localhost/LAN) ───────────────────────
    $openssl = Get-Command openssl -ErrorAction SilentlyContinue
    if (-not $openssl) {
      # Try common Git-for-Windows OpenSSL location
      $gitOpenSSL = "C:\Program Files\Git\usr\bin\openssl.exe"
      if (Test-Path $gitOpenSSL) {
        $openssl = Get-Item $gitOpenSSL
      } else {
        Write-Host "[!] OpenSSL not found. Install Git for Windows or OpenSSL." -ForegroundColor Red
        exit 1
      }
    }

    Write-Host "[*] Generating self-signed certificate for $Domain..." -ForegroundColor Cyan

    $certPath = Join-Path $CertsDir "cert.pem"
    $keyPath  = Join-Path $CertsDir "key.pem"

    & $openssl.Source req -x509 -newkey rsa:2048 `
      -keyout $keyPath -out $certPath `
      -days 3650 -nodes `
      -subj "/CN=$Domain" `
      -addext "subjectAltName=DNS:$Domain,DNS:localhost,IP:127.0.0.1"

    if (-not (Test-Path $certPath)) {
      Write-Host "[!] Certificate generation failed." -ForegroundColor Red
      exit 1
    }
  }

  default {
    Write-Host "Invalid selection." -ForegroundColor Red
    exit 1
  }
}

# ── Verify ────────────────────────────────────────────────
$certExists = Test-Path (Join-Path $CertsDir "cert.pem")
$keyExists  = Test-Path (Join-Path $CertsDir "key.pem")

Write-Host ""
if ($certExists -and $keyExists) {
  Write-Host "=====================================" -ForegroundColor Green
  Write-Host "  SSL certificates installed!" -ForegroundColor Green
  Write-Host "=====================================" -ForegroundColor Green
  Write-Host ""
  Write-Host "  cert.pem -> $CertsDir\cert.pem" -ForegroundColor Gray
  Write-Host "  key.pem  -> $CertsDir\key.pem" -ForegroundColor Gray
  Write-Host ""
  Write-Host "  Haven will auto-detect these on next startup." -ForegroundColor Cyan
  Write-Host "  Just run: Start Haven.bat" -ForegroundColor Cyan
  Write-Host ""
  if ($method -eq "1") {
    Write-Host "  win-acme will auto-renew before expiry." -ForegroundColor Green
  } elseif ($method -eq "2") {
    Write-Host "  Run 'certbot renew' periodically to keep the cert valid." -ForegroundColor Yellow
    Write-Host "  Consider adding a scheduled task for auto-renewal." -ForegroundColor Yellow
  } elseif ($method -eq "3") {
    Write-Host "  NOTE: Self-signed certs will show browser warnings." -ForegroundColor Yellow
    Write-Host "  Use method 1 or 2 for a proper Let's Encrypt cert." -ForegroundColor Yellow
  }
} else {
  Write-Host "  Certificate installation may have failed." -ForegroundColor Red
  Write-Host "  Check the output above for errors." -ForegroundColor Red
}

Write-Host ""
