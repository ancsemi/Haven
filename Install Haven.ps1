# ═══════════════════════════════════════════════════════════
# Haven — Graphical Installer (PowerShell WPF)
# Usage: powershell -ExecutionPolicy Bypass -File "Install Haven.ps1"
# ═══════════════════════════════════════════════════════════
param([switch]$Silent)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms

# ── Colour palette ─────────────────────────────────────────
$BG        = '#0d1117'
$SURFACE   = '#161b22'
$BORDER    = '#30363d'
$TEXT      = '#e6edf3'
$SUBTEXT   = '#8b949e'
$ACCENT    = '#58a6ff'
$GREEN     = '#3fb950'
$RED       = '#f85149'
$ORANGE    = '#d29922'

$HAVEN_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition
$DATA_DIR  = "$env:APPDATA\Haven"

# ═══════════════════════════════════════════════════════════
# XAML — 6-page wizard
# ═══════════════════════════════════════════════════════════
[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Haven Installer" Width="640" Height="520"
        WindowStartupLocation="CenterScreen" ResizeMode="NoResize"
        Background="$BG" FontFamily="Segoe UI" Foreground="$TEXT">
  <Window.Resources>
    <Style x:Key="AccentBtn" TargetType="Button">
      <Setter Property="Background" Value="$ACCENT"/>
      <Setter Property="Foreground" Value="#ffffff"/>
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Padding" Value="24,10"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bd" Background="{TemplateBinding Background}"
                    CornerRadius="6" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bd" Property="Background" Value="#79c0ff"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter TargetName="bd" Property="Opacity" Value="0.4"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="GreenBtn" TargetType="Button" BasedOn="{StaticResource AccentBtn}">
      <Setter Property="Background" Value="$GREEN"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bd" Background="{TemplateBinding Background}"
                    CornerRadius="6" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bd" Property="Background" Value="#56d364"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="GhostBtn" TargetType="Button">
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="Foreground" Value="$SUBTEXT"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="Padding" Value="16,8"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="BorderBrush" Value="$BORDER"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bd" Background="{TemplateBinding Background}"
                    BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="{TemplateBinding BorderThickness}"
                    CornerRadius="6" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bd" Property="Background" Value="$SURFACE"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="InputBox" TargetType="TextBox">
      <Setter Property="Background" Value="$SURFACE"/>
      <Setter Property="Foreground" Value="$TEXT"/>
      <Setter Property="BorderBrush" Value="$BORDER"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Padding" Value="10,8"/>
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="CaretBrush" Value="$TEXT"/>
    </Style>
    <Style x:Key="PwBox" TargetType="PasswordBox">
      <Setter Property="Background" Value="$SURFACE"/>
      <Setter Property="Foreground" Value="$TEXT"/>
      <Setter Property="BorderBrush" Value="$BORDER"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Padding" Value="10,8"/>
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="CaretBrush" Value="$TEXT"/>
    </Style>
    <Style x:Key="RadioOption" TargetType="RadioButton">
      <Setter Property="Foreground" Value="$TEXT"/>
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="Margin" Value="0,6,0,0"/>
      <Setter Property="Cursor" Value="Hand"/>
    </Style>
  </Window.Resources>

  <Grid>
    <!-- Progress bar at top -->
    <Border Height="3" VerticalAlignment="Top" Background="$SURFACE">
      <Border x:Name="progressBar" Height="3" HorizontalAlignment="Left" Width="0"
              Background="$ACCENT">
        <Border.RenderTransform>
          <ScaleTransform ScaleX="1"/>
        </Border.RenderTransform>
      </Border>
    </Border>

    <!-- Page container -->
    <Grid Margin="48,32,48,24">
      <!-- PAGE 0: Welcome -->
      <StackPanel x:Name="page0" Visibility="Visible">
        <TextBlock Text="☁" FontSize="56" HorizontalAlignment="Center" Margin="0,40,0,0"/>
        <TextBlock Text="Welcome to Haven" FontSize="28" FontWeight="Bold"
                   HorizontalAlignment="Center" Margin="0,12,0,0"/>
        <TextBlock Text="Your private, self-hosted chat server."
                   FontSize="14" Foreground="$SUBTEXT" HorizontalAlignment="Center" Margin="0,8,0,0"/>
        <TextBlock Text="This wizard will get you up and running in under a minute."
                   FontSize="13" Foreground="$SUBTEXT" HorizontalAlignment="Center" Margin="0,4,0,0"/>
        <Button x:Name="btnStart" Content="Get Started →" Style="{StaticResource AccentBtn}"
                HorizontalAlignment="Center" Margin="0,36,0,0"/>
        <TextBlock FontSize="11" Foreground="$SUBTEXT" HorizontalAlignment="Center" Margin="0,16,0,0"
                   Text="Requires Node.js 18+ • Windows 10/11"/>
      </StackPanel>

      <!-- PAGE 1: Server Name -->
      <StackPanel x:Name="page1" Visibility="Collapsed">
        <TextBlock Text="Name your server" FontSize="22" FontWeight="Bold" Margin="0,20,0,0"/>
        <TextBlock Text="This is the name friends will see when they connect."
                   FontSize="13" Foreground="$SUBTEXT" Margin="0,6,0,16"/>
        <TextBlock Text="SERVER NAME" FontSize="11" Foreground="$SUBTEXT" FontWeight="SemiBold"/>
        <TextBox x:Name="txtServerName" Style="{StaticResource InputBox}" Margin="0,4,0,0"
                 MaxLength="40" Text="Haven"/>
        <Border Background="$SURFACE" CornerRadius="8" Padding="16" Margin="0,20,0,0"
                BorderBrush="$BORDER" BorderThickness="1">
          <StackPanel>
            <TextBlock Text="PREVIEW" FontSize="10" Foreground="$SUBTEXT" FontWeight="SemiBold"/>
            <StackPanel Orientation="Horizontal" Margin="0,8,0,0">
              <TextBlock Text="☁" FontSize="22" VerticalAlignment="Center"/>
              <StackPanel Margin="10,0,0,0">
                <TextBlock x:Name="lblPreview" Text="Haven" FontSize="16" FontWeight="SemiBold"/>
                <TextBlock Text="https://your-tunnel-url.trycloudflare.com"
                           FontSize="11" Foreground="$SUBTEXT"/>
              </StackPanel>
            </StackPanel>
          </StackPanel>
        </Border>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,24,0,0">
          <Button x:Name="btnBack1" Content="← Back" Style="{StaticResource GhostBtn}" Margin="0,0,8,0"/>
          <Button x:Name="btnNext1" Content="Continue →" Style="{StaticResource AccentBtn}"/>
        </StackPanel>
      </StackPanel>

      <!-- PAGE 2: Admin Account -->
      <StackPanel x:Name="page2" Visibility="Collapsed">
        <TextBlock Text="Create admin account" FontSize="22" FontWeight="Bold" Margin="0,20,0,0"/>
        <TextBlock Text="This is the administrator account for your server."
                   FontSize="13" Foreground="$SUBTEXT" Margin="0,6,0,16"/>
        <TextBlock Text="USERNAME" FontSize="11" Foreground="$SUBTEXT" FontWeight="SemiBold"/>
        <TextBox x:Name="txtUser" Style="{StaticResource InputBox}" Margin="0,4,0,12" MaxLength="24"/>
        <TextBlock Text="PASSWORD" FontSize="11" Foreground="$SUBTEXT" FontWeight="SemiBold"/>
        <PasswordBox x:Name="txtPass" Style="{StaticResource PwBox}" Margin="0,4,0,12" MaxLength="128"/>
        <TextBlock Text="CONFIRM PASSWORD" FontSize="11" Foreground="$SUBTEXT" FontWeight="SemiBold"/>
        <PasswordBox x:Name="txtPass2" Style="{StaticResource PwBox}" Margin="0,4,0,0" MaxLength="128"/>
        <TextBlock x:Name="lblPassErr" Text="" FontSize="12" Foreground="$RED" Margin="0,8,0,0"/>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,16,0,0">
          <Button x:Name="btnBack2" Content="← Back" Style="{StaticResource GhostBtn}" Margin="0,0,8,0"/>
          <Button x:Name="btnNext2" Content="Continue →" Style="{StaticResource AccentBtn}"/>
        </StackPanel>
      </StackPanel>

      <!-- PAGE 3: Network Access -->
      <StackPanel x:Name="page3" Visibility="Collapsed">
        <TextBlock Text="Network access" FontSize="22" FontWeight="Bold" Margin="0,20,0,0"/>
        <TextBlock Text="How should friends reach your server?"
                   FontSize="13" Foreground="$SUBTEXT" Margin="0,6,0,16"/>
        <RadioButton x:Name="radCF" GroupName="net" Style="{StaticResource RadioOption}" IsChecked="True">
          <StackPanel>
            <TextBlock Text="☁  Cloudflare Tunnel (recommended)" FontWeight="SemiBold"/>
            <TextBlock Text="Free, no config needed. Auto-downloads cloudflared."
                       FontSize="12" Foreground="$SUBTEXT" Margin="18,2,0,0"/>
          </StackPanel>
        </RadioButton>
        <RadioButton x:Name="radLT" GroupName="net" Style="{StaticResource RadioOption}">
          <StackPanel>
            <TextBlock Text="🔗  LocalTunnel" FontWeight="SemiBold"/>
            <TextBlock Text="Free npm-based tunnel. May be slower."
                       FontSize="12" Foreground="$SUBTEXT" Margin="18,2,0,0"/>
          </StackPanel>
        </RadioButton>
        <RadioButton x:Name="radPF" GroupName="net" Style="{StaticResource RadioOption}">
          <StackPanel>
            <TextBlock Text="🔧  Port-Forward (advanced)" FontWeight="SemiBold"/>
            <TextBlock Text="Configure your router manually. Static IP recommended."
                       FontSize="12" Foreground="$SUBTEXT" Margin="18,2,0,0"/>
          </StackPanel>
        </RadioButton>
        <RadioButton x:Name="radLocal" GroupName="net" Style="{StaticResource RadioOption}">
          <StackPanel>
            <TextBlock Text="📡  Local Only" FontWeight="SemiBold"/>
            <TextBlock Text="Same WiFi/network only. No internet access."
                       FontSize="12" Foreground="$SUBTEXT" Margin="18,2,0,0"/>
          </StackPanel>
        </RadioButton>
        <!-- Expandable PF instructions -->
        <Border x:Name="pfInstructions" Background="$SURFACE" CornerRadius="6" Padding="14"
                Margin="0,12,0,0" BorderBrush="$BORDER" BorderThickness="1" Visibility="Collapsed">
          <TextBlock TextWrapping="Wrap" FontSize="12" Foreground="$SUBTEXT">
            <Run FontWeight="SemiBold" Foreground="$TEXT">Port-Forwarding Steps:</Run><LineBreak/>
            1. Open router admin (usually http://192.168.1.1)<LineBreak/>
            2. Find "Port Forwarding" or "NAT" settings<LineBreak/>
            3. Add rule: External 3000 → Internal 3000, TCP<LineBreak/>
            4. Set Internal IP to this PC's local IP<LineBreak/>
            5. Share your public IP: https://YOUR_IP:3000
          </TextBlock>
        </Border>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,16,0,0">
          <Button x:Name="btnBack3" Content="← Back" Style="{StaticResource GhostBtn}" Margin="0,0,8,0"/>
          <Button x:Name="btnNext3" Content="Install →" Style="{StaticResource GreenBtn}"/>
        </StackPanel>
      </StackPanel>

      <!-- PAGE 4: Installing -->
      <StackPanel x:Name="page4" Visibility="Collapsed">
        <TextBlock Text="Installing Haven…" FontSize="22" FontWeight="Bold" Margin="0,20,0,0"/>
        <TextBlock x:Name="lblStatus" Text="Preparing..." FontSize="13" Foreground="$SUBTEXT"
                   Margin="0,6,0,20"/>
        <ProgressBar x:Name="pbar" Height="6" Minimum="0" Maximum="100" Value="0"
                     Background="$SURFACE" Foreground="$ACCENT" BorderThickness="0"/>
        <StackPanel x:Name="stepList" Margin="0,20,0,0">
          <TextBlock x:Name="step1" Text="   Checking Node.js..." FontSize="13" Foreground="$SUBTEXT"/>
          <TextBlock x:Name="step2" Text="   Installing dependencies..." FontSize="13" Foreground="$SUBTEXT" Margin="0,6,0,0"/>
          <TextBlock x:Name="step3" Text="   Creating data directory..." FontSize="13" Foreground="$SUBTEXT" Margin="0,6,0,0"/>
          <TextBlock x:Name="step4" Text="   Generating SSL certificate..." FontSize="13" Foreground="$SUBTEXT" Margin="0,6,0,0"/>
          <TextBlock x:Name="step5" Text="   Configuring server..." FontSize="13" Foreground="$SUBTEXT" Margin="0,6,0,0"/>
          <TextBlock x:Name="step6" Text="   Creating shortcuts..." FontSize="13" Foreground="$SUBTEXT" Margin="0,6,0,0"/>
        </StackPanel>
      </StackPanel>

      <!-- PAGE 5: Complete -->
      <StackPanel x:Name="page5" Visibility="Collapsed">
        <TextBlock Text="✓" FontSize="56" Foreground="$GREEN" HorizontalAlignment="Center" Margin="0,30,0,0"/>
        <TextBlock Text="Haven is installed!" FontSize="28" FontWeight="Bold"
                   HorizontalAlignment="Center" Margin="0,8,0,0"/>
        <TextBlock x:Name="lblDone" Text="" FontSize="13" Foreground="$SUBTEXT"
                   HorizontalAlignment="Center" Margin="0,8,0,0" TextWrapping="Wrap"
                   TextAlignment="Center"/>
        <Border Background="$SURFACE" CornerRadius="8" Padding="16" Margin="0,20,0,0"
                BorderBrush="$BORDER" BorderThickness="1" HorizontalAlignment="Center">
          <StackPanel>
            <TextBlock Text="SHARE WITH FRIENDS" FontSize="10" Foreground="$SUBTEXT" FontWeight="SemiBold"/>
            <TextBlock x:Name="lblShareLink" Text="" FontSize="15" Foreground="$ACCENT"
                       Margin="0,4,0,0" Cursor="Hand"/>
          </StackPanel>
        </Border>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Center" Margin="0,28,0,0">
          <Button x:Name="btnLaunch" Content="🚀  Launch Haven" Style="{StaticResource GreenBtn}"
                  Margin="0,0,10,0"/>
          <Button x:Name="btnClose" Content="Close" Style="{StaticResource GhostBtn}"/>
        </StackPanel>
      </StackPanel>
    </Grid>
  </Grid>
</Window>
"@

# ═══════════════════════════════════════════════════════════
# Create window
# ═══════════════════════════════════════════════════════════
$reader = [System.Xml.XmlNodeReader]::new($xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)

# Resolve named elements
$names = @('progressBar','page0','page1','page2','page3','page4','page5',
           'btnStart','btnNext1','btnBack1','btnNext2','btnBack2','btnNext3','btnBack3',
           'txtServerName','lblPreview','txtUser','txtPass','txtPass2','lblPassErr',
           'radCF','radLT','radPF','radLocal','pfInstructions',
           'pbar','lblStatus','step1','step2','step3','step4','step5','step6',
           'lblDone','lblShareLink','btnLaunch','btnClose')
$ui = @{}
foreach ($n in $names) { $ui[$n] = $window.FindName($n) }

$totalWidth = 640
$currentPage = 0

# ── Helper: show page with fade ───────────────────────────
function Show-Page([int]$index) {
    for ($i = 0; $i -le 5; $i++) {
        $p = $ui["page$i"]
        if ($i -eq $index) {
            $p.Visibility = 'Visible'
            $p.Opacity = 0
            $fade = New-Object System.Windows.Media.Animation.DoubleAnimation
            $fade.From = 0; $fade.To = 1; $fade.Duration = [TimeSpan]::FromMilliseconds(300)
            $p.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)
        } else {
            $p.Visibility = 'Collapsed'
        }
    }
    # Update progress bar
    $pct = [math]::Min(($index / 5.0), 1.0)
    $anim = New-Object System.Windows.Media.Animation.DoubleAnimation
    $anim.To = $totalWidth * $pct
    $anim.Duration = [TimeSpan]::FromMilliseconds(400)
    $anim.EasingFunction = New-Object System.Windows.Media.Animation.QuadraticEase
    $ui['progressBar'].BeginAnimation([System.Windows.FrameworkElement]::WidthProperty, $anim)
    $script:currentPage = $index
}

# ── Navigation events ─────────────────────────────────────
$ui['btnStart'].Add_Click({ Show-Page 1 })
$ui['btnBack1'].Add_Click({ Show-Page 0 })
$ui['btnNext1'].Add_Click({
    $name = $ui['txtServerName'].Text.Trim()
    if ([string]::IsNullOrWhiteSpace($name)) { $name = 'Haven' }
    Show-Page 2
})
$ui['btnBack2'].Add_Click({ Show-Page 1 })
$ui['btnBack3'].Add_Click({ Show-Page 2 })

# Server name live preview
$ui['txtServerName'].Add_TextChanged({
    $t = $ui['txtServerName'].Text.Trim()
    if ([string]::IsNullOrWhiteSpace($t)) { $t = 'Haven' }
    $ui['lblPreview'].Text = $t
})

# Show PF instructions when port-forward radio selected
$ui['radPF'].Add_Checked({ $ui['pfInstructions'].Visibility = 'Visible' })
$ui['radCF'].Add_Checked({ $ui['pfInstructions'].Visibility = 'Collapsed' })
$ui['radLT'].Add_Checked({ $ui['pfInstructions'].Visibility = 'Collapsed' })
$ui['radLocal'].Add_Checked({ $ui['pfInstructions'].Visibility = 'Collapsed' })

# Validate admin account
$ui['btnNext2'].Add_Click({
    $user = $ui['txtUser'].Text.Trim()
    $pass = $ui['txtPass'].Password
    $pass2 = $ui['txtPass2'].Password
    if ($user.Length -lt 2) {
        $ui['lblPassErr'].Text = 'Username must be at least 2 characters.'
        return
    }
    if ($pass.Length -lt 6) {
        $ui['lblPassErr'].Text = 'Password must be at least 6 characters.'
        return
    }
    if ($pass -ne $pass2) {
        $ui['lblPassErr'].Text = 'Passwords do not match.'
        return
    }
    $ui['lblPassErr'].Text = ''
    Show-Page 3
})

# ── Installer step helper ─────────────────────────────────
function Set-Step([string]$stepKey, [string]$state, [string]$label) {
    $el = $ui[$stepKey]
    switch ($state) {
        'active'  { $el.Text = "▸ $label"; $el.Foreground = [System.Windows.Media.Brushes]::White }
        'done'    { $el.Text = "✓ $label"; $el.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($GREEN))) }
        'error'   { $el.Text = "✗ $label"; $el.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($RED))) }
        default   { $el.Text = "  $label"; $el.Foreground = (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($SUBTEXT))) }
    }
    $ui['lblStatus'].Text = $label
    [System.Windows.Forms.Application]::DoEvents()
}

function Set-Progress([int]$val) {
    $anim = New-Object System.Windows.Media.Animation.DoubleAnimation
    $anim.To = $val
    $anim.Duration = [TimeSpan]::FromMilliseconds(300)
    $ui['pbar'].BeginAnimation([System.Windows.Controls.Primitives.RangeBase]::ValueProperty, $anim)
    [System.Windows.Forms.Application]::DoEvents()
}

# ── Install button ─────────────────────────────────────────
$ui['btnNext3'].Add_Click({
    $serverName = $ui['txtServerName'].Text.Trim()
    if ([string]::IsNullOrWhiteSpace($serverName)) { $serverName = 'Haven' }
    $adminUser = $ui['txtUser'].Text.Trim()
    $adminPass = $ui['txtPass'].Password

    # Determine tunnel settings
    $tunnelEnabled = 'false'
    $tunnelProvider = 'cloudflared'
    if ($ui['radCF'].IsChecked) { $tunnelEnabled = 'true'; $tunnelProvider = 'cloudflared' }
    elseif ($ui['radLT'].IsChecked) { $tunnelEnabled = 'true'; $tunnelProvider = 'localtunnel' }
    elseif ($ui['radPF'].IsChecked) { $tunnelEnabled = 'false' }
    else { $tunnelEnabled = 'false' }

    Show-Page 4
    Start-Sleep -Milliseconds 400

    # ── Step 1: Node.js ──
    Set-Step 'step1' 'active' 'Checking Node.js...'
    Set-Progress 5

    $nodeOk = $false
    try {
        $nodeVer = & node -v 2>$null
        if ($LASTEXITCODE -eq 0 -and $nodeVer) {
            $nodeOk = $true
            Set-Step 'step1' 'done' "Node.js $nodeVer found"
        }
    } catch {}

    if (-not $nodeOk) {
        Set-Step 'step1' 'active' 'Downloading Node.js...'
        Set-Progress 8
        try {
            $nodeInstaller = "$env:TEMP\node-setup.msi"
            $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
            $nodeUrl = "https://nodejs.org/dist/v22.15.0/node-v22.15.0-$arch.msi"
            [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
            (New-Object System.Net.WebClient).DownloadFile($nodeUrl, $nodeInstaller)
            Set-Progress 15
            Set-Step 'step1' 'active' 'Installing Node.js (this may take a moment)...'
            Start-Process msiexec.exe -ArgumentList "/i `"$nodeInstaller`" /qn /norestart" -Wait -NoNewWindow
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            $nodeVer = & node -v 2>$null
            if ($nodeVer) {
                Set-Step 'step1' 'done' "Node.js $nodeVer installed"
            } else {
                Set-Step 'step1' 'error' 'Node.js install may need a restart'
            }
        } catch {
            Set-Step 'step1' 'error' "Node.js install failed: $_"
        }
    }
    Set-Progress 20

    # ── Step 2: Dependencies ──
    Set-Step 'step2' 'active' 'Installing dependencies...'
    Push-Location $HAVEN_DIR
    try {
        $npmOut = & npm install --no-audit --no-fund 2>&1
        if ($ui['radLT'].IsChecked) { & npm install localtunnel --save 2>&1 | Out-Null }
        Set-Step 'step2' 'done' 'Dependencies installed'
    } catch {
        Set-Step 'step2' 'error' "npm install failed: $_"
    }
    Set-Progress 45

    # ── Step 3: Data directory ──
    Set-Step 'step3' 'active' 'Creating data directory...'
    if (!(Test-Path $DATA_DIR)) { New-Item -ItemType Directory -Path $DATA_DIR -Force | Out-Null }
    if ((Test-Path "$HAVEN_DIR\.env.example") -and !(Test-Path "$DATA_DIR\.env")) {
        Copy-Item "$HAVEN_DIR\.env.example" "$DATA_DIR\.env"
    }
    Set-Step 'step3' 'done' 'Data directory ready'
    Set-Progress 55

    # ── Step 4: SSL certificate ──
    Set-Step 'step4' 'active' 'Generating SSL certificate...'
    $certDir = "$DATA_DIR\certs"
    if (!(Test-Path "$certDir\cert.pem")) {
        if (!(Test-Path $certDir)) { New-Item -ItemType Directory -Path $certDir -Force | Out-Null }
        $opensslPath = Get-Command openssl -ErrorAction SilentlyContinue
        if ($opensslPath) {
            & openssl req -x509 -newkey rsa:2048 -keyout "$certDir\key.pem" -out "$certDir\cert.pem" -days 3650 -nodes -subj "/CN=Haven" 2>$null
            Set-Step 'step4' 'done' 'SSL certificate generated'
        } else {
            Set-Step 'step4' 'done' 'Skipped (OpenSSL not found, will use HTTP)'
        }
    } else {
        Set-Step 'step4' 'done' 'SSL certificate exists'
    }
    Set-Progress 70

    # ── Step 5: Configure server ──
    Set-Step 'step5' 'active' 'Configuring server...'
    try {
        $configScript = @"
const { initDatabase, getDb } = require('./src/database');
initDatabase();
const db = getDb();
db.prepare("INSERT OR REPLACE INTO server_settings(key,value) VALUES('server_name',?)").run('$($serverName -replace "'","''")');
db.prepare("INSERT OR REPLACE INTO server_settings(key,value) VALUES('tunnel_enabled',?)").run('$tunnelEnabled');
db.prepare("INSERT OR REPLACE INTO server_settings(key,value) VALUES('tunnel_provider',?)").run('$tunnelProvider');
"@
        if ($adminUser -and $adminPass) {
            $configScript += @"

const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync('$($adminPass -replace "'","''")', 12);
const existing = db.prepare("SELECT id FROM users WHERE username = ?").get('$adminUser');
if (!existing) {
  db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)").run('$adminUser', hash);
  console.log('Admin account created');
} else {
  console.log('User already exists');
}
"@
        }
        $configScript | & node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>eval(d));" 2>&1
        Set-Step 'step5' 'done' 'Server configured'
    } catch {
        Set-Step 'step5' 'error' "Config failed: $_"
    }
    Set-Progress 85

    # Mark tunnel configured so Start Haven.bat skips the prompt
    "configured" | Out-File "$DATA_DIR\.tunnel_configured" -Encoding ascii -NoNewline

    # ── Step 6: Shortcuts ──
    Set-Step 'step6' 'active' 'Creating shortcuts...'
    try {
        $shell = New-Object -ComObject WScript.Shell
        # Desktop shortcut
        $desktop = [Environment]::GetFolderPath('Desktop')
        $lnk = $shell.CreateShortcut("$desktop\Haven.lnk")
        $lnk.TargetPath = "$HAVEN_DIR\Start Haven.bat"
        $lnk.WorkingDirectory = $HAVEN_DIR
        $lnk.Description = "Launch Haven server"
        $lnk.Save()
        # Start Menu shortcut
        $startMenu = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
        $lnk2 = $shell.CreateShortcut("$startMenu\Haven.lnk")
        $lnk2.TargetPath = "$HAVEN_DIR\Start Haven.bat"
        $lnk2.WorkingDirectory = $HAVEN_DIR
        $lnk2.Description = "Launch Haven server"
        $lnk2.Save()
        Set-Step 'step6' 'done' 'Shortcuts created'
    } catch {
        Set-Step 'step6' 'done' 'Shortcuts skipped'
    }
    Pop-Location
    Set-Progress 100
    Start-Sleep -Milliseconds 600

    # ── Done ──
    $doneText = "Your server `"$serverName`" is ready."
    if ($tunnelEnabled -eq 'true') {
        $doneText += "`nA $tunnelProvider tunnel will start automatically when you launch Haven."
    }
    $ui['lblDone'].Text = $doneText
    $ui['lblShareLink'].Text = "Double-click 'Start Haven' to begin!"
    Show-Page 5
})

# ── Final page actions ─────────────────────────────────────
$ui['btnLaunch'].Add_Click({
    Start-Process "$HAVEN_DIR\Start Haven.bat"
    $window.Close()
})
$ui['btnClose'].Add_Click({ $window.Close() })

# ═══════════════════════════════════════════════════════════
# Show window
# ═══════════════════════════════════════════════════════════
$window.ShowDialog() | Out-Null
