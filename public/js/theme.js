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
// Sets each CSS custom property directly on :root's inline style.
// Multiple setProperty calls in one script execution are batched by
// Chromium into a single style-invalidation pass — no intermediate
// recalculations.  This avoids the CSSOM node creation/destruction
// that happens when writing a <style> element's textContent 20×/s,
// which was causing progressive Blink Oilpan GC pressure.
let _themeStyleEl = null;   // kept for clearCustomVars cleanup safety
function applyCustomVars(palette) {
  // Direct inline-style setProperty on :root.  All 23 vars are set in
  // one synchronous loop; Chromium defers the style recalculation to
  // the next frame, treating them as a single batched invalidation.
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(palette)) root.setProperty(k, v);
}
function clearCustomVars() {
  if (_themeStyleEl) { _themeStyleEl.textContent = ''; }
  // Also remove any leftover inline custom properties (legacy path)
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
let _rgbRAF = null;
let _rgbHue = 0;
let _rgbLastTick = 0;
let _rgbLastHueInt = -1;
let _rgbPaletteLut = null;
let _rgbPaletteLutVibrancy = -1;

function _rebuildRgbPaletteLut(vibrancy) {
  const vib = Math.max(10, Math.min(100, Math.round(vibrancy)));
  _rgbPaletteLut = new Array(360);
  for (let h = 0; h < 360; h += 1) {
    _rgbPaletteLut[h] = generateCustomPalette(h, 0.75, 0.95, vib / 100);
  }
  _rgbPaletteLutVibrancy = vib;
}

function _getRgbPalette(hue, vibrancy) {
  const h = Math.round(((hue % 360) + 360) % 360);
  const vib = Math.max(10, Math.min(100, Math.round(vibrancy)));
  if (!_rgbPaletteLut || _rgbPaletteLutVibrancy !== vib) {
    _rebuildRgbPaletteLut(vib);
  }
  return { h, palette: _rgbPaletteLut[h] };
}

function startRgbCycle() {
  stopRgbCycle();
  const saved = JSON.parse(localStorage.getItem('haven_rgb_settings') || 'null');
  let speed    = saved ? saved.speed    : 30;   // 1-100
  let vibrancy = saved ? saved.vibrancy : 75;   // 10-100

  // Full-UI RGB remains intact, but updates are quantized and adaptive.
  // Under frame pressure we increase update spacing to prevent renderer
  // starvation, then ramp back up when the frame budget recovers.
  const BASE_TICK_MS = 80;
  const MIN_TICK_MS = 70;
  const MAX_TICK_MS = 220;
  let adaptiveTickMs = BASE_TICK_MS;
  let lastFrameTs = 0;
  function getStep() { return 0.8 + (speed / 100) * 3.2; }

  // Use rAF instead of setInterval to sync with the browser paint cycle
  // and automatically pause when the tab/window is hidden.
  const initial = _getRgbPalette(_rgbHue, vibrancy);
  _rgbLastHueInt = initial.h;
  applyCustomVars(initial.palette);

  function tick(now) {
    _rgbRAF = requestAnimationFrame(tick);
    if (document.hidden) {
      _rgbLastTick = now;
      lastFrameTs = now;
      return;
    }

    if (lastFrameTs > 0) {
      const frameDt = now - lastFrameTs;
      if (frameDt > 34) adaptiveTickMs = Math.min(MAX_TICK_MS, adaptiveTickMs + 10);
      else if (frameDt < 20) adaptiveTickMs = Math.max(MIN_TICK_MS, adaptiveTickMs - 2);
    }
    lastFrameTs = now;

    const elapsed = now - _rgbLastTick;
    if (elapsed < adaptiveTickMs) return;
    _rgbLastTick = now;

    // Keep user-selected speed visually consistent even when throttled.
    const speedScale = Math.min(3, elapsed / BASE_TICK_MS);
    _rgbHue = (_rgbHue + getStep() * speedScale) % 360;
    const next = _getRgbPalette(_rgbHue, vibrancy);
    if (next.h === _rgbLastHueInt) return;
    _rgbLastHueInt = next.h;
    applyCustomVars(next.palette);
  }
  _rgbRAF = requestAnimationFrame(tick);

  // Mark the document so CSS can suppress transitions during RGB cycling.
  // Without this, every CSS-variable change starts/interrupts background
  // transitions on hundreds of elements, creating a compounding compositor
  // workload that freezes the renderer within minutes.
  document.documentElement.classList.add('rgb-cycling');

  // Expose updaters so sliders can adjust live (no restart needed — step recalcs each tick)
  startRgbCycle._setSpeed = (v) => {
    speed = v;
    localStorage.setItem('haven_rgb_settings', JSON.stringify({ speed, vibrancy }));
  };
  startRgbCycle._setVibrancy = (v) => {
    vibrancy = v;
    const next = _getRgbPalette(_rgbHue, vibrancy);
    _rgbLastHueInt = next.h;
    applyCustomVars(next.palette);
    localStorage.setItem('haven_rgb_settings', JSON.stringify({ speed, vibrancy }));
  };
}

function stopRgbCycle() {
  if (_rgbRAF) { cancelAnimationFrame(_rgbRAF); _rgbRAF = null; }
  _rgbLastTick = 0;
  _rgbLastHueInt = -1;
  _rgbPaletteLut = null;
  _rgbPaletteLutVibrancy = -1;
  document.documentElement.classList.remove('rgb-cycling');
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
// EFFECT SPEED SLIDERS (per-effect independent speed control)
// ════════════════════════════════════════════════════════════
const DYNAMIC_THEMES = ['crt','ffx','ice','nord','darksouls','bloodborne','matrix','cyberpunk','lotr','eldenring'];
// Per-effect speed map: effectName → multiplier (1 = normal, >1 = faster)
const _fxSpeedMap = {};
// Global fallback (used when per-effect value not set)
let _fxSpeedMult = 1.0;

// Human-readable labels for effect speed sliders
const _FX_LABELS = {
  crt: '📺 CRT', ffx: '⚔️ Water', ice: '🧊 Frost', nord: '❄ Snow',
  darksouls: '🔥 Embers', bloodborne: '🩸 Blood', matrix: 'Ⅿ Matrix',
  cyberpunk: '⚡ Glitch', lotr: '⚜ Candle', eldenring: '✨ Golden Grace'
};

// Get speed for a specific effect (per-effect → global fallback → 1.0)
function _getFxSpeed(effectName) {
  if (_fxSpeedMap[effectName] !== undefined) return _fxSpeedMap[effectName];
  return _fxSpeedMult;
}

function initEffectSpeedEditor() {
  const editor = document.getElementById('effect-speed-editor');
  if (!editor) return;

  // Restore saved global multiplier (legacy — used as fallback)
  const saved = parseFloat(localStorage.getItem('haven_fx_mult'));
  if (!isNaN(saved)) {
    document.documentElement.style.setProperty('--fx-mult', saved);
    _fxSpeedMult = 2.15 - saved;
  }

  // Restore per-effect speeds
  try {
    const perEffect = JSON.parse(localStorage.getItem('haven_fx_speeds') || '{}');
    Object.assign(_fxSpeedMap, perEffect);
  } catch {}

  editor._show = () => { editor.style.display = 'block'; };
  editor._hide = () => { editor.style.display = 'none'; };
}

// Rebuild per-effect speed sliders based on currently active effects
function _rebuildEffectSpeedSliders() {
  const editor = document.getElementById('effect-speed-editor');
  if (!editor) return;

  // Clear existing sliders
  editor.innerHTML = '';

  // Get active dynamic effects — exclude CRT and Cyberpunk which have dedicated editors
  const DEDICATED_EDITORS = ['crt', 'cyberpunk'];
  const active = [..._activeFx].filter(fx => DYNAMIC_THEMES.includes(fx) && !DEDICATED_EDITORS.includes(fx));
  if (active.length === 0) return;

  active.forEach(fx => {
    const label = _FX_LABELS[fx] || fx;
    const currentSpeed = _fxSpeedMap[fx] !== undefined ? _fxSpeedMap[fx] : 1.0;
    const sliderVal = Math.round(currentSpeed * 100);

    const row = document.createElement('label');
    row.className = 'rgb-slider-row';
    row.innerHTML = `
      <span class="rgb-slider-label">${label}</span>
      <input type="range" class="slider-sm rgb-slider fx-per-effect-slider" min="15" max="200" value="${sliderVal}" data-effect="${fx}">
    `;
    editor.appendChild(row);

    const slider = row.querySelector('input');
    slider.addEventListener('input', () => {
      const raw = parseInt(slider.value, 10) / 100; // 0.15–2.0 (canvas: higher = faster)
      _fxSpeedMap[fx] = raw;

      // For CSS-based effects: set --fx-mult on overlay layer elements
      const cssMult = 2.15 - raw; // invert for CSS (lower = faster)
      _applyFxSpeedToLayers(fx, cssMult);

      // Save per-effect speeds
      localStorage.setItem('haven_fx_speeds', JSON.stringify(_fxSpeedMap));
    });

    // Apply initial speed to CSS layers
    if (_fxSpeedMap[fx] !== undefined) {
      _applyFxSpeedToLayers(fx, 2.15 - _fxSpeedMap[fx]);
    }
  });
}

// Set --fx-mult on the DOM overlay layers for a specific effect
function _applyFxSpeedToLayers(effectName, cssMult) {
  const layers = FX_LAYERS[effectName];
  if (layers) {
    layers.forEach(layer => {
      const el = document.getElementById(layer.id);
      if (!el) return;
      // CRT: widen flicker range — half the slowest speed, double the fastest.
      // Original --fx-mult ranged 0.15–2.0; new CRT range: 0.075–4.0
      if (effectName === 'crt') {
        const raw = 2.15 - cssMult;                     // 0.15–2.0
        const t = (raw - 0.15) / (2.0 - 0.15);         // 0→1 (left→right)
        const crtMult = 4.0 - t * (4.0 - 0.075);       // slow 4.0 → fast 0.075
        el.style.setProperty('--fx-mult', crtMult);
        el.style.removeProperty('animation-duration');   // clean up any prior inline override
      } else {
        el.style.setProperty('--fx-mult', cssMult);
      }
    });
  }
  // Matrix canvas + matrixbars CSS are paired — speed changes apply to both
  if (effectName === 'matrix') {
    const barLayers = FX_LAYERS['matrixbars'];
    if (barLayers) barLayers.forEach(layer => {
      const el = document.getElementById(layer.id);
      if (el) el.style.setProperty('--fx-mult', cssMult);
    });
  }
}

function showEffectEditorIfDynamic(theme) {
  const editor = document.getElementById('effect-speed-editor');
  if (!editor) return;
  const DEDICATED_EDITOR_FX = ['crt', 'cyberpunk'];
  const hasDynamic = [..._activeFx].some(fx => DYNAMIC_THEMES.includes(fx) && !DEDICATED_EDITOR_FX.includes(fx));
  if (hasDynamic) {
    _rebuildEffectSpeedSliders();
    if (editor._show) editor._show();
  } else {
    if (editor._hide) editor._hide();
  }
  // Show sacred intensity slider if religious effects are active
  const sacredEditor = document.getElementById('sacred-intensity-editor');
  const SACRED = ['scripture', 'chapel', 'gospel'];
  const hasSacred = [..._activeFx].some(fx => SACRED.includes(fx));
  if (sacredEditor) {
    if (hasSacred) {
      if (sacredEditor._show) sacredEditor._show();
    } else {
      if (sacredEditor._hide) sacredEditor._hide();
    }
  }
  // Show glitch frequency slider when cyberpunk is active
  const glitchEditor = document.getElementById('glitch-freq-editor');
  if (glitchEditor) {
    if (_activeFx.has('cyberpunk')) {
      if (glitchEditor._show) glitchEditor._show();
    } else {
      if (glitchEditor._hide) glitchEditor._hide();
    }
  }
  // Show CRT vignette/scanline sliders when CRT effect is active
  const crtEditor = document.getElementById('crt-editor');
  if (crtEditor) {
    if (_activeFx.has('crt')) {
      // Apply saved slider values to freshly-created CRT overlay elements
      const savedVig = parseInt(localStorage.getItem('haven_crt_vignette'));
      _applyCrtVignette(!isNaN(savedVig) ? savedVig : 50);
      const savedScan = parseInt(localStorage.getItem('haven_crt_scanline'));
      _applyCrtScanline(!isNaN(savedScan) ? savedScan : 45);
      if (crtEditor._show) crtEditor._show();
    } else {
      if (crtEditor._hide) crtEditor._hide();
    }
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
  matrix: ['matrix','matrixbars'], fallout: ['fallout'], ffx: ['ffx'],
  ice: ['ice'], nord: ['nord'], darksouls: ['darksouls'], eldenring: ['eldenring'],
  bloodborne: ['bloodborne'], cyberpunk: ['cyberpunk'], lotr: ['lotr'], abyss: ['abyss'],
  scripture: ['scripture'], chapel: ['chapel'], gospel: ['gospel']
};

let _activeFx = new Set();
let _matrixCtx = null, _matrixRAF = null, _matrixDrops = [];
let _emberCtx = null, _emberRAF = null, _embers = [];
let _graceCtx = null, _graceRAF = null, _graceEmbers = [];
let _snowCtx = null, _snowRAF = null, _snowflakes = [];
let _scrambleTimer = null, _scrambleOriginal = 'HAVEN';
let _scrambleFreq = 50;  // 5-100 slider value; lower = less frequent, higher = more
let _scrambleTargets = [];  // tracked { el, original } for multi-element scramble

// Layer definitions: each effect -> array of { id, parent, cls }
const FX_LAYERS = {
  crt:        [{ id: 'fx-crt-vignette', parent: '#fx-layers', cls: 'fx-crt-vignette' },
               { id: 'fx-crt-scanlines', parent: '#fx-layers', cls: 'fx-crt-scanlines' }],
  matrix:     [],  // digital rain handled entirely by JS canvas
  matrixbars: [{ id: 'fx-matrix-bars', parent: '.sidebar', cls: 'fx-matrix-bars' }],
  fallout:    [{ id: 'fx-fallout-vignette', parent: '#fx-layers', cls: 'fx-fallout-vignette' }],
  ffx:        [{ id: 'fx-ffx-water', parent: '.sidebar', cls: 'fx-ffx-water' },
               { id: 'fx-ffx-wave', parent: '#fx-layers', cls: 'fx-ffx-wave' }],
  ice:        [{ id: 'fx-ice-shimmer', parent: '#fx-layers', cls: 'fx-ice-shimmer' },
               { id: 'fx-ice-icicle-ch', parent: '.channel-header', cls: 'fx-ice-icicle' },
               { id: 'fx-ice-icicle-sb', parent: '.sidebar-header', cls: 'fx-ice-icicle-sb' }],
  nord:       [],  // snowfall handled entirely by JS canvas
  darksouls:  [{ id: 'fx-ds-fireline', parent: '#fx-layers', cls: 'fx-ds-fireline' },
               { id: 'fx-ds-ambient', parent: '#fx-layers', cls: 'fx-ds-ambient' }],
  eldenring:  [],  // golden grace handled by JS canvas
  bloodborne: [{ id: 'fx-bb-vignette', parent: '#fx-layers', cls: 'fx-bb-vignette' }],
  cyberpunk:  [],  // text-scramble handled entirely by JS
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
  darksouls: { start: _startEmbers, stop: _stopEmbers },
  eldenring: { start: _startGraceEmbers, stop: _stopGraceEmbers },
  nord: { start: _startNordSnow, stop: _stopNordSnow },
  cyberpunk: { start: _startTextScramble, stop: _stopTextScramble }
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

// ── Cyberpunk Text Scramble — decodes text with random chars ─
const _SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*!?<>{}[]=/\\|~^';

function _scrambleElement(el, original) {
  if (!el || el._scrambling) return;
  el._scrambling = true;

  // Store the true original in a data attribute so it survives corruption
  if (!el.dataset.originalText) el.dataset.originalText = original;
  const trueOriginal = el.dataset.originalText;

  const len = trueOriginal.length;
  const totalFrames = Math.min(30, 10 + len * 2);  // scale frames to text length
  const resolveStart = Math.floor(totalFrames * 0.25);
  let frame = 0;

  el.classList.add('scrambling');

  const interval = setInterval(() => {
    let display = '';
    for (let i = 0; i < len; i++) {
      if (trueOriginal[i] === ' ') { display += ' '; continue; }
      const charResolveFrame = resolveStart + (i * ((totalFrames - resolveStart) / len));
      if (frame >= charResolveFrame) {
        display += trueOriginal[i];
      } else {
        display += _SCRAMBLE_CHARS[Math.floor(Math.random() * _SCRAMBLE_CHARS.length)];
      }
    }
    el.textContent = display;
    frame++;

    if (frame > totalFrames) {
      clearInterval(interval);
      el.textContent = trueOriginal;
      el.classList.remove('scrambling');
      el._scrambling = false;
    }
  }, 50);

  // Track the interval so we can force-stop it
  el._scrambleInterval = interval;
}

// Collect all scramble-able text elements currently on screen
function _collectScrambleTargets() {
  const targets = [];

  function addTarget(el) {
    if (!el) return;
    // Use stored original if available, otherwise snapshot current text
    const original = el.dataset.originalText || el.textContent.trim();
    if (!original) return;
    // Always persist the true original so it can never be lost
    if (!el.dataset.originalText) el.dataset.originalText = original;
    targets.push({ el, original });
  }

  // 1. Brand text (HAVEN logo) — always included
  addTarget(document.querySelector('.brand-text'));

  // 2. Current username
  addTarget(document.getElementById('current-user'));

  // 3. Channel names in sidebar
  document.querySelectorAll('.channel-name').forEach(addTarget);

  // 4. Section labels — target the text span inside toggle headers to avoid
  //    destroying child elements (buttons, badges) via textContent assignment.
  //    For section labels that contain a .section-label-text span, scramble that;
  //    otherwise fall back to the label itself (safe for simple labels).
  document.querySelectorAll('.section-label').forEach(el => {
    const textSpan = el.querySelector('.section-label-text');
    addTarget(textSpan || el);
  });

  // 5. Channel header name
  addTarget(document.getElementById('channel-header-name'));

  // 6. User names in member list
  document.querySelectorAll('.user-item-name').forEach(addTarget);

  return targets;
}

// Get the scramble interval based on the frequency slider (5-100)
// Slider 5 → ~12s base interval (rare), 100 → ~1.5s (constant chaos)
function _getScrambleInterval() {
  const freq = _scrambleFreq;
  const base = 12000 - (freq * 105);  // 12000ms at 5 → ~1500ms at 100
  return Math.max(800, base + Math.random() * base * 0.5);
}

function _scrambleTick() {
  const targets = _collectScrambleTargets();
  if (!targets.length) return;

  // Pick 1-3 random targets depending on frequency
  const pickCount = _scrambleFreq > 70 ? 3 : _scrambleFreq > 35 ? 2 : 1;
  const shuffled = targets.sort(() => Math.random() - 0.5);

  for (let i = 0; i < Math.min(pickCount, shuffled.length); i++) {
    const t = shuffled[i];
    _scrambleElement(t.el, t.original);
  }

  // Schedule next tick with jittered interval
  _scrambleTimer = setTimeout(_scrambleTick, _getScrambleInterval());
}

function _startTextScramble() {
  _stopTextScramble();

  // Restore saved frequency
  const saved = parseInt(localStorage.getItem('haven_glitch_freq'));
  if (!isNaN(saved)) _scrambleFreq = saved;

  // Start the tick loop
  _scrambleTick();
}

function _stopTextScramble() {
  if (_scrambleTimer) {
    clearTimeout(_scrambleTimer);
    _scrambleTimer = null;
  }
  // Force-stop any in-progress scrambles and restore original text
  document.querySelectorAll('.scrambling').forEach(el => {
    if (el._scrambleInterval) { clearInterval(el._scrambleInterval); el._scrambleInterval = null; }
    if (el.dataset.originalText) el.textContent = el.dataset.originalText;
    el.classList.remove('scrambling');
    el._scrambling = false;
  });
  // Also restore any element that was previously scrambled (has stored original)
  document.querySelectorAll('[data-original-text]').forEach(el => {
    if (el._scrambleInterval) { clearInterval(el._scrambleInterval); el._scrambleInterval = null; }
    el.textContent = el.dataset.originalText;
    el.classList.remove('scrambling');
    el._scrambling = false;
  });
}

function initGlitchFreqEditor() {
  const editor = document.getElementById('glitch-freq-editor');
  const slider = document.getElementById('glitch-freq-slider');
  if (!editor || !slider) return;

  // Restore saved frequency
  const saved = parseInt(localStorage.getItem('haven_glitch_freq'));
  if (!isNaN(saved)) {
    slider.value = saved;
    _scrambleFreq = saved;
  }

  slider.addEventListener('input', () => {
    const val = parseInt(slider.value, 10);
    _scrambleFreq = val;
    localStorage.setItem('haven_glitch_freq', val);
  });

  editor._show = () => { editor.style.display = 'block'; };
  editor._hide = () => { editor.style.display = 'none'; };
}

// ── CRT vignette & scanline sliders ─────────────────────────
function initCrtEditor() {
  const editor = document.getElementById('crt-editor');
  const vigSlider = document.getElementById('crt-vignette-slider');
  const scanSlider = document.getElementById('crt-scanline-slider');
  if (!editor || !vigSlider || !scanSlider) return;

  // Restore saved values
  const savedVig = parseInt(localStorage.getItem('haven_crt_vignette'));
  if (!isNaN(savedVig)) {
    vigSlider.value = savedVig;
  }
  const savedScan = parseInt(localStorage.getItem('haven_crt_scanline'));
  if (!isNaN(savedScan)) {
    scanSlider.value = savedScan;
  }

  vigSlider.addEventListener('input', () => {
    const val = parseInt(vigSlider.value, 10);
    _applyCrtVignette(val);
    localStorage.setItem('haven_crt_vignette', val);
  });

  scanSlider.addEventListener('input', () => {
    const val = parseInt(scanSlider.value, 10);
    _applyCrtScanline(val);
    localStorage.setItem('haven_crt_scanline', val);
  });

  editor._show = () => { editor.style.display = 'block'; };
  editor._hide = () => { editor.style.display = 'none'; };
}

function _applyCrtVignette(sliderVal) {
  const el = document.getElementById('fx-crt-vignette');
  if (!el) return;
  // Map slider 0-100 to vignette intensity:
  //   min (0):  ~0% dark at center, ~10% dark at far edges
  //   max (100): ~15% dark at center, ~90% dark at far edges
  const t = sliderVal / 100;
  const cen  = (t * 0.15).toFixed(3);            // 0.000 → 0.150
  const mid1 = (0.02  + t * 0.28).toFixed(3);    // 0.020 → 0.300
  const mid2 = (0.05  + t * 0.50).toFixed(3);    // 0.050 → 0.550
  const mid3 = (0.08  + t * 0.67).toFixed(3);    // 0.080 → 0.750
  const edge = (0.10  + t * 0.80).toFixed(3);    // 0.100 → 0.900
  el.style.background = `radial-gradient(ellipse 68% 64% at 50% 50%,
    rgba(0,0,0,${cen}) 0%,
    rgba(0,0,0,${cen}) 20%,
    rgba(0,0,0,${mid1}) 45%,
    rgba(0,0,0,${mid2}) 65%,
    rgba(0,0,0,${mid3}) 82%,
    rgba(0,0,0,${edge}) 100%)`;
}

function _applyCrtScanline(sliderVal) {
  const el = document.getElementById('fx-crt-scanlines');
  if (el) el.style.opacity = sliderVal / 100;
}

// Inject vignette + scanline slider rows into the speed editor block
function _injectCrtSliders(parentEditor) {
  const savedVig = parseInt(localStorage.getItem('haven_crt_vignette'));
  const vigVal = !isNaN(savedVig) ? savedVig : 50;
  const savedScan = parseInt(localStorage.getItem('haven_crt_scanline'));
  const scanVal = !isNaN(savedScan) ? savedScan : 45;

  // Vignette row
  const vigRow = document.createElement('label');
  vigRow.className = 'rgb-slider-row';
  vigRow.innerHTML = `
    <span class="rgb-slider-label">📺 Vignette</span>
    <input type="range" class="slider-sm rgb-slider" id="crt-vig-inline" min="0" max="100" value="${vigVal}">
  `;
  parentEditor.appendChild(vigRow);
  const vigSlider = vigRow.querySelector('input');
  vigSlider.addEventListener('input', () => {
    const v = parseInt(vigSlider.value, 10);
    _applyCrtVignette(v);
    localStorage.setItem('haven_crt_vignette', v);
  });

  // Scanline row
  const scanRow = document.createElement('label');
  scanRow.className = 'rgb-slider-row';
  scanRow.innerHTML = `
    <span class="rgb-slider-label">📺 Scanlines</span>
    <input type="range" class="slider-sm rgb-slider" id="crt-scan-inline" min="0" max="80" value="${scanVal}">
  `;
  parentEditor.appendChild(scanRow);
  const scanSlider = scanRow.querySelector('input');
  scanSlider.addEventListener('input', () => {
    const v = parseInt(scanSlider.value, 10);
    _applyCrtScanline(v);
    localStorage.setItem('haven_crt_scanline', v);
  });

  // Apply initial values to the overlay elements
  _applyCrtVignette(vigVal);
  _applyCrtScanline(scanVal);
}

// ── Matrix Digital Rain (canvas) — scoped to .main area ─
function _startMatrixRain() {
  _stopMatrixRain();
  const mainEl = document.querySelector('.main');
  if (!mainEl) return;
  // Ensure .main is a positioning parent for the canvas
  if (getComputedStyle(mainEl).position === 'static') {
    mainEl.style.position = 'relative';
  }

  const canvas = document.createElement('canvas');
  canvas.id = 'fx-matrix-rain';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '0';
  canvas.style.opacity = '0.18';
  mainEl.insertBefore(canvas, mainEl.firstChild);

  function resize() {
    canvas.width = mainEl.clientWidth;
    canvas.height = mainEl.clientHeight;
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

  let _matrixLastFrame = 0;
  function draw(now) {
    _matrixRAF = requestAnimationFrame(draw);
    if (now - _matrixLastFrame < 33 || document.hidden) return;
    _matrixLastFrame = now;
    _matrixCtx.fillStyle = 'rgba(0, 0, 0, 0.03)';
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
      const speedM = _getFxSpeed('matrix');
      _matrixDrops[i] += (0.4 + Math.random() * 0.6) * speedM;
    }
  }
  _matrixRAF = requestAnimationFrame(draw);

  canvas._resizeHandler = () => { resize(); initDrops(); };
  window.addEventListener('resize', canvas._resizeHandler);
  // Also observe .main resizing (e.g. sidebar toggle)
  canvas._resizeObs = new ResizeObserver(() => { resize(); initDrops(); });
  canvas._resizeObs.observe(mainEl);
}

function _stopMatrixRain() {
  if (_matrixRAF) { cancelAnimationFrame(_matrixRAF); _matrixRAF = null; }
  const c = document.getElementById('fx-matrix-rain');
  if (c) {
    if (c._resizeHandler) window.removeEventListener('resize', c._resizeHandler);
    if (c._resizeObs) c._resizeObs.disconnect();
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

  let _emberLastFrame = 0;
  function draw(now) {
    _emberRAF = requestAnimationFrame(draw);
    if (now - _emberLastFrame < 33 || document.hidden) return;
    _emberLastFrame = now;
    _emberCtx.clearRect(0, 0, canvas.width, canvas.height);

    // Spawn fewer embers, concentrated in center
    const speedM = _getFxSpeed('darksouls');
    const spawnRate = Math.max(1, Math.floor(canvas.width / 200 * Math.max(0.5, speedM)));
    for (let s = 0; s < spawnRate; s++) {
      if (_embers.length < 35 && Math.random() > 0.7) spawnEmber();
    }

    for (let i = _embers.length - 1; i >= 0; i--) {
      const e = _embers[i];
      e.flicker += 0.12 * speedM;
      e.x += (e.vx + Math.sin(e.flicker) * e.driftAmp) * speedM;
      // Center embers rise higher, edge embers die sooner
      const centerDist = Math.abs(e.x - canvas.width / 2) / (canvas.width / 2);
      const heightMult = 1 - centerDist * 0.4;
      e.y += e.vy * heightMult * speedM;
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
  }
  _emberRAF = requestAnimationFrame(draw);

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

// ── Elden Ring Grace Embers (canvas — golden, angular, stable glow) ──
function _startGraceEmbers() {
  _stopGraceEmbers();
  const container = _ensureFxLayers();
  const canvas = document.createElement('canvas');
  canvas.id = 'fx-er-grace';
  canvas.className = 'fx-canvas';
  canvas.style.zIndex = '1';
  container.appendChild(canvas);

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();

  _graceCtx = canvas.getContext('2d');
  _graceEmbers = [];

  function spawnGrace() {
    // Spawn across the full width, biased toward lower-center
    const cx = canvas.width / 2;
    const spread = canvas.width * 0.4;
    const x = cx + (Math.random() - 0.5) * spread * 2;
    _graceEmbers.push({
      x: x,
      y: canvas.height + 4 + Math.random() * 8,
      vx: (Math.random() - 0.5) * 0.15,          // very little horizontal drift
      vy: -(0.6 + Math.random() * 1.4),           // slow, graceful rise
      size: 0.5 + Math.random() * 1.2,
      life: 1,
      decay: 0.002 + Math.random() * 0.005,       // longer life than DS embers
      hue: 42 + Math.random() * 16,               // golden-yellow (42–58)
      phase: Math.random() * Math.PI * 2,
      driftAmp: 0.05 + Math.random() * 0.12,      // very subtle sway
      angle: Math.random() * Math.PI * 2           // rotation for diamond shape
    });
  }

  // Draw a diamond (rhombus) at (x, y) with given half-size
  function drawDiamond(ctx, x, y, sz, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -sz * 1.6);   // top (taller than wide for "grace" look)
    ctx.lineTo(sz, 0);          // right
    ctx.moveTo(0, -sz * 1.6);
    ctx.lineTo(-sz, 0);         // left
    ctx.lineTo(0, sz * 1.2);    // bottom
    ctx.lineTo(sz, 0);          // back to right
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  let _graceLastFrame = 0;
  function draw(now) {
    _graceRAF = requestAnimationFrame(draw);
    if (now - _graceLastFrame < 33 || document.hidden) return;
    _graceLastFrame = now;
    _graceCtx.clearRect(0, 0, canvas.width, canvas.height);

    const speedM = _getFxSpeed('eldenring');
    const spawnRate = Math.max(1, Math.floor(canvas.width / 220 * Math.max(0.5, speedM)));
    for (let s = 0; s < spawnRate; s++) {
      if (_graceEmbers.length < 40 && Math.random() > 0.65) spawnGrace();
    }

    for (let i = _graceEmbers.length - 1; i >= 0; i--) {
      const e = _graceEmbers[i];
      e.phase += 0.03 * speedM;                    // slow shimmer, not frantic flicker
      e.angle += 0.004 * speedM;                    // very slow rotation
      e.x += (e.vx + Math.sin(e.phase) * e.driftAmp) * speedM;
      e.y += e.vy * speedM;
      e.life -= e.decay;

      if (e.life <= 0 || e.y < -10) { _graceEmbers.splice(i, 1); continue; }

      const alpha = e.life * 0.85;
      const sz = e.size * (0.4 + e.life * 0.6);
      const lightness = 55 + e.life * 25;          // bright gold

      // Core diamond
      _graceCtx.globalAlpha = alpha;
      _graceCtx.fillStyle = 'hsl(' + e.hue + ',85%,' + Math.floor(lightness) + '%)';
      drawDiamond(_graceCtx, e.x, e.y, sz, e.angle);

      // Soft golden glow (tall, stable — no wild flickering)
      _graceCtx.globalAlpha = alpha * 0.25;
      _graceCtx.save();
      _graceCtx.translate(e.x, e.y);
      _graceCtx.scale(1, 2.2);                     // tall vertical glow
      _graceCtx.beginPath();
      _graceCtx.arc(0, 0, sz * 3.5, 0, Math.PI * 2);
      _graceCtx.fill();
      _graceCtx.restore();
    }
    _graceCtx.globalAlpha = 1;
  }
  _graceRAF = requestAnimationFrame(draw);

  canvas._resizeHandler = resize;
  window.addEventListener('resize', canvas._resizeHandler);
}

function _stopGraceEmbers() {
  if (_graceRAF) { cancelAnimationFrame(_graceRAF); _graceRAF = null; }
  const c = document.getElementById('fx-er-grace');
  if (c) {
    if (c._resizeHandler) window.removeEventListener('resize', c._resizeHandler);
    c.remove();
  }
  _graceCtx = null;
  _graceEmbers = [];
}

// ── Nord Snowfall (canvas — randomised, fleeting) ───────
function _startNordSnow() {
  _stopNordSnow();
  const container = _ensureFxLayers();
  const canvas = document.createElement('canvas');
  canvas.id = 'fx-nord-snow-canvas';
  canvas.className = 'fx-canvas';
  canvas.style.zIndex = '1';
  container.appendChild(canvas);

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();

  _snowCtx = canvas.getContext('2d');
  _snowflakes = [];

  function spawnFlake() {
    _snowflakes.push({
      x: Math.random() * canvas.width,
      y: -4 - Math.random() * 40,
      vx: (Math.random() - 0.5) * 0.6,
      vy: 0.6 + Math.random() * 1.8,
      size: 1 + Math.random() * 2.5,
      opacity: 0.3 + Math.random() * 0.5,
      drift: Math.random() * Math.PI * 2,
      driftSpeed: 0.008 + Math.random() * 0.02,
      driftAmp: 0.15 + Math.random() * 0.45,
      fadeStart: 0.80 + Math.random() * 0.18  // fraction of screen height where fading begins
    });
  }

  let _snowLastFrame = 0;
  function draw(now) {
    _snowRAF = requestAnimationFrame(draw);
    if (now - _snowLastFrame < 33 || document.hidden) return;
    _snowLastFrame = now;
    _snowCtx.clearRect(0, 0, canvas.width, canvas.height);

    // Spawn snowflakes at random intervals — density scales with width
    // Speed multiplier affects spawn rate and fall speed
    const speedM = _getFxSpeed('nord');
    const targetCount = Math.max(20, Math.floor(canvas.width / 18 * Math.max(0.5, speedM)));
    const spawnChance = _snowflakes.length < targetCount ? 0.35 * speedM : 0.05;
    if (Math.random() < spawnChance && _snowflakes.length < targetCount * 1.5) {
      // Spawn 1-3 flakes at once for bursts
      const burst = 1 + Math.floor(Math.random() * 3);
      for (let b = 0; b < burst; b++) spawnFlake();
    }

    for (let i = _snowflakes.length - 1; i >= 0; i--) {
      const f = _snowflakes[i];
      f.drift += f.driftSpeed * speedM;
      f.x += (f.vx + Math.sin(f.drift) * f.driftAmp) * speedM;
      f.y += f.vy * speedM;

      // Fade out near bottom to avoid sharp cut-off
      let alpha = f.opacity;
      const screenFrac = f.y / canvas.height;
      if (screenFrac > f.fadeStart) {
        alpha *= 1 - (screenFrac - f.fadeStart) / (1 - f.fadeStart);
      }

      // Remove when off-screen or fully faded
      if (f.y > canvas.height + 10 || alpha <= 0.01) {
        _snowflakes.splice(i, 1);
        continue;
      }

      // Draw snowflake — soft circle with glow
      _snowCtx.globalAlpha = alpha;
      _snowCtx.fillStyle = '#d8dee9';
      _snowCtx.beginPath();
      _snowCtx.arc(f.x, f.y, f.size, 0, Math.PI * 2);
      _snowCtx.fill();

      // Subtle glow
      _snowCtx.globalAlpha = alpha * 0.25;
      _snowCtx.beginPath();
      _snowCtx.arc(f.x, f.y, f.size * 2.5, 0, Math.PI * 2);
      _snowCtx.fill();
    }
    _snowCtx.globalAlpha = 1;
  }
  _snowRAF = requestAnimationFrame(draw);

  canvas._resizeHandler = resize;
  window.addEventListener('resize', canvas._resizeHandler);
}

function _stopNordSnow() {
  if (_snowRAF) { cancelAnimationFrame(_snowRAF); _snowRAF = null; }
  const c = document.getElementById('fx-nord-snow-canvas');
  if (c) {
    if (c._resizeHandler) window.removeEventListener('resize', c._resizeHandler);
    c.remove();
  }
  _snowCtx = null;
  _snowflakes = [];
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
  // File themes are restored by plugin-loader after it fetches theme metadata.
  // Nothing to do here for 'file:...' — it will be handled once the loader runs.

  // Set active button (file: theme buttons are injected later by plugin-loader,
  // so they will pick up the active state via injectPublishedThemeButtons)
  container.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === saved);

    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;

      // Switching to a built-in theme: remove any injected file-theme links
      if (!theme.startsWith('file:')) {
        document.querySelectorAll('link[id^="haven-theme-"]').forEach(l => l.remove());
      }

      document.documentElement.setAttribute('data-theme', theme.startsWith('file:') ? 'haven' : theme);
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
  initGlitchFreqEditor();
  initCrtEditor();
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

  // File theme — delegate to plugin-loader if available; otherwise fall back to haven
  if (theme.startsWith('file:')) {
    const file = theme.slice(5);
    if (window.HavenPluginLoader?.applyFileTheme) {
      window.HavenPluginLoader.applyFileTheme(file);
    } else {
      // Loader not ready yet — store it; loader will restore on init
      localStorage.setItem('haven_theme', theme);
    }
    return;
  }

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
