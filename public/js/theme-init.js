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
  var t = localStorage.getItem('haven_theme');
  if (t) {
    if (t.indexOf('file:') === 0) {
      // File theme: inject the CSS link immediately so the theme applies on
      // the login page (where plugin-loader doesn't run) and avoids a FOUC
      // on the app page while waiting for plugin-loader's 500 ms startup
      // delay. The data-theme is set to 'haven' as a stable layout base,
      // matching what applyFileTheme() does when the plugin-loader runs. (#5359)
      var _fl = document.createElement('link');
      _fl.rel = 'stylesheet';
      _fl.href = '/themes/' + t.slice(5);
      _fl.id = 'haven-theme-file-early';
      document.head.appendChild(_fl);
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
  var fxRaw = localStorage.getItem('haven_effects') || 'auto';
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
