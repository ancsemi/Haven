// Accessibility settings (Settings > Accessibility): message text size, line
// and letter spacing, a readable font, high contrast, reduce motion,
// underlined links and larger click targets. Zoom sits in the same section and
// keeps its own code in app-appearance.js.
//
// theme-init.js owns the rules: it reads every option and applies it before
// first paint, and publishes the same two functions as window.HavenA11y. This
// module saves what the controls pick and asks it to apply again, so a page
// load and a live change go through one path. Everything is per device.

export default {

_setupAccessibility() {
  const a11y = window.HavenA11y;
  if (!a11y) return; // theme-init.js did not run (an old cached copy): nothing to drive
  const reapply = () => a11y.apply(a11y.read());
  const prefs = a11y.read();

  const textSlider = document.getElementById('text-size-slider');
  if (textSlider) {
    this._bindStepSlider({
      slider: textSlider,
      label: document.getElementById('text-size-value'),
      outBtn: document.getElementById('text-size-out-btn'),
      inBtn: document.getElementById('text-size-in-btn'),
      resetBtn: document.getElementById('text-size-reset-btn'),
      value: prefs.textSize,
      apply: (value, persist) => {
        if (!persist) return; // theme-init.js already applied the saved size
        this._saveA11y('haven-text-size', value === 100 ? null : String(value));
        reapply();
      },
    });
  }

  this._setupPicker('line-spacing-picker', 'haven-line-spacing', ['normal', 'relaxed', 'loose'], 'normal', 'lineSpacing', reapply);
  this._setupPicker('letter-spacing-picker', 'haven-letter-spacing', ['normal', 'wide'], 'normal', 'letterSpacing', reapply);
  this._setupPicker('reduce-motion-picker', 'haven-reduce-motion', ['system', 'on', 'off'], 'system', 'reduceMotion', reapply);

  const font = document.getElementById('readable-font-select');
  if (font) {
    font.value = prefs.font;
    font.addEventListener('change', () => {
      this._saveA11y('haven-readable-font', font.value === 'theme' ? null : font.value);
      reapply();
    });
  }

  // Twemoji instead of the system's emoji (style-themes.css).
  const emoji = document.getElementById('emoji-style-select');
  if (emoji) {
    emoji.value = prefs.emoji || 'system';
    emoji.addEventListener('change', () => {
      this._saveA11y('haven-emoji-style', emoji.value === 'system' ? null : emoji.value);
      reapply();
    });
  }

  // [checkbox id, storage key, stored value when on, field in prefs]
  [
    ['a11y-high-contrast', 'haven-contrast', 'high', 'highContrast'],
    ['a11y-underline-links', 'haven-underline-links', '1', 'underlineLinks'],
    ['a11y-large-targets', 'haven-large-targets', '1', 'largeTargets'],
  ].forEach(([id, key, onValue, field]) => {
    const box = document.getElementById(id);
    if (!box) return;
    box.checked = prefs[field];
    box.addEventListener('change', () => {
      this._saveA11y(key, box.checked ? onValue : null);
      reapply();
    });
  });

  // Theme effects listen for this themselves (theme.js). Pictures that were
  // frozen or left playing under the old setting are re-checked here, and
  // that includes "Follow system" seeing the OS setting change.
  document.addEventListener('haven:reduce-motion-change', () => {
    this._applyViewerAnimPref?.();
    this._applyViewerChatAnimPref?.();
  });
},

// A default is stored as no key at all, the way a fresh device has it.
_saveA11y(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage blocked (private mode): nothing is remembered, nothing else breaks */ }
},

// For scrollIntoView / scrollTo calls that would glide: reduce motion jumps.
_scrollBehavior() {
  return this._motionReduced() ? 'auto' : 'smooth';
},

};
