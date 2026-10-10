# Haven Node.js Installer Helper
# Downloads and installs Node.js 22 LTS (native modules have prebuilt binaries)

Write-Host ""
Write-Host "  [*] Fetching latest Node.js 22 LTS version..." -ForegroundColor Cyan

try {
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -ErrorAction Stop
} catch {
    Write-Host "  [ERROR] Could not reach nodejs.org. Check your internet connection." -ForegroundColor Red
    exit 1
}

# Pin to Node 22.x: better-sqlite3 ships prebuilt binaries for v22 but not
# newer majors yet, and compiling from source requires Python + C++ tools
# that most Windows users don't have.
$lts = $index | Where-Object { $_.lts -and $_.version -match '^v22\.' } | Select-Object -First 1
if (-not $lts) {
    # Fallback: try any LTS if 22.x is no longer listed
    $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
}
if (-not $lts) {
    Write-Host "  [ERROR] Could not determine LTS version." -ForegroundColor Red
    exit 1
}

$version = $lts.version
Write-Host "  [*] Installing Node.js $version (LTS)" -ForegroundColor Cyan

$url = "https://nodejs.org/dist/$version/node-$version-x64.msi"
$msiPath = "$env:TEMP\node-$version-x64.msi"

Write-Host "  [*] Downloading Node.js installer (this may take a minute)..." -ForegroundColor Cyan

try {
    # Use BITS for reliable download with progress, fall back to Invoke-WebRequest
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $msiPath -UseBasicParsing -ErrorAction Stop
    $ProgressPreference = 'Continue'
} catch {
    Write-Host "  [ERROR] Download failed: $_" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $msiPath)) {
    Write-Host "  [ERROR] Download failed - file not found." -ForegroundColor Red
    exit 1
}

$size = [math]::Round((Get-Item $msiPath).Length / 1MB, 1)
Write-Host "  [OK] Downloaded ($size MB)" -ForegroundColor Green
Write-Host "  [*] Installing Node.js (you may see a UAC prompt)..." -ForegroundColor Cyan

try {
    $process = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qb" -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        Write-Host "  [ERROR] Installer exited with code $($process.ExitCode)" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "  [ERROR] Installation failed: $_" -ForegroundColor Red
    exit 1
}

Write-Host "  [OK] Node.js $version installed successfully!" -ForegroundColor Green
Write-Host ""

# Clean up
Remove-Item $msiPath -Force -ErrorAction SilentlyContinue

exit 0
