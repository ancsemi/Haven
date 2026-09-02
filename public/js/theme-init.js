// Apply saved theme immediately to prevent flash of unstyled content
(function() {
  // Disable browser scroll restoration. With body { overflow: hidden } the
  // app shouldn't ever be "scrolled" at the document level, but Android
  // Chrome can scroll the html element when the visual viewport changes
  // (URL bar / keyboard) and then persist that scroll across reloads.
  // That's what made the entire UI appear shifted up after a refresh in
  // issue #5285. Force-reset on every load.
  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch(e) {}
  function resetDocScroll() {
    try {
      if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
      if (document.documentElement) document.documentElement.scrollTop = 0;
      if (document.body) document.body.scrollTop = 0;
    } catch(e) {}
  }
  resetDocScroll();
  window.addEventListener('load', resetDocScroll);
  window.addEventListener('pageshow', resetDocScroll);
  window.addEventListener('resize', resetDocScroll);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', resetDocScroll);
    window.visualViewport.addEventListener('scroll', resetDocScroll);
  }
  // Toggle style (sliders vs classic checkboxes). Applied before first paint
  // so on/off settings don't render as one shape and then swap to the other.
  // Sliders are the default, so only an explicit 'box' choice changes it.
  try {
    var _ts = localStorage.getItem('haven-toggle-style');
    document.documentElement.setAttribute('data-toggle-style', _ts === 'box' ? 'box' : 'switch');
  } catch (e) {
    document.documentElement.setAttribute('data-toggle-style', 'switch');
  }

  // Public density state is available before first paint. Layout plugins and
  // themes can react without reading Haven's private message geometry values.
  try {
    var _density = localStorage.getItem('haven-density');
    if (['compact', 'cozy', 'spacious'].indexOf(_density) < 0) _density = 'cozy';
    document.documentElement.setAttribute('data-density', _density);
    document.documentElement.setAttribute('data-haven-density', _density);
  } catch (e) {
    document.documentElement.setAttribute('data-density', 'cozy');
    document.documentElement.setAttribute('data-haven-density', 'cozy');
  }

  // Apply the saved interface scale before first paint so the UI doesn't render
  // at 100% and then jump. Mirrors the slider logic in app-media.js and
  // migrates the retired 4-tier font-size setting.
  try {
    var _z = parseInt(localStorage.getItem('haven-zoom'), 10);
    if (!_z) {
      var _legacyZoom = { small: 85, normal: 100, large: 118, 'x-large': 138 };
      _z = _legacyZoom[localStorage.getItem('haven-fontsize')] || 100;
    }
    _z = Math.min(150, Math.max(70, _z));
    document.documentElement.style.setProperty('--ui-scale', _z + '%');
  } catch (e) {}

  var _themeCompat = window.HavenThemeCompat;
  var _safeMode = _themeCompat ? _themeCompat.isSafeMode(window.location) : false;
  var _resetPending = _themeCompat ? _themeCompat.isResetPending() : false;
  if (!_themeCompat) {
    try {
      var _safeRequest = new URLSearchParams(window.location.search).get('haven-safe-mode');
      if (_safeRequest === '1') sessionStorage.setItem('haven_safe_mode', '1');
      if (_safeRequest === '0') sessionStorage.removeItem('haven_safe_mode');
      _safeMode = _safeRequest === '1'
        || (_safeRequest !== '0' && sessionStorage.getItem('haven_safe_mode') === '1');
      _resetPending = sessionStorage.getItem('haven_customizations_reset_pending') === '1';
    } catch {
      _safeMode = new URLSearchParams(window.location.search).get('haven-safe-mode') === '1';
    }
  }
  if (_safeMode) document.documentElement.setAttribute('data-haven-safe-mode', '1');

  function _injectEarlyTheme(file, onSettled) {
    if (document.getElementById('haven-theme-file-early')) {
      if (onSettled) onSettled();
      return;
    }
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/themes/' + encodeURIComponent(file);
    link.id = 'haven-theme-file-early';
    if (onSettled) {
      link.onload = onSettled;
      link.onerror = onSettled;
    }
    document.head.appendChild(link);
  }

  // Safe mode and a pending recovery reset always start from Haven's base
  // appearance. Preferences stay stored until the user explicitly resets them.
  var t = (_safeMode || _resetPending) ? 'haven' : localStorage.getItem('haven_theme');
  if (t) {
    if (t.indexOf('file:') === 0) {
      // File theme: inject the CSS link immediately so the theme applies on
      // the login page (where plugin-loader doesn't run) and avoids a FOUC
      // on the app page while waiting for plugin-loader's 500 ms startup
      // delay. The data-theme is set to 'haven' as a stable layout base,
      // matching what applyFileTheme() does when the plugin-loader runs. (#5359)
      var _themeFile = t.slice(5);
      var _cachedTheme = _themeCompat ? _themeCompat.getCachedTheme(_themeFile) : null;
      if (_cachedTheme && _cachedTheme.compatible) {
        _injectEarlyTheme(_themeFile);
      } else {
        // Validate an uncached theme immediately. Hide the base briefly so a
        // first load does not flash Haven before the compatible CSS arrives.
        document.documentElement.setAttribute('data-haven-theme-pending', _themeFile);
        if (_themeCompat?.fetchThemes && typeof window.fetch === 'function') {
          document.documentElement.style.setProperty('visibility', 'hidden');
          var _finishThemeCheck = function() {
            document.documentElement.removeAttribute('data-haven-theme-pending');
            document.documentElement.style.removeProperty('visibility');
          };
          setTimeout(_finishThemeCheck, 3000);
          _themeCompat.fetchThemes(window.fetch.bind(window)).then(function(themes) {
            if (Array.isArray(themes)) {
              _themeCompat.cacheThemes(themes);
              var selected = themes.find(function(theme) { return theme?.file === _themeFile; });
              if (selected && selected.compatible !== false
                  && selected.compatibility !== 'invalid'
                  && selected.compatibility !== 'unsupported') {
                _injectEarlyTheme(_themeFile, _finishThemeCheck);
                return;
              }
            }
            _finishThemeCheck();
          });
        }
      }
      document.documentElement.setAttribute('data-theme', 'haven');
    } else {
      document.documentElement.setAttribute('data-theme', t);
    }
  }
  // Defensive: if the saved theme is NOT custom/rgb, strip any inline CSS
  // custom properties that may have been left on :root during a prior theme
  // (e.g. switching custom → win95 in a previous session, then a server
  // preferences event re-applying custom mid-session, then back). Without
  // this, a leftover --bg-primary on :root would override the win95 theme's
  // own --bg-primary and leave large surfaces rendering with a dark color
  // while explicitly-styled chrome (sidebar, channel header) looks correct.
  if (t && t !== 'custom' && t !== 'rgb') {
    var leakedKeys = ['--accent','--accent-hover','--accent-dim','--accent-glow',
      '--bg-primary','--bg-secondary','--bg-tertiary','--bg-hover','--bg-active',
      '--bg-input','--bg-card','--text-primary','--text-secondary','--text-muted',
      '--text-link','--border','--border-light','--success','--danger','--warning',
      '--led-on','--led-off','--led-glow'];
    for (var i = 0; i < leakedKeys.length; i++) {
      document.documentElement.style.removeProperty(leakedKeys[i]);
    }
  }
  // Apply effect overlay system (stackable) — always strip theme pseudo-element effects
  document.documentElement.setAttribute('data-fx-custom', '');
  var fxRaw = (_safeMode || _resetPending) ? '[]' : (localStorage.getItem('haven_effects') || 'auto');
  var fxMode;
  try { fxMode = JSON.parse(fxRaw); } catch(e) { fxMode = fxRaw; }
  // Apply CRT class early for scanline var + font (prevents FOUC)
  var fxList = [];
  if (Array.isArray(fxMode)) { fxList = fxMode; }
  else if (fxMode === 'auto' && t) {
    var defaults = {matrix:1,fallout:1,ffx:1,ice:1,nord:1,darksouls:1,bloodborne:1,cyberpunk:1,lotr:1,abyss:1,scripture:1,chapel:1,gospel:1};
    if (defaults[t]) fxList = [t];
  }
  if (fxList.indexOf('crt') >= 0) document.documentElement.classList.add('fx-crt');
  // Apply custom theme variables if custom theme is active
  if (t === 'custom') {
    try {
      var hsv = JSON.parse(localStorage.getItem('haven_custom_hsv'));
      if (hsv && typeof hsv.h === 'number') {
        var h = hsv.h, s = hsv.s, v = hsv.v;
        function _hsvRgb(h,s,v) {
          h=((h%360)+360)%360; var c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c,r,g,b;
          if(h<60){r=c;g=x;b=0}else if(h<120){r=x;g=c;b=0}else if(h<180){r=0;g=c;b=x}
          else if(h<240){r=0;g=x;b=c}else if(h<300){r=x;g=0;b=c}else{r=c;g=0;b=x}
          return[Math.round((r+m)*255),Math.round((g+m)*255),Math.round((b+m)*255)];
        }
        function _hex(h,s,v){var c=_hsvRgb(h,s,v);return'#'+c.map(function(x){return x.toString(16).padStart(2,'0')}).join('')}
        var el = document.documentElement;
        var vib = s; // vibrancy follows saturation for dramatic bg changes
        var bgSat = 0.05 + vib * 0.30;
        var bdrSat = 0.05 + vib * 0.25;
        el.style.setProperty('--accent', _hex(h,s,v));
        el.style.setProperty('--accent-hover', _hex(h,Math.max(s-.15,0),Math.min(v+.15,1)));
        el.style.setProperty('--accent-dim', _hex(h,Math.min(s+.1,1),Math.max(v-.2,0)));
        var rgb=_hsvRgb(h,s,v);
        el.style.setProperty('--accent-glow', 'rgba('+rgb.join(',')+',0.25)');
        el.style.setProperty('--bg-primary', _hex(h,bgSat,0.07+vib*0.03));
        el.style.setProperty('--bg-secondary', _hex(h,bgSat*0.85,0.09+vib*0.04));
        el.style.setProperty('--bg-tertiary', _hex(h,bgSat*0.7,0.12+vib*0.04));
        el.style.setProperty('--bg-hover', _hex(h,bgSat*0.7,0.15+vib*0.05));
        el.style.setProperty('--bg-active', _hex(h,bgSat*0.7,0.18+vib*0.06));
        el.style.setProperty('--bg-input', _hex(h,bgSat,0.05+vib*0.03));
        el.style.setProperty('--bg-card', _hex(h,bgSat*0.85,0.08+vib*0.04));
        el.style.setProperty('--border', _hex(h,bdrSat,0.16+vib*0.06));
        el.style.setProperty('--border-light', _hex(h,bdrSat,0.21+vib*0.06));
        el.style.setProperty('--text-link', _hex((h+180)%360,.7,.95));
      }
    } catch(e) {}
  }
  // RGB theme: set a neutral dark bg immediately; the cycle starts once theme.js loads
  if (t === 'rgb') {
    document.documentElement.setAttribute('data-theme', 'haven');
  }
})();
