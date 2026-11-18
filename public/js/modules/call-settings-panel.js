// Call settings panel builder. The controls are described once (CONTROLS) and
// built wherever they are needed: the voice sidebar today, the fullscreen
// popup and a pre-call page later. Every copy reads from and writes to the
// call settings layer (call-settings.js), never to the voice engine or to
// localStorage, so copies stay in step through the layer's subscribe.
//
//   const panel = createCallSettingsPanel(host, { settings, devices, ... });
//   panel.destroy();   // listeners, timers and the mic meter loop all stop
//
// Element ids: the sidebar copy passes `legacyIds: true` and keeps the ids
// themes, plugins and user CSS already rely on. Every other copy passes
// nothing and is found by its `data-setting` attributes, so ids stay unique.

// ── Shared device lists ──────────────────────────────────

/**
 * One list of microphones, speakers and cameras for every panel copy.
 * refresh() asks the browser once however many copies are open. Browsers hide
 * device names until the mic has been allowed once, so it opens the mic
 * briefly to learn them, and closes it again.
 */
export function createDeviceList({ mediaDevices } = {}) {
  const media = () => mediaDevices || (typeof navigator !== 'undefined' ? navigator.mediaDevices : null);
  let current = { inputs: [], outputs: [], cameras: [] };
  let inFlight = null;
  const listeners = new Set();

  const refresh = () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const md = media();
      if (!md) return current;
      let devices = [];
      try {
        let tempStream = null;
        const first = await md.enumerateDevices();
        if (!first.some((d) => d.label)) {
          try {
            tempStream = await md.getUserMedia({ audio: true });
          } catch { /* microphone refused: devices are listed without names */ }
        }
        try {
          devices = await md.enumerateDevices();
        } finally {
          // Only opened to learn the device names; closed even if listing fails.
          if (tempStream) tempStream.getTracks().forEach((track) => track.stop());
        }
      } catch (err) {
        console.warn('[Haven] Could not enumerate audio devices:', err);
        return current;
      }
      current = {
        inputs: devices.filter((d) => d.kind === 'audioinput'),
        outputs: devices.filter((d) => d.kind === 'audiooutput'),
        cameras: devices.filter((d) => d.kind === 'videoinput'),
      };
      for (const fn of [...listeners]) {
        try { fn(current); } catch (err) { console.error('[CallSettings] device listener failed', err); }
      }
      return current;
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    get: () => current,
    refresh,
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

// ── What the panel shows ─────────────────────────────────

const SCREEN_RESOLUTION_OPTIONS = [
  { value: 'source', labelKey: 'voice_settings.resolution_source' },
  { value: '720', label: '720p' },
  { value: '1080', label: '1080p' },
  { value: '1440', label: '1440p' },
];

// Order is the order on screen. `id` is the legacy element id (sidebar only).
// An `optional` control is built only in copies that list its setting in
// `include` (the sidebar never had the voice volume; it lives in Settings).
export const CONTROLS = [
  { kind: 'section', icon: '🎧', labelKey: 'voice_settings.audio_devices' },
  { kind: 'select', setting: 'inputDevice', id: 'voice-input-device', labelKey: 'voice_settings.input',
    devices: 'inputs', defaultKey: 'voice_settings.default_mic', fallbackKey: 'voice_settings.mic_fallback' },
  { kind: 'select', setting: 'outputDevice', id: 'voice-output-device', labelKey: 'voice_settings.output',
    devices: 'outputs', defaultKey: 'voice_settings.default_speaker', fallbackKey: 'voice_settings.speaker_fallback',
    isOutput: true },
  { kind: 'range', setting: 'voiceVolume', labelKey: 'settings.sounds_section.volume', optional: true,
    className: 'ns-slider call-volume-slider', min: 0, max: 200,
    toControl: (v) => String(Math.round(v * 100)),
    fromControl: (v) => parseInt(v, 10) / 100 },
  { kind: 'select', setting: 'cameraDevice', id: 'voice-cam-device', labelKey: 'voice_settings.camera',
    devices: 'cameras', defaultKey: 'voice_settings.default_camera', fallbackKey: 'voice_settings.camera_fallback' },
  { kind: 'select', setting: 'cameraQuality', id: 'voice-cam-quality', labelKey: 'voice_settings.camera_quality',
    titleKey: 'voice_settings.camera_quality_hint',
    options: [
      { value: '480', label: '480p' },
      { value: '720', label: '720p' },
      { value: '720p60', label: '720p 60 fps' },
      { value: '1080', label: '1080p' },
      { value: '1080p60', label: '1080p 60 fps' },
    ] },
  { kind: 'divider' },
  { kind: 'select', setting: 'noiseMode', id: 'voice-noise-mode', icon: '🤫', labelKey: 'voice_settings.noise_reduction',
    titleKey: 'voice_settings.noise_mode_hint',
    options: [
      { value: 'off', labelKey: 'voice_settings.off' },
      { value: 'gate', labelKey: 'voice_settings.noise_gate' },
      { value: 'suppress', labelKey: 'voice_settings.suppression_ai' },
    ] },
  { kind: 'range', setting: 'noiseSensitivity', id: 'voice-ns-slider', rowId: 'noise-gate-row',
    labelKey: 'voice_settings.gate_sensitivity', titleKey: 'voice_settings.gate_slider_hint',
    labelStyle: 'font-size:0.72rem;opacity:0.8', className: 'ns-slider', min: 0, max: 100,
    onlyWhen: { setting: 'noiseMode', equals: 'gate' } },
  { kind: 'meter' },
  { kind: 'divider' },
  { kind: 'section', icon: '🖥️', labelKey: 'voice_settings.screen_share_quality' },
  { kind: 'select', setting: 'screenResolution', id: 'screen-res-select', labelKey: 'voice_settings.resolution',
    options: SCREEN_RESOLUTION_OPTIONS,
    toControl: (v) => (v === 0 ? 'source' : String(v)),
    fromControl: (v) => (v === 'source' ? 0 : parseInt(v, 10)) },
  { kind: 'bitrate', setting: 'screenBitrate', labelKey: 'voice_settings.bitrate' },
  { kind: 'select', setting: 'screenFrameRate', id: 'screen-fps-select', labelKey: 'voice_settings.frame_rate',
    options: [
      { value: '15', label: '15 fps' },
      { value: '30', label: '30 fps' },
      { value: '60', label: '60 fps' },
    ],
    toControl: (v) => String(v),
    fromControl: (v) => parseInt(v, 10) },
];

// ── The builder ──────────────────────────────────────────

/**
 * @param {HTMLElement} host   emptied, then filled with the controls
 * @param {object} options
 * @param {object} options.settings   the call settings layer
 * @param {object} options.devices    a createDeviceList()
 * @param {boolean} [options.legacyIds]  keep the sidebar's element ids
 * @param {string[]} [options.include]  optional controls to build, by setting
 * @param {() => number} [options.getMicLevel]  0 to 100, for the level meter
 * @param {boolean} [options.supportsOutputSelection]  default: the browser can
 * @param {(key: string, params?: object) => string} [options.t]
 * @returns {{ element: HTMLElement, destroy: () => void }}
 */
export function createCallSettingsPanel(host, options = {}) {
  const { settings, devices, legacyIds = false } = options;
  if (!host || !settings || !devices) throw new Error('createCallSettingsPanel needs a host, settings and devices');
  const doc = host.ownerDocument || document;
  const tr = options.t || ((key, params) => (typeof t === 'function' ? t(key, params) : key));
  const env = {
    IntersectionObserver: options.IntersectionObserver ?? globalThis.IntersectionObserver,
    requestAnimationFrame: options.requestAnimationFrame ?? globalThis.requestAnimationFrame?.bind(globalThis),
    cancelAnimationFrame: options.cancelAnimationFrame ?? globalThis.cancelAnimationFrame?.bind(globalThis),
  };
  const supportsOutputSelection = options.supportsOutputSelection ?? (
    typeof HTMLAudioElement !== 'undefined'
    && typeof HTMLAudioElement.prototype.setSinkId === 'function');

  const cleanups = [];          // run by destroy()
  const onDestroy = (fn) => cleanups.push(fn);
  let destroyed = false;

  const el = (tag, className, attrs = {}) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
    return node;
  };
  const withId = (node, id) => { if (legacyIds && id) node.setAttribute('id', id); };
  // Labels are not tied to their controls, so copies other than the sidebar
  // (whose markup stays as it was) name each control for screen readers.
  const nameControl = (node, key) => { if (!legacyIds && key) node.setAttribute('aria-label', tr(key)); };
  const i18nText = (node, key) => {
    node.setAttribute('data-i18n', key);
    node.textContent = tr(key);
  };
  const addLabel = (row, control) => {
    const label = el('label', 'voice-settings-label');
    if (control.labelStyle) label.setAttribute('style', control.labelStyle);
    if (control.icon) {
      label.appendChild(doc.createTextNode(`${control.icon} `));
      const span = el('span');
      i18nText(span, control.labelKey);
      label.appendChild(span);
    } else {
      i18nText(label, control.labelKey);
    }
    row.appendChild(label);
    return label;
  };
  const addTitle = (node, key) => {
    if (!key) return;
    node.setAttribute('data-i18n-title', key);
    node.setAttribute('title', tr(key));
  };
  const optionNode = (value, label, i18nKey) => {
    const opt = el('option');
    opt.setAttribute('value', value);
    if (i18nKey) opt.setAttribute('data-i18n', i18nKey);
    opt.textContent = label;
    return opt;
  };

  // Each part below registers how it follows the layer.
  const follow = (setting, fn) => {
    fn(settings.get(setting));
    const off = settings.subscribe(setting, fn);
    onDestroy(off);
  };

  host.replaceChildren();

  const buildSelect = (control) => {
    const row = el('div', 'voice-settings-row');
    addLabel(row, control);
    const select = el('select', 'voice-settings-select', { 'data-setting': control.setting });
    withId(select, control.id);
    addTitle(select, control.titleKey);
    nameControl(select, control.labelKey);
    const toControl = control.toControl || String;
    const fromControl = control.fromControl || String;
    // A saved device that is not in the list (unplugged, or the list is not
    // loaded yet) shows the default entry. Setting a value with no matching
    // option would leave the picker blank in the browser.
    const show = (value) => {
      const wanted = toControl(value);
      const options = Array.from(select.options || []);
      select.value = options.some((o) => o.value === wanted) ? wanted : (options[0]?.value ?? '');
    };

    const render = () => {
      const chosen = settings.get(control.setting);
      if (control.devices) {
        const list = devices.get()[control.devices];
        const options = [optionNode('', tr(control.defaultKey), control.defaultKey)];
        list.forEach((dev, index) => {
          options.push(optionNode(dev.deviceId, dev.label || tr(control.fallbackKey, { n: index + 1 })));
        });
        select.replaceChildren(...options);
      }
      show(chosen);
    };
    if (!control.devices) {
      select.replaceChildren(...control.options.map((o) => optionNode(o.value, o.labelKey ? tr(o.labelKey) : o.label, o.labelKey)));
    }
    render();

    const onChange = (event) => {
      settings.set(control.setting, fromControl(event.target.value));
    };
    select.addEventListener('change', onChange);
    onDestroy(() => select.removeEventListener('change', onChange));
    onDestroy(settings.subscribe(control.setting, show));
    if (control.devices) onDestroy(devices.subscribe(render));

    row.appendChild(select);
    if (control.isOutput && !supportsOutputSelection) {
      // Browsers without setSinkId (notably Firefox) cannot switch the output
      // in JS: say so instead of leaving a picker that does nothing. (#5295)
      select.disabled = true;
      select.setAttribute('title', tr('voice_settings.output_unsupported_title'));
      const hint = el('small', 'settings-hint');
      hint.setAttribute('style', 'display:block;margin-top:4px;opacity:0.85');
      hint.textContent = tr('voice_settings.output_unsupported_hint');
      withId(hint, 'voice-output-unsupported-hint');
      row.appendChild(hint);
    }
    return row;
  };

  const buildRange = (control) => {
    const row = el('div', 'voice-settings-row');
    withId(row, control.rowId);
    addLabel(row, control);
    const input = el('input', control.className, {
      type: 'range', min: control.min, max: control.max, 'data-setting': control.setting,
    });
    withId(input, control.id);
    addTitle(input, control.titleKey);
    nameControl(input, control.labelKey);
    const toControl = control.toControl || String;
    const fromControl = control.fromControl || ((v) => parseInt(v, 10));
    const onInput = (event) => {
      settings.set(control.setting, fromControl(event.target.value));
    };
    input.addEventListener('input', onInput);
    onDestroy(() => input.removeEventListener('input', onInput));
    follow(control.setting, (value) => { input.value = toControl(value); });
    if (control.onlyWhen) {
      const { setting, equals } = control.onlyWhen;
      follow(setting, (value) => { row.style.display = value === equals ? '' : 'none'; });
    }
    row.appendChild(input);
    return row;
  };

  const buildMeter = () => {
    const row = el('div', 'voice-settings-row mic-meter-row');
    const label = el('label', 'voice-settings-label');
    label.appendChild(doc.createTextNode('🎙️ '));
    const span = el('span');
    i18nText(span, 'voice_settings.mic_level');
    label.appendChild(span);
    row.appendChild(label);
    const meter = el('div', 'mic-meter');
    withId(meter, 'mic-level-meter');
    const fill = el('div', 'mic-meter-fill');
    withId(fill, 'mic-meter-fill');
    const threshold = el('div', 'mic-meter-threshold');
    withId(threshold, 'mic-meter-threshold');
    addTitle(threshold, 'voice_settings.gate_threshold');
    meter.append(fill, threshold);
    row.appendChild(meter);

    // Where the gate sits on the meter. Same mapping as voice.js:
    // threshold = 2 + (sensitivity / 100) * 38, on a meter that shows 0 to 50.
    const showThreshold = () => {
      const sensitivity = settings.get('noiseMode') === 'gate' ? settings.get('noiseSensitivity') : 0;
      if (sensitivity === 0) { threshold.style.display = 'none'; return; }
      const value = 2 + (sensitivity / 100) * 38;
      threshold.style.display = '';
      threshold.style.left = `${(value / 50) * 100}%`;
    };
    showThreshold();
    onDestroy(settings.subscribe('noiseMode', showThreshold));
    onDestroy(settings.subscribe('noiseSensitivity', showThreshold));

    // The loop runs only while the meter is on screen, and only touches the
    // DOM when the whole percent changes. (#5456)
    let frame = null;
    let observer = null;
    const getLevel = options.getMicLevel || (() => 0);
    const run = () => {
      if (frame || destroyed || !env.requestAnimationFrame) return;
      let lastWidth = null;
      const tick = () => {
        const width = `${Math.round(getLevel())}%`;
        if (width !== lastWidth) { fill.style.width = width; lastWidth = width; }
        frame = env.requestAnimationFrame(tick);
      };
      frame = env.requestAnimationFrame(tick);
    };
    const stop = () => {
      if (frame && env.cancelAnimationFrame) env.cancelAnimationFrame(frame);
      frame = null;
      fill.style.width = '0%';
    };
    if (typeof env.IntersectionObserver === 'function') {
      observer = new env.IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) run(); else stop();
      });
      observer.observe(fill);
    } else {
      run();
    }
    onDestroy(() => { if (observer) observer.disconnect(); stop(); });
    return row;
  };

  // The bitrate is an editable field: type a number and confirm with Enter or
  // by leaving it; out-of-range input clamps to the nearest bound. Holding a
  // step button auto-repeats with acceleration.
  const buildBitrate = (control) => {
    const setting = control.setting;
    const row = el('div', 'voice-settings-row');
    addLabel(row, control);
    const stepper = el('div', 'bitrate-stepper');
    const minus = el('button', 'bitrate-step-btn', { 'aria-label': '−', 'data-bitrate-step': '-1' });
    minus.textContent = '−';
    withId(minus, 'screen-bitrate-minus');
    const field = el('input', 'bitrate-value', {
      inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', 'data-setting': setting,
    });
    withId(field, 'screen-bitrate-value');
    nameControl(field, control.labelKey);
    const plus = el('button', 'bitrate-step-btn', { 'aria-label': '+', 'data-bitrate-step': '1' });
    plus.textContent = '+';
    withId(plus, 'screen-bitrate-plus');
    stepper.append(minus, field, plus);
    row.appendChild(stepper);

    // Commit guards. ES modules run in strict mode, so these are declared
    // before use or every typed commit throws. (#5672)
    let escapePressed = false;
    let blurSuppressed = false;

    const text = (kbps) => (kbps > 0 ? `${kbps} Kbps` : tr('voice_settings.bitrate_unlimited'));
    // Unconditional write: stepper presses are explicit intent and must sync
    // the field even while it is focused.
    const writeField = (kbps) => { field.value = text(kbps); };
    // A render from elsewhere must not fight someone typing.
    const render = (kbps) => { if (doc.activeElement === field) return; writeField(kbps); };

    const parseField = () => {
      const raw = String(field.value ?? '').toLowerCase();
      if (/unlimited|ilimitado|inf/.test(raw)) return 0;
      const digits = raw.replace(/[^0-9]/g, '');
      if (!digits) return null;
      const n = parseInt(digits, 10);
      if (!Number.isSafeInteger(n)) return null;
      if (n <= 0) return 0;
      if (n < 300) return 300;
      if (n > 10000) return 0; // above the range wraps to unlimited
      return n;
    };
    const commit = () => {
      const parsed = parseField();
      if (parsed === null) { render(settings.get(setting)); return; }
      settings.set(setting, parsed);
      // The blur below fires the blur listener again: suppress that second
      // commit, Enter already confirmed once.
      blurSuppressed = true;
      try { field.blur(); } finally { blurSuppressed = false; }
      render(settings.get(setting));
    };
    const stepBy = (dir, magnitude = 100, saturate = false) => {
      const cur = settings.get(setting) || 0;
      let next;
      if (dir < 0) {
        // From unlimited, step down into the top of the range. A hold must
        // never slide down to 0, which means unlimited.
        if (cur === 0) next = 10000;
        else next = saturate ? Math.max(300, cur - magnitude) : cur - magnitude;
      } else {
        // Past the top of the range wraps to unlimited.
        next = cur === 0 ? 300 : cur + magnitude;
      }
      settings.set(setting, next);
      writeField(settings.get(setting));
    };

    // Press-and-hold auto-repeat: first repeat after 400 ms, then every 80 ms
    // with the step growing as the hold goes on.
    const holdRepeat = (button, dir) => {
      let timer = null;
      let interval = null;
      let repeats = 0;
      let pressed = false;
      // The active pointer: a second finger's pointerdown is ignored instead
      // of overwriting `timer` and leaking the first press's timeout.
      let activePointerId = null;
      const stopTimers = () => {
        clearTimeout(timer);
        clearInterval(interval);
        timer = interval = null;
        repeats = 0;
      };
      const tick = () => {
        repeats++;
        const magnitude = repeats > 20 ? 400 : repeats > 10 ? 200 : 100;
        stepBy(dir, magnitude, true);
      };
      const foreign = (e) => e && e.pointerId !== undefined && activePointerId !== null && e.pointerId !== activePointerId;

      const on = (type, fn) => {
        button.addEventListener(type, fn);
        onDestroy(() => button.removeEventListener(type, fn));
      };
      on('pointerdown', (e) => {
        if (activePointerId !== null) return; // multitouch: keep the first press
        e.preventDefault();
        activePointerId = e.pointerId ?? 'mouse';
        pressed = true;
        stepBy(dir); // one step right away on press
        timer = setTimeout(() => { interval = setInterval(tick, 80); }, 400);
      });
      // Keyboard activation (Enter/Space) clicks with detail 0 and no
      // pointerdown. A pointer click after its own pointerdown is consumed
      // once, including touch's pointerup, pointerleave, click.
      on('click', (e) => {
        if (e && e.detail === 0) { stepBy(dir); return; }
        if (pressed) { pressed = false; return; }
        stepBy(dir);
      });
      // pointerup is followed by click, which consumes `pressed`.
      on('pointerup', (e) => {
        if (foreign(e)) return;
        activePointerId = null;
        stopTimers();
      });
      // pointerleave must NOT clear `pressed`: on touch the order is pointerup,
      // pointerleave, click, so clearing here would double-step.
      on('pointerleave', (e) => {
        if (foreign(e)) return;
        activePointerId = null;
        stopTimers();
      });
      // pointercancel is never followed by click, so it clears both, but only
      // for the active press.
      on('pointercancel', (e) => {
        if (foreign(e)) return;
        pressed = false;
        activePointerId = null;
        stopTimers();
      });
      onDestroy(stopTimers);
    };
    holdRepeat(minus, -1);
    holdRepeat(plus, +1);

    const onKeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        // Discard the typed text instead of confirming it.
        escapePressed = true;
        writeField(settings.get(setting));
        field.blur();
      }
      e.stopPropagation();
    };
    const onBlur = () => {
      if (escapePressed) { escapePressed = false; writeField(settings.get(setting)); return; }
      if (blurSuppressed) return;
      commit();
    };
    const onFocus = () => { field.select?.(); };
    field.addEventListener('keydown', onKeydown);
    field.addEventListener('blur', onBlur);
    field.addEventListener('focus', onFocus);
    onDestroy(() => {
      field.removeEventListener('keydown', onKeydown);
      field.removeEventListener('blur', onBlur);
      field.removeEventListener('focus', onFocus);
    });
    follow(setting, render);
    return row;
  };

  const include = new Set(options.include || []);
  for (const control of CONTROLS) {
    if (control.optional && !include.has(control.setting)) continue;
    let node;
    switch (control.kind) {
      case 'section': {
        node = el('div', 'voice-settings-section-label');
        node.appendChild(doc.createTextNode(`${control.icon} `));
        const span = el('span');
        i18nText(span, control.labelKey);
        node.appendChild(span);
        break;
      }
      case 'divider': node = el('div', 'voice-settings-divider'); break;
      case 'select': node = buildSelect(control); break;
      case 'range': node = buildRange(control); break;
      case 'meter': node = buildMeter(); break;
      case 'bitrate': node = buildBitrate(control); break;
      default: continue;
    }
    host.appendChild(node);
  }

  return {
    element: host,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      while (cleanups.length) {
        try { cleanups.pop()(); } catch (err) { console.error('[CallSettings] panel cleanup failed', err); }
      }
      host.replaceChildren();
    },
  };
}
