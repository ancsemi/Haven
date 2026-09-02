// ── Password Show/Hide Eye Toggle ──────────────────────────
// Wraps every <input type="password"> (except those with data-no-eye) with
// a small button that toggles visibility. Lets users catch typos before
// submitting. Re-runs on DOM changes so dynamically-injected forms get the
// toggle too (settings panel, transfer-admin modal, self-delete, etc.).

(function () {
  const SVG_EYE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  const SVG_EYE_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';

  const STYLE_ID = 'haven-password-eye-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      .haven-pw-wrap { position: relative; display: block; width: 100%; }
      /* 3.20.2: width:100% + box-sizing fixes the gap on the login form
         where the input was collapsing to its intrinsic ~173px and the
         eye floated several px to the right of it. Padding bumped from
         36 → 30 to bring the eye visually closer to the field too. */
      .haven-pw-wrap input { padding-right: 30px !important; width: 100% !important; box-sizing: border-box !important; }
      .haven-pw-eye {
        position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
        background: transparent; border: none; cursor: pointer;
        color: var(--text-muted, #888); padding: 2px; border-radius: 4px;
        display: inline-flex; align-items: center; justify-content: center;
        line-height: 0;
      }
      .haven-pw-eye:hover { color: var(--text-primary, #fff); background: rgba(255,255,255,0.06); }
      .haven-pw-eye:focus-visible { outline: 2px solid var(--accent, #6c8cff); outline-offset: 1px; }
    `;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function attach(input) {
    if (!input || input.dataset.eyeAttached === '1') return;
    if (input.hasAttribute('data-no-eye')) return;
    if (input.type !== 'password') return;
    // Skip hidden / off-screen inputs (e.g. honeypot)
    if (input.offsetParent === null && getComputedStyle(input).display === 'none') {
      // Still attach — form may be revealed later. Continue.
    }

    const wrap = document.createElement('span');
    wrap.className = 'haven-pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'haven-pw-eye';
    btn.dataset.i18nAriaLabel = 'auth.aria.show_password';
    btn.setAttribute('aria-label', t('auth.aria.show_password'));
    btn.setAttribute('tabindex', '-1');
    btn.innerHTML = SVG_EYE;
    btn.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.innerHTML = showing ? SVG_EYE : SVG_EYE_OFF;
      const ariaKey = showing ? 'auth.aria.show_password' : 'auth.aria.hide_password';
      btn.dataset.i18nAriaLabel = ariaKey;
      btn.setAttribute('aria-label', t(ariaKey));
      // Keep focus on input so typing continues smoothly
      input.focus();
    });
    wrap.appendChild(btn);

    input.dataset.eyeAttached = '1';
  }

  function scan(root) {
    (root || document).querySelectorAll('input[type="password"]').forEach(attach);
  }

  function init() {
    ensureStyle();
    scan(document);

    // Watch for dynamically-added password inputs (settings, modals, etc.)
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches('input[type="password"]')) attach(node);
          if (node.querySelectorAll) scan(node);
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
