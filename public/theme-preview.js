// The toolbar on public/theme-preview.html, the static copy of the app for
// theme authors (#5631). Loads a .theme.css file over the built-in Haven
// theme, switches between the chat and forum views, and shows or hides the
// Settings modal and the profile card. Nothing else on that page runs.
(function () {
  var $ = function (s) { return document.querySelector(s); };

  function view(v) {
    var current = $('#messages');
    var src = $(v === 'forum' ? '#preview-forum' : '#preview-chat');
    if (!current || !src || !src.content || !src.content.firstElementChild) return;
    current.replaceWith(src.content.firstElementChild.cloneNode(true));
    document.querySelectorAll('#theme-preview-tools [data-view]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === v);
    });
  }

  function theme(path) {
    var old = document.getElementById('preview-theme');
    if (old) old.remove();
    // 'haven' is the layout base a published theme loads over, as in the app.
    document.documentElement.setAttribute('data-theme', 'haven');
    if (!path) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.id = 'preview-theme';
    link.href = path;
    document.head.appendChild(link);
  }

  var tools = $('#theme-preview-tools');
  if (!tools) return;
  tools.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.view) view(b.dataset.view);
    if (b.dataset.toggle) {
      var el = $(b.dataset.toggle);
      if (el) el.style.display = getComputedStyle(el).display === 'none' ? (b.dataset.toggle === '#settings-modal' ? 'flex' : 'block') : 'none';
    }
    if (b.dataset.apply) theme($('#preview-theme-path').value.trim());
    if (b.dataset.clear) { $('#preview-theme-path').value = ''; theme(''); }
    if (b.dataset.fold) {
      tools.classList.toggle('folded');
      b.textContent = tools.classList.contains('folded') ? 'Show' : 'Hide';
    }
  });
  $('#preview-theme-path').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') theme(e.target.value.trim());
  });

  var q = new URLSearchParams(location.search).get('theme');
  if (q) { $('#preview-theme-path').value = q; theme(q); }
})();
