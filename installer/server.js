// ═══════════════════════════════════════════════════════════
// Haven — Web-based Installer Server
// Uses ONLY Node.js built-in modules (no npm install needed)
// ═══════════════════════════════════════════════════════════
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const os = require('os');

const HAVEN_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const DATA_DIR = IS_WIN
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Haven')
  : path.join(os.homedir(), '.haven');

// ── Serve the installer HTML ──────────────────────────────
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// ── HTTP Server ───────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Only allow localhost connections
  const host = req.socket.remoteAddress;
  if (host !== '127.0.0.1' && host !== '::1' && host !== '::ffff:127.0.0.1') {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/check') {
    let nodeVersion = '';
    try { nodeVersion = process.version; } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      platform: process.platform,
      nodeVersion,
      dataDir: DATA_DIR,
      alreadyInstalled: fs.existsSync(path.join(DATA_DIR, '.tunnel_configured'))
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/install') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let config;
      try { config = JSON.parse(body); } catch {
        res.writeHead(400); res.end('Bad JSON'); return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      runInstall(config, res);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/launch') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    launchHaven();
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── Pick a random available port and start ────────────────
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  console.log(`\n  Haven Installer running at ${url}\n`);

  // Open browser
  try {
    if (IS_WIN) {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    console.log(`  Open this URL in your browser: ${url}`);
  }
});

// ── SSE helper ────────────────────────────────────────────
function send(res, data) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
}

// ── Run a command and return a promise ────────────────────
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || HAVEN_DIR,
      env: { ...process.env, ...opts.env },
      shell: IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(err || out || `Exit code ${code}`));
    });
    child.on('error', reject);
  });
}

// ── Installation pipeline ─────────────────────────────────
async function runInstall(config, res) {
  const { serverName, adminUser, adminPass, tunnel } = config;
  let hasError = false;

  try {
    // ── Step 1: Install npm dependencies ──
    send(res, { step: 'deps', state: 'active', label: 'Installing dependencies\u2026', progress: 5 });
    try {
      const npmCmd = IS_WIN ? 'npm.cmd' : 'npm';
      const npmArgs = ['install', '--no-audit', '--no-fund'];
      if (tunnel === 'localtunnel') npmArgs.push('localtunnel');
      await run(npmCmd, npmArgs);
      send(res, { step: 'deps', state: 'done', label: 'Dependencies installed', progress: 35 });
    } catch (e) {
      send(res, { step: 'deps', state: 'error', label: 'npm install failed: ' + e.message, progress: 35 });
      hasError = true;
    }

    // ── Step 2: Create data directory ──
    send(res, { step: 'datadir', state: 'active', label: 'Creating data directory\u2026', progress: 40 });
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const envExample = path.join(HAVEN_DIR, '.env.example');
      const envDest = path.join(DATA_DIR, '.env');
      if (fs.existsSync(envExample) && !fs.existsSync(envDest)) {
        fs.copyFileSync(envExample, envDest);
      }
      send(res, { step: 'datadir', state: 'done', label: 'Data directory ready', progress: 45 });
    } catch (e) {
      send(res, { step: 'datadir', state: 'error', label: 'Data dir failed: ' + e.message, progress: 45 });
      hasError = true;
    }

    // ── Step 3: Generate SSL certificate ──
    send(res, { step: 'ssl', state: 'active', label: 'Generating SSL certificate\u2026', progress: 50 });
    const certDir = path.join(DATA_DIR, 'certs');
    const certPath = path.join(certDir, 'cert.pem');
    const keyPath = path.join(certDir, 'key.pem');
    if (fs.existsSync(certPath)) {
      send(res, { step: 'ssl', state: 'done', label: 'SSL certificate exists', progress: 60 });
    } else {
      try {
        fs.mkdirSync(certDir, { recursive: true });
        // Detect local IP for SAN extension
        let localIp = '127.0.0.1';
        try {
          const nets = os.networkInterfaces();
          for (const ifaces of Object.values(nets)) {
            for (const iface of ifaces) {
              if (!iface.internal && iface.family === 'IPv4') { localIp = iface.address; break; }
            }
            if (localIp !== '127.0.0.1') break;
          }
        } catch {}

        const sanArg = IS_WIN ? [] : ['-addext', `subjectAltName=IP:127.0.0.1,IP:${localIp},DNS:localhost`];
        await run('openssl', [
          'req', '-x509', '-newkey', 'rsa:2048',
          '-keyout', keyPath, '-out', certPath,
          '-days', '3650', '-nodes', '-subj', '/CN=Haven',
          ...sanArg
        ]);
        send(res, { step: 'ssl', state: 'done', label: 'SSL certificate generated', progress: 60 });
      } catch {
        send(res, { step: 'ssl', state: 'done', label: 'Skipped (OpenSSL not found, will use HTTP)', progress: 60 });
      }
    }

    // ── Step 4: Configure server ──
    send(res, { step: 'config', state: 'active', label: 'Configuring server\u2026', progress: 65 });
    try {
      const tunnelEnabled = (tunnel === 'cloudflare' || tunnel === 'localtunnel') ? 'true' : 'false';
      const tunnelProvider = tunnel === 'cloudflare' ? 'cloudflared' :
                             tunnel === 'localtunnel' ? 'localtunnel' : '';

      // Build a configuration script that uses the project's own database module
      // Write to a temp file to avoid shell escaping issues on Windows
      const configScript = `
const { initDatabase, getDb } = require('./src/database');
initDatabase();
const db = getDb();
db.prepare("INSERT OR REPLACE INTO server_settings(key,value) VALUES('server_name',?)").run(${JSON.stringify(serverName || 'Haven')});
db.prepare("INSERT OR REPLACE INTO server_settings(key,value) VALUES('tunnel_enabled',?)").run(${JSON.stringify(tunnelEnabled)});
db.prepare("INSERT OR REPLACE INTO server_settings(key,value) VALUES('tunnel_provider',?)").run(${JSON.stringify(tunnelProvider)});
${adminUser && adminPass ? `
const bcrypt = require('bcryptjs');
const hash = bcrypt.hashSync(${JSON.stringify(adminPass)}, 12);
const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(${JSON.stringify(adminUser)});
if (!existing) {
  db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)").run(${JSON.stringify(adminUser)}, hash);
  console.log('Admin account created');
} else {
  console.log('User already exists, skipping');
}
` : ''}
`;

      const tmpScript = path.join(os.tmpdir(), `haven-config-${Date.now()}.js`);
      fs.writeFileSync(tmpScript, configScript);
      try {
        await run('node', [tmpScript], { cwd: HAVEN_DIR });
        send(res, { step: 'config', state: 'done', label: 'Server configured', progress: 80 });
      } finally {
        try { fs.unlinkSync(tmpScript); } catch {}
      }
    } catch (e) {
      send(res, { step: 'config', state: 'error', label: 'Config failed: ' + e.message, progress: 80 });
      hasError = true;
    }

    // Mark tunnel as configured
    try {
      fs.writeFileSync(path.join(DATA_DIR, '.tunnel_configured'), 'configured');
    } catch {}

    // ── Step 5: Create shortcuts (Windows only) ──
    send(res, { step: 'shortcuts', state: 'active', label: 'Creating shortcuts\u2026', progress: 85 });
    if (IS_WIN) {
      try {
        const desktop = path.join(os.homedir(), 'Desktop');
        const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
        const batPath = path.join(HAVEN_DIR, 'Start Haven.bat');

        const psScript = `
          $shell = New-Object -ComObject WScript.Shell
          $lnk = $shell.CreateShortcut('${desktop.replace(/'/g, "''")}\\Haven.lnk')
          $lnk.TargetPath = '${batPath.replace(/'/g, "''")}'
          $lnk.WorkingDirectory = '${HAVEN_DIR.replace(/'/g, "''")}'
          $lnk.Description = 'Launch Haven server'
          $lnk.Save()
          $lnk2 = $shell.CreateShortcut('${startMenu.replace(/'/g, "''")}\\Haven.lnk')
          $lnk2.TargetPath = '${batPath.replace(/'/g, "''")}'
          $lnk2.WorkingDirectory = '${HAVEN_DIR.replace(/'/g, "''")}'
          $lnk2.Description = 'Launch Haven server'
          $lnk2.Save()
        `.replace(/\n/g, '; ');

        await run('powershell.exe', ['-NoProfile', '-Command', psScript]);
        send(res, { step: 'shortcuts', state: 'done', label: 'Desktop & Start Menu shortcuts created', progress: 95 });
      } catch {
        send(res, { step: 'shortcuts', state: 'done', label: 'Shortcuts skipped', progress: 95 });
      }
    } else {
      // Linux: create a .desktop file if the desktop directory exists
      try {
        const desktopDir = path.join(os.homedir(), 'Desktop');
        const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
        const startSh = path.join(HAVEN_DIR, 'start.sh');

        const desktopEntry = [
          '[Desktop Entry]',
          'Type=Application',
          'Name=Haven',
          'Comment=Launch Haven private chat server',
          `Exec=bash "${startSh}"`,
          `Path=${HAVEN_DIR}`,
          'Terminal=true',
          'Categories=Network;Chat;',
          ''
        ].join('\n');

        if (fs.existsSync(desktopDir)) {
          const dFile = path.join(desktopDir, 'Haven.desktop');
          fs.writeFileSync(dFile, desktopEntry);
          try { fs.chmodSync(dFile, 0o755); } catch {}
        }
        fs.mkdirSync(appsDir, { recursive: true });
        fs.writeFileSync(path.join(appsDir, 'Haven.desktop'), desktopEntry);

        send(res, { step: 'shortcuts', state: 'done', label: 'Application shortcut created', progress: 95 });
      } catch {
        send(res, { step: 'shortcuts', state: 'done', label: 'Shortcuts skipped', progress: 95 });
      }
    }

    send(res, { progress: 100, done: true, error: hasError });
  } catch (e) {
    send(res, { done: true, error: true, message: e.message });
  }
  res.end();
}

// ── Launch Haven server ───────────────────────────────────
function launchHaven() {
  setTimeout(() => {
    if (IS_WIN) {
      // Launch Start Haven.bat in a new console window
      const batPath = path.join(HAVEN_DIR, 'Start Haven.bat');
      spawn('cmd', ['/c', 'start', '', 'cmd', '/c', batPath], {
        cwd: HAVEN_DIR,
        stdio: 'ignore',
        detached: true
      }).unref();
    } else {
      // Launch start.sh
      const shPath = path.join(HAVEN_DIR, 'start.sh');
      spawn('bash', [shPath], {
        cwd: HAVEN_DIR,
        stdio: 'ignore',
        detached: true
      }).unref();
    }

    // Shut down installer server after a brief delay
    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 2000);
  }, 500);
}
