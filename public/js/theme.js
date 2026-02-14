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
  const hasDynamic = [..._activeFx].some(fx => DYNAMIC_THEMES.includes(fx));
  if (hasDynamic) {
    if (editor._show) editor._show();
  } else {
    if (editor._hide) editor._hide();
  }
  // Show sacred intensity slider if religious effects are active
  const sacredEditor = document.getElementById('sacred-intensity-editor');
  if (!sacredEditor) return;
  const SACRED = ['scripture', 'chapel', 'gospel'];
  const hasSacred = [..._activeFx].some(fx => SACRED.includes(fx));
  if (hasSacred) {
    if (sacredEditor._show) sacredEditor._show();
  } else {
    if (sacredEditor._hide) sacredEditor._hide();
  }
}

// ── Sacred-effect intensity slider ──────────────────────────
const SACRED_THEMES = ['scripture', 'chapel', 'gospel'];

function initSacredIntensityEditor() {
  const editor = document.getElementById('sacred-intensity-editor');
  const slider = document.getElementById('sacred-intensity-slider');
  if (!editor || !slider) return;

  // Restore saved intensity
  const saved = parseFloat(localStorage.getItem('haven_fx_sacred_intensity'));
  if (!isNaN(saved)) {
    slider.value = Math.round(saved * 100);
    document.documentElement.style.setProperty('--fx-religious-intensity', saved);
  }

  slider.addEventListener('input', () => {
    // slider 20-250 → intensity 0.2 – 2.5
    const val = parseInt(slider.value, 10) / 100;
    document.documentElement.style.setProperty('--fx-religious-intensity', val);
    localStorage.setItem('haven_fx_sacred_intensity', val);
  });

  editor._show = () => { editor.style.display = 'block'; };
  editor._hide = () => { editor.style.display = 'none'; };
}

// ═══════════════════════════════════════════════════════════
// STACKABLE EFFECT LAYER SYSTEM
// ═══════════════════════════════════════════════════════════
const THEME_DEFAULT_FX = {
  crt: ['crt'], matrix: ['matrix'], fallout: ['fallout'], ffx: ['ffx'],
  ice: ['ice'], nord: ['nord'], darksouls: ['darksouls'], bloodborne: ['bloodborne'],
  cyberpunk: ['cyberpunk'], lotr: ['lotr'], abyss: ['abyss'],
  scripture: ['scripture'], chapel: ['chapel'], gospel: ['gospel']
};

let _activeFx = new Set();
let _matrixCtx = null, _matrixRAF = null, _matrixDrops = [];
let _emberCtx = null, _emberRAF = null, _embers = [];

// Layer definitions: each effect -> array of { id, parent, cls }
const FX_LAYERS = {
  crt:        [{ id: 'fx-crt-vignette', parent: '#fx-layers', cls: 'fx-crt-vignette' }],
  matrix:     [{ id: 'fx-matrix-bars', parent: '.sidebar', cls: 'fx-matrix-bars' }],
  fallout:    [{ id: 'fx-fallout-vignette', parent: '#fx-layers', cls: 'fx-fallout-vignette' }],
  ffx:        [{ id: 'fx-ffx-water', parent: '.sidebar', cls: 'fx-ffx-water' },
               { id: 'fx-ffx-wave', parent: '#fx-layers', cls: 'fx-ffx-wave' }],
  ice:        [{ id: 'fx-ice-shimmer', parent: '#fx-layers', cls: 'fx-ice-shimmer' },
               { id: 'fx-ice-icicle-ch', parent: '.channel-header', cls: 'fx-ice-icicle' },
               { id: 'fx-ice-icicle-sb', parent: '.sidebar-header', cls: 'fx-ice-icicle-sb' }],
  nord:       [{ id: 'fx-nord-snow', parent: '#fx-layers', cls: 'fx-nord-snow' }],
  darksouls:  [{ id: 'fx-ds-ember-glow', parent: '.sidebar', cls: 'fx-ds-ember-glow' },
               { id: 'fx-ds-fireline', parent: '#fx-layers', cls: 'fx-ds-fireline' },
               { id: 'fx-ds-ambient', parent: '#fx-layers', cls: 'fx-ds-ambient' }],
  bloodborne: [{ id: 'fx-bb-vignette', parent: '#fx-layers', cls: 'fx-bb-vignette' }],
  cyberpunk:  [],
  lotr:       [{ id: 'fx-lotr-candle', parent: '.sidebar', cls: 'fx-lotr-candle' }],
  abyss:      [{ id: 'fx-abyss-vignette', parent: '#fx-layers', cls: 'fx-abyss-vignette' }],
  scripture:  [{ id: 'fx-scripture-cross', parent: '.main', cls: 'fx-scripture-cross' }],
  chapel:     [{ id: 'fx-chapel-glass', parent: '.main', cls: 'fx-chapel-glass' }],
  gospel:     [{ id: 'fx-gospel-radiance', parent: '.main', cls: 'fx-gospel-radiance' }]
};

// CSS classes added to <html>
const FX_CLASSES = { crt: 'fx-crt', cyberpunk: 'fx-cyberpunk' };

// Effects that use JS canvas
const FX_CANVAS = {
  matrix: { start: _startMatrixRain, stop: _stopMatrixRain },
  darksouls: { start: _startEmbers, stop: _stopEmbers }
};

function _ensureFxLayers() {
  let c = document.getElementById('fx-layers');
  if (!c) {
    c = document.createElement('div');
    c.id = 'fx-layers';
    document.body.appendChild(c);
  }
  return c;
}

function _activateEffect(name) {
  if (_activeFx.has(name)) return;
  _activeFx.add(name);

  // CSS class on <html>
  if (FX_CLASSES[name]) document.documentElement.classList.add(FX_CLASSES[name]);

  // Overlay layers
  (FX_LAYERS[name] || []).forEach(layer => {
    if (document.getElementById(layer.id)) return;
    const parent = layer.parent === '#fx-layers'
      ? _ensureFxLayers()
      : document.querySelector(layer.parent);
    if (!parent) return;
    // Ensure parent is positioned
    if (layer.parent !== '#fx-layers') {
      const pos = getComputedStyle(parent).position;
      if (pos === 'static') parent.style.position = 'relative';
    }
    // Ice icicles need overflow visible
    if (name === 'ice' && (layer.cls === 'fx-ice-icicle' || layer.cls === 'fx-ice-icicle-sb')) {
      parent.classList.add('fx-ice-overflow');
    }
    const el = document.createElement('div');
    el.id = layer.id;
    el.className = 'fx-layer ' + layer.cls;
    parent.appendChild(el);
  });

  // Canvas-based effects
  if (FX_CANVAS[name]) FX_CANVAS[name].start();
}

function _deactivateEffect(name) {
  if (!_activeFx.has(name)) return;
  _activeFx.delete(name);

  if (FX_CLASSES[name]) document.documentElement.classList.remove(FX_CLASSES[name]);

  (FX_LAYERS[name] || []).forEach(layer => {
    const el = document.getElementById(layer.id);
    if (el) {
      // Clean up ice overflow
      if (name === 'ice' && el.parentElement) {
        el.parentElement.classList.remove('fx-ice-overflow');
      }
      el.remove();
    }
  });

  if (FX_CANVAS[name]) FX_CANVAS[name].stop();
}

function _deactivateAllEffects() {
  [..._activeFx].forEach(_deactivateEffect);
}

function applyEffects(mode) {
  _deactivateAllEffects();

  // Always strip theme pseudo-element effects — JS manages all overlays now
  document.documentElement.setAttribute('data-fx-custom', '');

  if (mode === 'none') return;

  if (mode === 'auto') {
    const theme = localStorage.getItem('haven_theme') || 'haven';
    const defaults = THEME_DEFAULT_FX[theme];
    if (defaults) defaults.forEach(_activateEffect);
    return;
  }

  // Custom array of effects
  if (Array.isArray(mode)) mode.forEach(_activateEffect);
}

// ── Matrix Digital Rain (canvas) ────────────────────────
function _startMatrixRain() {
  _stopMatrixRain();
  const container = _ensureFxLayers();
  const canvas = document.createElement('canvas');
  canvas.id = 'fx-matrix-rain';
  canvas.className = 'fx-canvas';
  canvas.style.zIndex = '-1';
  canvas.style.opacity = '0.35';
  container.appendChild(canvas);

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();

  _matrixCtx = canvas.getContext('2d');
  const fontSize = 14;
  const chars = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function initDrops() {
    const cols = Math.ceil(canvas.width / fontSize);
    _matrixDrops = new Array(cols).fill(0).map(() => Math.random() * -50);
  }
  initDrops();

  function draw() {
    _matrixCtx.fillStyle = 'rgba(0, 0, 0, 0.045)';
    _matrixCtx.fillRect(0, 0, canvas.width, canvas.height);
    _matrixCtx.font = fontSize + 'px monospace';

    const cols = Math.ceil(canvas.width / fontSize);
    for (let i = 0; i < cols; i++) {
      if (i >= _matrixDrops.length) _matrixDrops.push(Math.random() * -50);
      const ch = chars[Math.floor(Math.random() * chars.length)];
      const x = i * fontSize;
      const y = _matrixDrops[i] * fontSize;

      // Depth: varying brightness
      const bright = Math.random();
      if (bright > 0.92) {
        _matrixCtx.fillStyle = '#fff';
      } else {
        const g = Math.floor(60 + bright * 195);
        _matrixCtx.fillStyle = 'rgb(0,' + g + ',0)';
      }
      _matrixCtx.fillText(ch, x, y);

      if (y > canvas.height && Math.random() > 0.975) {
        _matrixDrops[i] = 0;
      }
      _matrixDrops[i] += 0.4 + Math.random() * 0.6;
    }
    _matrixRAF = requestAnimationFrame(draw);
  }
  draw();

  canvas._resizeHandler = () => { resize(); initDrops(); };
  window.addEventListener('resize', canvas._resizeHandler);
}

function _stopMatrixRain() {
  if (_matrixRAF) { cancelAnimationFrame(_matrixRAF); _matrixRAF = null; }
  const c = document.getElementById('fx-matrix-rain');
  if (c) {
    if (c._resizeHandler) window.removeEventListener('resize', c._resizeHandler);
    c.remove();
  }
  _matrixCtx = null;
}

// ── Dark Souls Rising Embers (canvas) ───────────────────
function _startEmbers() {
  _stopEmbers();
  const container = _ensureFxLayers();
  const canvas = document.createElement('canvas');
  canvas.id = 'fx-ds-embers';
  canvas.className = 'fx-canvas';
  canvas.style.zIndex = '1';
  container.appendChild(canvas);

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();

  _emberCtx = canvas.getContext('2d');
  _embers = [];

  function spawnEmber() {
    // Spawn concentrated toward center (flame-shaped distribution)
    const cx = canvas.width / 2;
    const spread = canvas.width * 0.25;
    const x = cx + (Math.random() - 0.5) * spread * 2 + (Math.random() - 0.5) * spread * 0.5;
    _embers.push({
      x: x,
      y: canvas.height + 5 + Math.random() * 10,
      vx: (Math.random() - 0.5) * 0.35,
      vy: -(1.2 + Math.random() * 2.5),
      size: 0.4 + Math.random() * 1.0,
      life: 1,
      decay: 0.003 + Math.random() * 0.008,
      hue: 12 + Math.random() * 30,
      flicker: Math.random() * Math.PI * 2,
      driftAmp: 0.2 + Math.random() * 0.4
    });
  }

  function draw() {
    _emberCtx.clearRect(0, 0, canvas.width, canvas.height);

    // Spawn fewer embers, concentrated in center
    const spawnRate = Math.max(1, Math.floor(canvas.width / 200));
    for (let s = 0; s < spawnRate; s++) {
      if (_embers.length < 35 && Math.random() > 0.7) spawnEmber();
    }

    for (let i = _embers.length - 1; i >= 0; i--) {
      const e = _embers[i];
      e.flicker += 0.12;
      e.x += e.vx + Math.sin(e.flicker) * e.driftAmp;
      // Center embers rise higher, edge embers die sooner
      const centerDist = Math.abs(e.x - canvas.width / 2) / (canvas.width / 2);
      const heightMult = 1 - centerDist * 0.4;
      e.y += e.vy * heightMult;
      e.life -= e.decay * (1 + centerDist * 0.8);

      if (e.life <= 0 || e.y < -10) { _embers.splice(i, 1); continue; }

      const alpha = e.life * 0.9;
      const sz = e.size * (0.3 + e.life * 0.7);

      // Core
      _emberCtx.globalAlpha = alpha;
      _emberCtx.fillStyle = 'hsl(' + e.hue + ',100%,' + Math.floor(50 + e.life * 35) + '%)';
      _emberCtx.beginPath();
      _emberCtx.arc(e.x, e.y, sz, 0, Math.PI * 2);
      _emberCtx.fill();

      // Flame-shaped glow (taller than wide)
      _emberCtx.globalAlpha = alpha * 0.35;
      _emberCtx.save();
      _emberCtx.translate(e.x, e.y);
      _emberCtx.scale(1, 1.8);
      _emberCtx.beginPath();
      _emberCtx.arc(0, 0, sz * 3, 0, Math.PI * 2);
      _emberCtx.fill();
      _emberCtx.restore();
    }
    _emberCtx.globalAlpha = 1;
    _emberRAF = requestAnimationFrame(draw);
  }
  draw();

  canvas._resizeHandler = resize;
  window.addEventListener('resize', canvas._resizeHandler);
}

function _stopEmbers() {
  if (_emberRAF) { cancelAnimationFrame(_emberRAF); _emberRAF = null; }
  const c = document.getElementById('fx-ds-embers');
  if (c) {
    if (c._resizeHandler) window.removeEventListener('resize', c._resizeHandler);
    c.remove();
  }
  _emberCtx = null;
  _embers = [];
}

// ── Effect mode helpers ─────────────────────────────────
function _getStoredEffectMode() {
  const stored = localStorage.getItem('haven_effects') || 'auto';
  if (stored === 'auto' || stored === 'none') return stored;
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) return parsed;
  } catch(e) {}
  // Legacy: single effect string from old system → convert to array
  if (typeof stored === 'string' && stored.length > 0 && stored !== 'auto' && stored !== 'none') {
    const arr = [stored];
    localStorage.setItem('haven_effects', JSON.stringify(arr));
    return arr;
  }
  return 'auto';
}

function _getCurrentCustomList() {
  const mode = _getStoredEffectMode();
  if (Array.isArray(mode)) return [...mode];
  if (mode === 'auto') {
    const theme = localStorage.getItem('haven_theme') || 'haven';
    return [...(THEME_DEFAULT_FX[theme] || [])];
  }
  return [];
}

function _updateEffectButtons(container, mode) {
  container.querySelectorAll('.effect-btn').forEach(btn => {
    const fx = btn.dataset.effect;
    if (mode === 'auto') {
      btn.classList.toggle('active', fx === 'auto');
    } else if (mode === 'none') {
      btn.classList.toggle('active', fx === 'none');
    } else if (Array.isArray(mode)) {
      if (fx === 'auto' || fx === 'none') {
        btn.classList.remove('active');
      } else {
        btn.classList.toggle('active', mode.includes(fx));
      }
    }
  });
}

function initEffectSelector() {
  const container = document.getElementById('effect-selector');
  if (!container) return;

  const mode = _getStoredEffectMode();
  applyEffects(mode);
  _updateEffectButtons(container, mode);

  container.querySelectorAll('.effect-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const fx = btn.dataset.effect;

      if (fx === 'auto') {
        localStorage.setItem('haven_effects', 'auto');
        applyEffects('auto');
        _updateEffectButtons(container, 'auto');
      } else if (fx === 'none') {
        localStorage.setItem('haven_effects', 'none');
        applyEffects('none');
        _updateEffectButtons(container, 'none');
      } else {
        // Toggle this effect
        const current = _getCurrentCustomList();
        const idx = current.indexOf(fx);
        if (idx >= 0) {
          current.splice(idx, 1);
        } else {
          current.push(fx);
        }

        if (current.length === 0) {
          localStorage.setItem('haven_effects', 'none');
          applyEffects('none');
          _updateEffectButtons(container, 'none');
        } else {
          localStorage.setItem('haven_effects', JSON.stringify(current));
          applyEffects(current);
          _updateEffectButtons(container, current);
        }
      }

      const theme = localStorage.getItem('haven_theme') || 'haven';
      showEffectEditorIfDynamic(theme);
    });
  });
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
      // Re-apply effects (AUTO mode picks up new theme's defaults)
      const fxMode = _getStoredEffectMode();
      applyEffects(fxMode);
      showEffectEditorIfDynamic(theme);
    });
  });

  // Initialise editors
  initCustomThemeEditor();
  initRgbEditor();
  initEffectSpeedEditor();
  initSacredIntensityEditor();
  initEffectSelector();

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
  // Re-apply effects for new theme
  const fxMode = _getStoredEffectMode();
  applyEffects(fxMode);
  showEffectEditorIfDynamic(theme);
}
