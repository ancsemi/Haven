// Builds public/theme-preview.html from a running Haven: a static copy of the
// app with whatever is on screen, for theme authors to open in a live CSS
// editor without a server (#5631). See docs/theme-authoring.md.
//
// How to refresh the file:
//   1. Open a forum channel with a few topics and run, in the browser console:
//        window.__havenPreviewForum = document.getElementById('messages').outerHTML;
//   2. Open a text channel with a good spread of messages (markdown, a picture,
//      a poll, reactions, a reply), click a name so the profile card is open,
//      then paste this whole file into the console. It downloads
//      theme-preview.html; put it in public/ and commit it.
//
// What it does: clones the page, drops every script and all but one modal,
// swaps uploaded pictures for a placeholder so the file works offline, strips
// the per-user theme variables so the built-in Haven theme is the base, and
// adds a small toolbar for loading a .theme.css file and switching between the
// chat and forum views.
(async () => {
  const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6b4fdb"/><stop offset="1" stop-color="#43b581"/></linearGradient></defs><rect width="480" height="300" fill="url(#g)"/><text x="240" y="162" text-anchor="middle" font-family="sans-serif" font-size="34" font-weight="700" fill="#fff">sample image</text></svg>'
  );

  const root = document.documentElement.cloneNode(true);

  // Nothing runs in the preview: no scripts, no service worker, no live theme.
  root.querySelectorAll('script, noscript, link[rel="manifest"], link[id^="haven-theme-"], #preview-theme, #theme-preview-tools, #preview-chat, #preview-forum').forEach(n => n.remove());

  // One modal is plenty to style against; the rest only add weight.
  const keepModals = new Set(['settings-modal']);
  root.querySelectorAll('.modal-overlay').forEach(m => { if (!keepModals.has(m.id)) m.remove(); });
  ['dm-pip-panel', 'pins-pip-panel', 'move-msg-toolbar', 'audio-container', 'online-overlay', 'toast-container'].forEach(id => root.querySelector('#' + id)?.remove());

  // The built-in Haven theme is the base a file theme loads over, so the
  // capturing user's own theme choice must not ride along.
  root.removeAttribute('style');
  root.removeAttribute('data-fx-custom');
  root.removeAttribute('data-hide-statusbar');
  root.removeAttribute('data-no-gif');
  root.setAttribute('data-theme', 'haven');

  // Absolute paths become relative so the file opens from a checkout, and
  // uploaded pictures become a placeholder so it works offline.
  const fixUrl = (el, attr) => {
    const v = el.getAttribute(attr);
    if (!v) return;
    if (/^\/uploads\//.test(v)) el.setAttribute(attr, el.tagName === 'IMG' ? PLACEHOLDER : '');
    else if (v.startsWith('/') && !v.startsWith('//')) el.setAttribute(attr, v.slice(1).replace(/\?.*$/, ''));
  };
  root.querySelectorAll('img[data-lazy-src]').forEach(img => { img.setAttribute('src', img.getAttribute('data-lazy-src')); img.removeAttribute('data-lazy-src'); });
  root.querySelectorAll('[src]').forEach(el => fixUrl(el, 'src'));
  root.querySelectorAll('link[rel="stylesheet"]').forEach(el => fixUrl(el, 'href'));
  root.querySelectorAll('a[href^="/"]').forEach(el => el.setAttribute('href', '#'));
  root.querySelectorAll('[style*="/uploads/"]').forEach(el => el.setAttribute('style', el.getAttribute('style').replace(/url\((['"]?)\/uploads\/[^)'"]*\1\)/g, `url(${PLACEHOLDER})`)));
  // Message elements carry their raw text and encrypted-file pointers as data
  // attributes; neither belongs in a static page.
  root.querySelectorAll('[data-raw-content], [data-e2e-url], [data-e2e-src]').forEach(el => { el.removeAttribute('data-raw-content'); el.removeAttribute('data-e2e-url'); el.removeAttribute('data-e2e-src'); });

  const body = root.querySelector('body');
  const messages = root.querySelector('#messages');
  const chatHtml = messages ? messages.outerHTML : '';
  const forumHtml = String(window.__havenPreviewForum || '')
    .replace(/src="\/uploads\/[^"]*"/g, `src="${PLACEHOLDER}"`)
    .replace(/\sdata-lazy-src="[^"]*"/g, '');

  // The two views are kept as templates; the toolbar swaps them in.
  const tplChat = document.createElement('template'); tplChat.id = 'preview-chat'; tplChat.innerHTML = chatHtml;
  const tplForum = document.createElement('template'); tplForum.id = 'preview-forum'; tplForum.innerHTML = forumHtml;
  body.appendChild(tplChat);
  body.appendChild(tplForum);

  const style = document.createElement('style');
  style.id = 'theme-preview-tools-style';
  style.textContent = `
#theme-preview-tools { position: fixed; top: 8px; right: 8px; z-index: 2147483647; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px; background: rgba(12, 12, 20, 0.92); color: #eee; border: 1px solid #444; border-radius: 10px; font: 12px/1.3 system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,0.5); max-width: 46rem; }
#theme-preview-tools strong { margin-right: 4px; }
#theme-preview-tools label { display: flex; align-items: center; gap: 4px; }
#theme-preview-tools input { width: 15rem; padding: 4px 6px; border: 1px solid #555; border-radius: 6px; background: #1a1a24; color: #eee; font: inherit; }
#theme-preview-tools button { padding: 4px 8px; border: 1px solid #555; border-radius: 6px; background: #22222e; color: #eee; font: inherit; cursor: pointer; }
#theme-preview-tools button.active { background: #6b4fdb; border-color: #6b4fdb; color: #fff; }
#theme-preview-tools .sep { width: 1px; height: 18px; background: #444; }
#theme-preview-tools .hide { margin-left: auto; opacity: 0.7; }
#theme-preview-tools.folded > :not(.hide) { display: none; }
`;
  body.appendChild(style);

  const tools = document.createElement('div');
  tools.id = 'theme-preview-tools';
  tools.innerHTML = `
<strong>Theme preview</strong>
<label>Theme file <input id="preview-theme-path" placeholder="../themes/braid.theme.css" spellcheck="false"></label>
<button type="button" data-apply="1">Apply</button>
<button type="button" data-clear="1">Clear</button>
<span class="sep"></span>
<button type="button" data-view="chat" class="active">Chat</button>
<button type="button" data-view="forum"${forumHtml ? '' : ' disabled'}>Forum</button>
<button type="button" data-toggle="#settings-modal">Settings modal</button>
<button type="button" data-toggle="#profile-popup">Profile card</button>
<button type="button" class="hide" data-fold="1">Hide</button>`;
  body.appendChild(tools);

  // The toolbar's behaviour lives in public/theme-preview.js so the served
  // page passes the app's script policy and the file works from a checkout.
  const script = document.createElement('script');
  script.src = 'theme-preview.js';
  body.appendChild(script);

  // The Settings modal quotes this server's address in a few places.
  const html = ('<!DOCTYPE html>\n<!-- Generated by scripts/theme-preview-capture.js from a running Haven. A static copy of the app with sample content, for theme authors: open it from a checkout in a browser or a live CSS editor, type the path of a .theme.css file in the toolbar, and see it applied. Not used by the app itself. See docs/theme-authoring.md. -->\n' + root.outerHTML)
    .split(location.origin).join('https://your-haven-address');
  window.__havenPreviewOut = html;
  try {
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'theme-preview.html';
    a.click();
  } catch (e) {
    console.warn('[theme-preview] download failed, the HTML is in window.__havenPreviewOut', e);
  }
  console.log('[theme-preview] built', html.length, 'characters');
})();
