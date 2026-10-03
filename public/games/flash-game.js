// Haven — Flash Game Loader (Ruffle)
// Parse game info from URL params: ?swf=URL&title=NAME
const params = new URLSearchParams(window.location.search);
const swfUrl = params.get('swf');
const title = params.get('title');

// Volume control
const volSlider = document.getElementById('volume-slider');
const volPct = document.getElementById('volume-pct');
let ruffleInstance = null;

volSlider.addEventListener('input', () => {
  const val = parseInt(volSlider.value);
  volPct.textContent = val + '%';
  applyVolume(val);
});

function applyVolume(val) {
  try {
    if (ruffleInstance && ruffleInstance.volume !== undefined) {
      ruffleInstance.volume = val / 100;
    }
  } catch {}
}

function initRuffle() {
  const container = document.getElementById('ruffle-container');
  const loadingMsg = document.getElementById('loading-msg');

  try {
    const ruffle = window.RufflePlayer.newest();
    const player = ruffle.createPlayer();

    player.style.width = '100%';
    player.style.height = '100%';

    loadingMsg.remove();
    container.appendChild(player);

    ruffleInstance = player;

    player.load(swfUrl).then(() => {
      applyVolume(parseInt(volSlider.value));
    }).catch((err) => {
      container.innerHTML = `<div class="error-msg">${t('games.flash.swf_failed', { error: err.message })}<br><br>${t('games.flash.swf_hint')}</div>`;
    });

    setTimeout(() => {
      if (loadingMsg.parentNode) {
        loadingMsg.innerHTML = `<div class="error-msg">${t('games.flash.timeout')}</div>`;
      }
    }, 20000);
  } catch (err) {
    const loadingMsg = document.getElementById('loading-msg');
    if (loadingMsg) loadingMsg.innerHTML = `<div class="error-msg">${t('games.flash.init_error', { error: err.message })}</div>`;
  }
}

function loadGame() {
  if (!swfUrl) {
    document.getElementById('loading-msg').innerHTML = `<div class="error-msg">${t('games.flash.no_file')}</div>`;
    return;
  }

  // Ruffle is served by this server (see /games/ruffle in server.js), and
  // loads its .wasm from the same folder.
  window.RufflePlayer = window.RufflePlayer || {};
  window.RufflePlayer.config = Object.assign({ publicPath: '/games/ruffle/' }, window.RufflePlayer.config);
  const script = document.createElement('script');
  script.src = '/games/ruffle/ruffle.js';
  script.onload = () => initRuffle();
  script.onerror = () => {
    document.getElementById('loading-msg').innerHTML =
      `<div class="error-msg">${t('games.flash.emulator_failed')}<br>${t('games.flash.not_installed')}</div>`;
  };
  document.head.appendChild(script);
}

I18n.init().then(() => {
  const displayTitle = title || t('games.flash.default_title');
  document.getElementById('game-title').textContent = displayTitle;
  document.title = t('games.page_title', { title: displayTitle });
  loadGame();
});

// Listen for volume messages from parent (Haven game iframe header)
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'set-volume' && typeof e.data.volume === 'number') {
    const vol = Math.round(e.data.volume * 100);
    volSlider.value = vol;
    volPct.textContent = vol + '%';
    applyVolume(vol);
  }
});
