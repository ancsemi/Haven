// ═══════════════════════════════════════════════════════════
// Haven — Shared Theme Switcher (loaded on all pages)
// ═══════════════════════════════════════════════════════════

// ── Color-conversion helpers ────────────────────────────
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r, g, b;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function rgbToHex(r, g, b) { return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join(''); }
function hsvToHex(h, s, v) { return rgbToHex(...hsvToRgb(h, s, v)); }

// ── Generate full theme palette from a single HSV accent ─
// vibrancy: 0-1, controls how much the hue tints backgrounds/text/borders
function generateCustomPalette(h, s, v, vibrancy) {
  if (vibrancy === undefined) vibrancy = 0.5;
  const vib = Math.max(0, Math.min(1, vibrancy));
  const rgb = hsvToRgb(h, s, v);

  // Background saturation scales with vibrancy (0.05 at 0, 0.35 at 1)
  const bgSat = 0.05 + vib * 0.30;
  // Border & hover saturation
  const bdrSat = 0.05 + vib * 0.25;
  // Text tinting: at high vibrancy, text leans toward the hue
  const txtS   = vib * 0.12;
  const txtPri = hsvToHex(h, txtS, 0.90 + vib * 0.05);
  const txtSec = hsvToHex(h, txtS + 0.02, 0.62 + vib * 0.05);
  const txtMut = hsvToHex(h, txtS, 0.38 + vib * 0.04);

  return {
    '--accent':        hsvToHex(h, s, v),
    '--accent-hover':  hsvToHex(h, Math.max(s - 0.15, 0), Math.min(v + 0.15, 1)),
    '--accent-dim':    hsvToHex(h, Math.min(s + 0.1, 1), Math.max(v - 0.2, 0)),
    '--accent-glow':   `rgba(${rgb.join(',')}, ${(0.15 + vib * 0.20).toFixed(2)})`,
    '--bg-primary':    hsvToHex(h, bgSat, 0.07 + vib * 0.03),
    '--bg-secondary':  hsvToHex(h, bgSat * 0.85, 0.09 + vib * 0.04),
    '--bg-tertiary':   hsvToHex(h, bgSat * 0.7, 0.12 + vib * 0.04),
    '--bg-hover':      hsvToHex(h, bgSat * 0.7, 0.15 + vib * 0.05),
    '--bg-active':     hsvToHex(h, bgSat * 0.7, 0.18 + vib * 0.06),
    '--bg-input':      hsvToHex(h, bgSat, 0.05 + vib * 0.03),
    '--bg-card':       hsvToHex(h, bgSat * 0.85, 0.08 + vib * 0.04),
    '--text-primary':  txtPri,
    '--text-secondary': txtSec,
    '--text-muted':    txtMut,
    '--text-link':     hsvToHex((h + 180) % 360, 0.5 + vib * 0.2, 0.95),
    '--border':        hsvToHex(h, bdrSat, 0.16 + vib * 0.06),
    '--border-light':  hsvToHex(h, bdrSat, 0.21 + vib * 0.06),
    '--success':       hsvToHex((h + 140) % 360, 0.55, 0.72),
    '--danger':        hsvToHex((h + 350) % 360, 0.70, 0.94),
    '--warning':       hsvToHex((h + 50) % 360, 0.75, 0.94),
    '--led-on':        hsvToHex((h + 140) % 360, 0.55, 0.72),
    '--led-off':       '#555',
    '--led-glow':      `rgba(${hsvToRgb((h + 140) % 360, 0.55, 0.72).join(',')}, 0.5)`,
  };
}

// ── Apply / clear custom theme CSS variables ────────────
function applyCustomVars(palette) {
  const el = document.documentElement;
  Object.entries(palette).forEach(([k, v]) => el.style.setProperty(k, v));
}
function clearCustomVars() {
  const keys = ['--accent','--accent-hover','--accent-dim','--accent-glow',
    '--bg-primary','--bg-secondary','--bg-tertiary','--bg-hover','--bg-active',
    '--bg-input','--bg-card','--text-primary','--text-secondary','--text-muted',
    '--text-link','--border','--border-light','--success','--danger','--warning',
    '--led-on','--led-off','--led-glow'];
  keys.forEach(k => document.documentElement.style.removeProperty(k));
}

// ═══════════════════════════════════════════════════════════
// RGB CYCLING THEME
// ═══════════════════════════════════════════════════════════
let _rgbInterval = null;
let _rgbHue = 0;

function startRgbCycle() {
  stopRgbCycle();
  const saved = JSON.parse(localStorage.getItem('haven_rgb_settings') || 'null');
  let speed    = saved ? saved.speed    : 30;   // 1-100
  let vibrancy = saved ? saved.vibrancy : 75;   // 10-100

  // Fixed 16ms tick (~60 fps). Speed controls hue step per tick:
  // speed 1 → 0.8°/tick (50°/sec), speed 100 → 4.0°/tick (250°/sec)
  const TICK = 16;
  function getStep() { return 0.8 + (speed / 100) * 3.2; }

  _rgbInterval = setInterval(() => {
    _rgbHue = (_rgbHue + getStep()) % 360;
    const vib = vibrancy / 100;
    const palette = generateCustomPalette(_rgbHue, 0.75, 0.95, vib);
    applyCustomVars(palette);
  }, TICK);

  // Expose updaters so sliders can adjust live (no restart needed — step recalcs each tick)
  startRgbCycle._setSpeed = (v) => {
    speed = v;
    localStorage.setItem('haven_rgb_settings', JSON.stringify({ speed, vibrancy }));
  };
  startRgbCycle._setVibrancy = (v) => {
    vibrancy = v;
    localStorage.setItem('haven_rgb_settings', JSON.stringify({ speed, vibrancy }));
  };
}

function stopRgbCycle() {
  if (_rgbInterval) { clearInterval(_rgbInterval); _rgbInterval = null; }
  startRgbCycle._setSpeed = null;
  startRgbCycle._setVibrancy = null;
}

function initRgbEditor() {
  const editor = document.getElementById('rgb-theme-editor');
  if (!editor) return;

  const speedSlider    = document.getElementById('rgb-speed-slider');
  const vibrancySlider = document.getElementById('rgb-vibrancy-slider');
  if (!speedSlider || !vibrancySlider) return;

  const saved = JSON.parse(localStorage.getItem('haven_rgb_settings') || 'null');
  if (saved) {
    speedSlider.value    = saved.speed;
    vibrancySlider.value = saved.vibrancy;
  }

  speedSlider.addEventListener('input', () => {
    if (startRgbCycle._setSpeed) startRgbCycle._setSpeed(parseInt(speedSlider.value, 10));
  });
  vibrancySlider.addEventListener('input', () => {
    if (startRgbCycle._setVibrancy) startRgbCycle._setVibrancy(parseInt(vibrancySlider.value, 10));
  });

  editor._show = () => { editor.style.display = 'block'; };
  editor._hide = () => { editor.style.display = 'none'; };
}

// ════════════════════════════════════════════════════════════
// EFFECT SPEED SLIDER (for themes with CSS animations)
// ════════════════════════════════════════════════════════════
const DYNAMIC_THEMES = ['crt','ffx','ice','nord','darksouls','bloodborne','matrix','cyberpunk','lotr'];

function initEffectSpeedEditor() {
  const editor = document.getElementById('effect-speed-editor');
  const slider = document.getElementById('effect-speed-slider');
  if (!editor || !slider) return;

  // Restore saved multiplier
  const saved = parseFloat(localStorage.getItem('haven_fx_mult'));
  if (!isNaN(saved)) {
    slider.value = Math.round(saved * 100);
    document.documentElement.style.setProperty('--fx-mult', saved);
  }

  slider.addEventListener('input', () => {
    // slider 10-200 → multiplier 0.1-2.0  (lower = faster, higher = slower)
    const mult = parseInt(slider.value, 10) / 100;
    document.documentElement.style.setProperty('--fx-mult', mult);
    localStorage.setItem('haven_fx_mult', mult);
  });

  editor._show = () => { editor.style.display = 'block'; };
  editor._hide = () => { editor.style.display = 'none'; };
}

function showEffectEditorIfDynamic(theme) {
  const editor = document.getElementById('effect-speed-editor');
  if (!editor) return;
  if (DYNAMIC_THEMES.includes(theme)) {
    if (editor._show) editor._show();
  } else {
    if (editor._hide) editor._hide();
  }
}

// ── Barycentric maths for the triangle ──────────────────
function bary(px, py, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const u = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const v = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  return { u, v, w: 1 - u - v };
}

// ── Draw hue rainbow bar on canvas ──────────────────────
function drawHueBar(ctx, w, h, selectedHue) {
  for (let x = 0; x < w; x++) {
    const [r, g, b] = hsvToRgb((x / w) * 360, 1, 1);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, 0, 1, h);
  }
  // Indicator line
  const ix = Math.round((selectedHue / 360) * w);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(ix, 0); ctx.lineTo(ix, h); ctx.stroke();
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(ix, 0); ctx.lineTo(ix, h); ctx.stroke();
}

// ── Draw SV triangle on canvas ──────────────────────────
function drawTriangle(ctx, w, h, hue, selS, selV) {
  const pad = 8;
  const ax = w / 2, ay = pad;
  const bx = pad,   by = h - pad;
  const cx = w - pad, cy = h - pad;

  const pureRgb = hsvToRgb(hue, 1, 1);
  const img = ctx.createImageData(w, h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bc = bary(x, y, ax, ay, bx, by, cx, cy);
      if (bc.u < -0.005 || bc.v < -0.005 || bc.w < -0.005) continue;
      const u = Math.max(0, bc.u), v = Math.max(0, bc.v), ww = Math.max(0, bc.w);
      const sum = u + v + ww;
      const nu = u / sum, nv = v / sum, nw = ww / sum;
      const i = (y * w + x) * 4;
      img.data[i]     = nu * pureRgb[0] + nv * 255;
      img.data[i + 1] = nu * pureRgb[1] + nv * 255;
      img.data[i + 2] = nu * pureRgb[2] + nv * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.closePath(); ctx.stroke();

  const su = selS * selV, sv = (1 - selS) * selV, sw = 1 - selV;
  const px = su * ax + sv * bx + sw * cx;
  const py = su * ay + sv * by + sw * cy;

  ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
}

// ── Initialise the custom-theme triangle editor ─────────
function initCustomThemeEditor() {
  const editor = document.getElementById('custom-theme-editor');
  if (!editor) return;

  const hueCanvas  = document.getElementById('custom-hue-bar');
  const triCanvas  = document.getElementById('custom-triangle');
  if (!hueCanvas || !triCanvas) return;

  const hueCtx = hueCanvas.getContext('2d');
  const triCtx = triCanvas.getContext('2d');

  const saved = JSON.parse(localStorage.getItem('haven_custom_hsv') || 'null');
  let hue = saved ? saved.h : 260;
  let sat = saved ? saved.s : 0.75;
  let val = saved ? saved.v : 0.95;

  function redrawHue() { drawHueBar(hueCtx, hueCanvas.width, hueCanvas.height, hue); }
  function redrawTri()  { drawTriangle(triCtx, triCanvas.width, triCanvas.height, hue, sat, val); }

  function apply() {
    const palette = generateCustomPalette(hue, sat, val, sat);
    applyCustomVars(palette);
    localStorage.setItem('haven_custom_hsv', JSON.stringify({ h: hue, s: sat, v: val }));
    const swatch = document.getElementById('custom-theme-swatch');
    if (swatch) swatch.style.background = palette['--accent'];
  }

  function render() { redrawHue(); redrawTri(); apply(); }

  // ── Hue bar interaction ──
  function hueFromEvent(e) {
    const r = hueCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min((e.clientX ?? e.touches[0].clientX) - r.left, r.width));
    hue = (x / r.width) * 360;
    render();
  }
  let hueDrag = false;
  hueCanvas.addEventListener('mousedown',  (e) => { hueDrag = true; hueFromEvent(e); });
  window.addEventListener('mousemove',     (e) => { if (hueDrag) hueFromEvent(e); });
  window.addEventListener('mouseup',       ()  => { hueDrag = false; });
  hueCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); hueFromEvent(e); });
  hueCanvas.addEventListener('touchmove',  (e) => { e.preventDefault(); hueFromEvent(e); });

  // ── Triangle interaction ──
  const pad = 8;
  const tw = triCanvas.width, th = triCanvas.height;
  const ax = tw / 2, ay = pad, bx = pad, by = th - pad, cx = tw - pad, cy = th - pad;

  function triFromEvent(e) {
    const r = triCanvas.getBoundingClientRect();
    const ex = (e.clientX ?? e.touches[0].clientX) - r.left;
    const ey = (e.clientY ?? e.touches[0].clientY) - r.top;
    const px = ex * (tw / r.width), py = ey * (th / r.height);
    const bc = bary(px, py, ax, ay, bx, by, cx, cy);
    let u = Math.max(0, bc.u), v = Math.max(0, bc.v), w = Math.max(0, bc.w);
    const sum = u + v + w; u /= sum; v /= sum; w /= sum;
    val = Math.max(0.01, u + v);
    sat = val > 0 ? u / val : 0;
    render();
  }
  let triDrag = false;
  triCanvas.addEventListener('mousedown',  (e) => { triDrag = true; triFromEvent(e); });
  window.addEventListener('mousemove',     (e) => { if (triDrag) triFromEvent(e); });
  window.addEventListener('mouseup',       ()  => { triDrag = false; });
  triCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); triFromEvent(e); });
  triCanvas.addEventListener('touchmove',  (e) => { e.preventDefault(); triFromEvent(e); });

  render();

  editor._show = () => { editor.style.display = 'block'; render(); };
  editor._hide = () => { editor.style.display = 'none'; };
}

// ────────────────────────────────────────────────────────
// Main theme-switcher init (shared on all pages)
// ────────────────────────────────────────────────────────
function initThemeSwitcher(containerId, socket) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const saved = localStorage.getItem('haven_theme') || 'haven';
  const customEditor = document.getElementById('custom-theme-editor');
  const rgbEditor    = document.getElementById('rgb-theme-editor');

  // If custom was saved, apply vars immediately
  if (saved === 'custom') {
    const hsv = JSON.parse(localStorage.getItem('haven_custom_hsv') || 'null');
    if (hsv) applyCustomVars(generateCustomPalette(hsv.h, hsv.s, hsv.v, hsv.s));
  }
  // If rgb was saved, start cycling
  if (saved === 'rgb') {
    startRgbCycle();
  }

  // Set active button
  container.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === saved);

    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('haven_theme', theme);

      document.querySelectorAll('.theme-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.theme === theme);
      });

      if (socket && socket.connected) {
        socket.emit('set-preference', { key: 'theme', value: theme });
      }

      // Stop RGB cycle whenever switching away
      stopRgbCycle();

      if (theme === 'custom') {
        const hsv = JSON.parse(localStorage.getItem('haven_custom_hsv') || 'null');
        if (hsv) applyCustomVars(generateCustomPalette(hsv.h, hsv.s, hsv.v, hsv.s));
        if (customEditor && customEditor._show) customEditor._show();
        if (rgbEditor && rgbEditor._hide) rgbEditor._hide();
      } else if (theme === 'rgb') {
        clearCustomVars();
        startRgbCycle();
        if (customEditor && customEditor._hide) customEditor._hide();
        if (rgbEditor && rgbEditor._show) rgbEditor._show();
      } else {
        clearCustomVars();
        if (customEditor && customEditor._hide) customEditor._hide();
        if (rgbEditor && rgbEditor._hide) rgbEditor._hide();
      }
      showEffectEditorIfDynamic(theme);
    });
  });

  // Initialise editors
  initCustomThemeEditor();
  initRgbEditor();
  initEffectSpeedEditor();

  // Show correct editor on load
  if (saved === 'custom' && customEditor && customEditor._show) {
    setTimeout(() => customEditor._show(), 50);
  }
  if (saved === 'rgb' && rgbEditor && rgbEditor._show) {
    setTimeout(() => rgbEditor._show(), 50);
  }
  showEffectEditorIfDynamic(saved);
}

function applyThemeFromServer(theme) {
  if (!theme) return;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('haven_theme', theme);
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === theme);
  });
  stopRgbCycle();
  if (theme === 'custom') {
    const hsv = JSON.parse(localStorage.getItem('haven_custom_hsv') || 'null');
    if (hsv) applyCustomVars(generateCustomPalette(hsv.h, hsv.s, hsv.v, hsv.s));
    const editor = document.getElementById('custom-theme-editor');
    if (editor && editor._show) editor._show();
  } else if (theme === 'rgb') {
    clearCustomVars();
    startRgbCycle();
    const editor = document.getElementById('rgb-theme-editor');
    if (editor && editor._show) editor._show();
  } else {
    clearCustomVars();
    const customEditor = document.getElementById('custom-theme-editor');
    if (customEditor && customEditor._hide) customEditor._hide();
    const rgbEditor = document.getElementById('rgb-theme-editor');
    if (rgbEditor && rgbEditor._hide) rgbEditor._hide();
  }
  showEffectEditorIfDynamic(theme);
}
