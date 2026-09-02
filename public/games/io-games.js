// Haven — .io Games Browser
const IO_GAMES = [
  { name: 'Agar.io', url: 'https://agar.io', icon: '\u{1F7E2}', descKey: 'agar', genre: 'classic' },
  { name: 'Slither.io', url: 'https://slither.io', icon: '\u{1F40D}', descKey: 'slither', genre: 'classic' },
  { name: 'Diep.io', url: 'https://diep.io', icon: '\u{1F52B}', descKey: 'diep', genre: 'shooter' },
  { name: 'Krunker.io', url: 'https://krunker.io', icon: '\u{1F3AF}', descKey: 'krunker', genre: 'fps' },
  { name: 'Surviv.io', url: 'https://surviv.io', icon: '\u{1F3DD}\uFE0F', descKey: 'surviv', genre: 'battle_royale' },
  { name: 'Shell Shockers', url: 'https://shellshock.io', icon: '\u{1F95A}', descKey: 'shell', genre: 'fps' },
  { name: 'Zombs Royale', url: 'https://zombsroyale.io', icon: '\u{1F9DF}', descKey: 'zombs', genre: 'battle_royale' },
  { name: 'Paper.io 2', url: 'https://paper-io.com/2/', icon: '\u{1F4C4}', descKey: 'paper', genre: 'territory' },
  { name: 'Hole.io', url: 'https://hole-io.com', icon: '\u{1F573}\uFE0F', descKey: 'hole', genre: 'casual' },
  { name: 'Skribbl.io', url: 'https://skribbl.io', icon: '\u{1F3A8}', descKey: 'skribbl', genre: 'party' },
  { name: 'Mope.io', url: 'https://mope.io', icon: '\u{1F98A}', descKey: 'mope', genre: 'survival' },
  { name: 'Defly.io', url: 'https://defly.io', icon: '\u{1F681}', descKey: 'defly', genre: 'territory' },
  { name: 'Florr.io', url: 'https://florr.io', icon: '\u{1F338}', descKey: 'florr', genre: 'survival' },
  { name: 'Ev.io', url: 'https://ev.io', icon: '\u26A1', descKey: 'ev', genre: 'fps' },
  { name: 'Gulper.io', url: 'https://gulper.io', icon: '\u{1F41B}', descKey: 'gulper', genre: 'classic' },
  { name: 'Taming.io', url: 'https://taming.io', icon: '\u{1F43A}', descKey: 'taming', genre: 'survival' },
  { name: 'Territorial.io', url: 'https://territorial.io', icon: '\u{1F5FA}\uFE0F', descKey: 'territorial', genre: 'strategy' },
  { name: 'Yohoho.io', url: 'https://yohoho.io', icon: '\u{1F3F4}\u200D\u2620\uFE0F', descKey: 'yohoho', genre: 'battle_royale' },
  { name: 'Narrow One', url: 'https://narrow.one', icon: '\u{1F3F9}', descKey: 'narrow', genre: 'fps' },
  { name: 'Bloxd.io', url: 'https://bloxd.io', icon: '\u{1F9F1}', descKey: 'bloxd', genre: 'sandbox' },
  { name: 'Venge.io', url: 'https://venge.io', icon: '\u{1F4A5}', descKey: 'venge', genre: 'fps' },
  { name: 'Bonk.io', url: 'https://bonk.io', icon: '\u26AA', descKey: 'bonk', genre: 'party' },
  { name: 'Stabfish.io', url: 'https://stabfish.io', icon: '\u{1F41F}', descKey: 'stabfish', genre: 'casual' },
  { name: 'Wormax.io', url: 'https://wormax.io', icon: '\u{1FAB1}', descKey: 'wormax', genre: 'classic' },
];

const grid = document.getElementById('io-grid');
const searchInput = document.getElementById('io-search');

function renderGames(filter) {
  filter = filter || '';
  grid.innerHTML = '';
  const f = filter.toLowerCase();
  const filtered = IO_GAMES.filter(function(g) {
    return g.name.toLowerCase().includes(f) ||
      t(`games.io.description.${g.descKey}`).toLowerCase().includes(f) ||
      t(`games.io.genre.${g.genre}`).toLowerCase().includes(f);
  });

  for (const game of filtered) {
    const card = document.createElement('div');
    card.className = 'io-card';
    card.innerHTML =
      '<div class="io-card-icon">' + game.icon + '</div>' +
      '<div class="io-card-name">' + game.name + '</div>' +
      '<div class="io-card-desc">' + t(`games.io.description.${game.descKey}`) + '</div>' +
      '<span class="io-card-genre">' + t(`games.io.genre.${game.genre}`) + '</span>';
    card.addEventListener('click', function() {
      window.open(game.url, '_blank');
    });
    grid.appendChild(card);
  }

  if (filtered.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:#8b949e;padding:40px;">${t('games.io.no_matches')}</div>`;
  }
}

searchInput.addEventListener('input', function() {
  renderGames(searchInput.value);
});

I18n.init().then(() => renderGames());
