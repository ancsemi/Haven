export const BIRCH_ID = 'willowmere';
export const birchGame = (description) => ({ id: BIRCH_ID, name: 'Birch', icon: '🌳', path: '/birch/index.html', description });
export async function birchAvailable(fetchFn, token) {
  try {
    const res = await fetchFn('/api/birch/status', { headers: { Authorization: 'Bearer ' + token } });
    return res.ok && (await res.json()).enabled === true;
  } catch { return false; }
}
export const withBirch = (registry, available, game) => [...registry.filter(g => g.id !== game.id), ...(available ? [game] : [])];
export default {
  _birchStatus() { return birchAvailable(fetch, this.token); },
  _withBirchCard(registry, available) { return withBirch(registry, available, birchGame(t('activities_registry.willowmere'))); }
};
