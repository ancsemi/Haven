// ═══════════════════════════════════════════════════════════
// Shippy Container — Haven Mini-Game (External JS for CSP)
// ═══════════════════════════════════════════════════════════

// Apply saved theme immediately
const savedTheme = localStorage.getItem('haven_theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  // Back button handler
  document.getElementById('back-btn').addEventListener('click', () => {
    window.close();
    window.location.href = '/app';
  });

  // ── Leaderboard slide-out toggle (mobile) ─────────────
  const lbPanel = document.getElementById('leaderboard-panel');
  const lbToggle = document.getElementById('lb-toggle-btn');
  const lbBackdrop = document.getElementById('lb-backdrop');
  function toggleLB() {
    const open = lbPanel.classList.toggle('lb-open');
    lbBackdrop.classList.toggle('lb-open', open);
  }
  if (lbToggle) lbToggle.addEventListener('click', toggleLB);
  if (lbBackdrop) lbBackdrop.addEventListener('click', toggleLB);

  // ── Sound: blip on flap ──────────────────────────────
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioCtx = null;

  function playBlip() {
    try {
      if (!audioCtx) audioCtx = new AudioCtx();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'square';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.1);
      osc.start(audioCtx.currentTime);
      osc.stop(audioCtx.currentTime + 0.1);
    } catch { /* audio not available */ }
  }

  // ── Player Avatar (loaded from image file) ──
  const BIRD_SIZE = 44;

  const birdImg = new Image();
  birdImg.src = '/games/bird-avatar.png';

  function drawBird(x, y) {
    if (birdImg.complete && birdImg.naturalWidth > 0) {
      ctx.drawImage(birdImg, x, y, BIRD_SIZE, BIRD_SIZE);
    } else {
      // Minimal placeholder while image loads
      ctx.fillStyle = '#7c5cfc';
      ctx.beginPath();
      ctx.arc(x + BIRD_SIZE / 2, y + BIRD_SIZE / 2, BIRD_SIZE / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Shipping Container Pipe ──────────────────────────
  const PIPE_W = 70;
  const GAP = 160;
  const PIPE_SPEED = 2.5;
  const CONTAINER_H = 30;

  const CONTAINER_COLORS = [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
    '#9b59b6', '#1abc9c', '#e67e22', '#c0392b'
  ];

  function drawContainer(x, y, w, h, colorIdx) {
    const color = CONTAINER_COLORS[colorIdx % CONTAINER_COLORS.length];
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 0.8;
    for (let rx = x + 8; rx < x + w - 4; rx += 10) {
      ctx.beginPath();
      ctx.moveTo(rx, y + 1);
      ctx.lineTo(rx, y + h - 1);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(x, y, w, h * 0.3);
  }

  function drawPipeColumn(x, topH, bottomY, colorSeed) {
    let cy = topH - CONTAINER_H;
    let idx = colorSeed;
    while (cy >= -CONTAINER_H) {
      drawContainer(x, cy, PIPE_W, CONTAINER_H - 2, idx);
      cy -= CONTAINER_H;
      idx++;
    }
    cy = bottomY;
    idx = colorSeed + 3;
    while (cy < H) {
      drawContainer(x, cy, PIPE_W, CONTAINER_H - 2, idx);
      cy += CONTAINER_H;
      idx++;
    }
  }

  // ── Background: ocean + clouds ────────────────────────
  function drawBackground() {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#0a1628');
    grad.addColorStop(0.6, '#132744');
    grad.addColorStop(1, '#1a3a5c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    for (let i = 0; i < 40; i++) {
      const sx = (i * 137 + 50) % W;
      const sy = (i * 91 + 20) % (H * 0.5);
      ctx.fillRect(sx, sy, 1.5, 1.5);
    }

    ctx.fillStyle = 'rgba(30,80,140,0.4)';
    ctx.fillRect(0, H - 40, W, 40);
    ctx.fillStyle = 'rgba(60,120,180,0.2)';
    for (let wx = 0; wx < W; wx += 30) {
      ctx.fillRect(wx + Math.sin(Date.now() / 1000 + wx) * 5, H - 38, 20, 2);
    }
  }

  // ── Game State ────────────────────────────────────────
  let bird = { x: 80, y: H / 2, vy: 0 };
  let pipes = [];
  let score = 0;
  let best = parseInt(localStorage.getItem('haven_shippy_best') || '0');
  let state = 'waiting';
  let frameCount = 0;
  let lastTime = 0;            // For delta-time physics
  let pipeTimer = 0;           // Time-based pipe spawning (ms)
  const TARGET_DT = 1000 / 60; // Baseline 60 fps
  const PIPE_INTERVAL = 1500;  // Spawn pipe every 1.5 seconds

  document.getElementById('best-display').textContent = best;

  function resetGame() {
    bird = { x: 80, y: H / 2, vy: 0 };
    pipes = [];
    score = 0;
    frameCount = 0;
    pipeTimer = 0;
    lastTime = 0;
    document.getElementById('score-display').textContent = '0';
  }

  function flap() {
    if (state === 'waiting') {
      state = 'playing';
      resetGame();
    }
    if (state === 'dead') {
      state = 'waiting';
      resetGame();
      return;
    }
    bird.vy = -6.5;
    playBlip();
  }

  // ── Input ─────────────────────────────────────────────
  canvas.addEventListener('click', flap);
  canvas.addEventListener('touchstart', (e) => { e.preventDefault(); flap(); }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp') {
      e.preventDefault();
      flap();
    }
  });

  // ── Game Loop ─────────────────────────────────────────
  function spawnPipe() {
    const minTop = 80;
    const maxTop = H - GAP - 80;
    const topH = minTop + Math.random() * (maxTop - minTop);
    pipes.push({
      x: W + 10,
      topH,
      bottomY: topH + GAP,
      scored: false,
      colorSeed: Math.floor(Math.random() * CONTAINER_COLORS.length)
    });
  }

  function update(dt) {
    if (state !== 'playing') return;

    // Normalize physics to 60 fps baseline; cap to prevent huge jumps on tab-switch
    const scale = Math.min(dt / TARGET_DT, 3);

    frameCount++;
    bird.vy += 0.35 * scale;
    bird.y += bird.vy * scale;

    pipeTimer += dt;
    if (pipeTimer >= PIPE_INTERVAL) {
      pipeTimer -= PIPE_INTERVAL;
      spawnPipe();
    }

    for (let i = pipes.length - 1; i >= 0; i--) {
      const p = pipes[i];
      p.x -= PIPE_SPEED * scale;

      if (!p.scored && p.x + PIPE_W < bird.x) {
        p.scored = true;
        score++;
        document.getElementById('score-display').textContent = score;
      }

      if (p.x + PIPE_W < -10) {
        pipes.splice(i, 1);
      }
    }

    if (bird.y < 0 || bird.y + BIRD_SIZE > H - 40) {
      die();
      return;
    }

    for (const p of pipes) {
      if (bird.x + BIRD_SIZE - 4 > p.x && bird.x + 4 < p.x + PIPE_W) {
        if (bird.y + 4 < p.topH || bird.y + BIRD_SIZE - 4 > p.bottomY) {
          die();
          return;
        }
      }
    }
  }

  // ── Auth token from URL hash (for REST API fallback) ──
  const _hashParams = new URLSearchParams(location.hash.replace('#', ''));
  const _authToken = _hashParams.get('token') || localStorage.getItem('haven_token') || '';
  const _useRest = !window.opener; // mobile browsers null-out opener

  function die() {
    state = 'dead';
    if (score > best) {
      best = score;
      localStorage.setItem('haven_shippy_best', String(best));
      document.getElementById('best-display').textContent = best;
    }

    if (_useRest) {
      // Mobile / no opener — submit via REST and fetch leaderboard
      if (_authToken && score > 0) {
        fetch('/api/high-scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _authToken },
          body: JSON.stringify({ game: 'flappy', score })
        }).then(r => r.json()).then(d => renderLeaderboard(d.leaderboard)).catch(() => {});
      } else {
        requestLeaderboard();
      }
    } else {
      try { window.opener.postMessage({ type: 'flappy-score', score: score }, '*'); } catch {}
      requestLeaderboard();
    }
  }

  // ── Leaderboard (postMessage primary, REST fallback) ──
  function requestLeaderboard() {
    if (_useRest) {
      fetch('/api/high-scores/flappy')
        .then(r => r.json())
        .then(d => renderLeaderboard(d.leaderboard))
        .catch(() => {});
      return;
    }
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'get-leaderboard' }, '*');
      }
    } catch { /* opener closed — try REST */
      fetch('/api/high-scores/flappy').then(r => r.json()).then(d => renderLeaderboard(d.leaderboard)).catch(() => {});
    }
  }

  function renderLeaderboard(data) {
    const list = document.getElementById('leaderboard-list');
    if (!list) return;
    if (!data || !data.length) {
      list.innerHTML = '<p style="font-size:11px;color:var(--text-muted)">No scores yet</p>';
      return;
    }
    list.innerHTML = data.slice(0, 20).map((s, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.';
      const name = s.username.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
      return `<div class="lb-row"><span class="lb-rank">${medal}</span><span class="lb-name">${name}</span><span class="lb-score">${s.score}</span></div>`;
    }).join('');
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'leaderboard-data') {
      renderLeaderboard(e.data.leaderboard);
    }
  });

  // Request leaderboard on load
  requestLeaderboard();

  function draw() {
    drawBackground();

    for (const p of pipes) {
      drawPipeColumn(p.x, p.topH, p.bottomY, p.colorSeed);
    }

    drawBird(bird.x, bird.y);

    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = 'bold 36px monospace';
    ctx.textAlign = 'center';
    if (state === 'playing') {
      ctx.fillText(score, W / 2, 60);
    }

    if (state === 'waiting') {
      drawOverlay('� Shippy Container', 'Click or press Space to start');
    } else if (state === 'dead') {
      drawOverlay('Score: ' + score, 'Click or press Space to retry');
      if (score === best && score > 0) {
        ctx.fillStyle = '#ffc107';
        ctx.font = 'bold 18px sans-serif';
        ctx.fillText('\u2b50 New Best! \u2b50', W / 2, H / 2 + 40);
      }
    }
  }

  function drawOverlay(title, sub) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, H / 2 - 60, W, 100);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, W / 2, H / 2 - 15);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '16px sans-serif';
    ctx.fillText(sub, W / 2, H / 2 + 18);
  }

  function gameLoop(timestamp) {
    const dt = lastTime ? (timestamp - lastTime) : TARGET_DT;
    lastTime = timestamp;
    update(dt);
    draw();
    requestAnimationFrame(gameLoop);
  }

  requestAnimationFrame(gameLoop);
});
