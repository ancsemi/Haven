const q = new URLSearchParams(location.search), game = q.get('game') || '', log = console.log.bind(console), load = document.getElementById('load'), files = new Map(), PREF = '/pref/Amni/Arcade/', KEY = 'haven-arcade:', GLK = 'haven-arcade-gl';
const ids = { shippy: 'flappy', pool: 'arcade-pool', minigolf: 'arcade-minigolf' };
const send = (g, n) => { const id = ids[g] || 'arcade-' + g, m = { type: 'game-score', game: id, score: n }; let tok = new URLSearchParams(location.hash.slice(1)).get('token') || ''; try { tok ||= localStorage.getItem('haven_token') || ''; } catch {} try { window.HavenArcade ? window.HavenArcade.score(id, n) : window.webkit?.messageHandlers?.havenArcade ? window.webkit.messageHandlers.havenArcade.postMessage({ game: id, score: n }) : parent !== window ? parent.postMessage(m, location.origin) : window.opener ? window.opener.postMessage(m, location.origin) : tok && fetch('/api/high-scores', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ game: id, score: n }) }).catch(() => {}); } catch {} };
console.log = (...a) => { const m = /^ARCADE_SCORE (\S+) (\d+)$/.exec(String(a[0] ?? '')); if (m) send(m[1], +m[2]); log(...a); };
let gl = q.has('gl'); try { gl ||= sessionStorage.getItem(GLK) === '1'; } catch {}
if (gl) try { Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true }); } catch {}
else if (navigator.gpu) { const ra = navigator.gpu.requestAdapter.bind(navigator.gpu); let slow = false; navigator.gpu.requestAdapter = o => slow ? Promise.resolve(null) : Promise.race([ra(o).catch(() => null), new Promise(r => setTimeout(() => { slow = true; r(null); }, 4000))]); }
const enc = new TextEncoder(), dec = new TextDecoder();
try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(KEY)) files.set(PREF + k.slice(KEY.length), enc.encode(localStorage.getItem(k))); } } catch {}
const onsave = p => { if (p.startsWith(PREF)) try { localStorage.setItem(KEY + p.slice(PREF.length), dec.decode(files.get(p))); } catch {} };
let failed = false;
const fail = e => { if (failed) return; failed = true; log(e); if (!gl && !globalThis.heWebGL) { try { sessionStorage.setItem(GLK, '1'); location.reload(); return; } catch {} } load.textContent = 'The arcade could not start on this device.'; document.body.appendChild(load); };
addEventListener('unhandledrejection', e => { if (/Instance reference|device (was |is )?lost|GPUDevice/i.test(String(e.reason))) fail(e.reason); });
try {
  const get = async (p, ...urls) => { for (const u of urls) { const r = await fetch(u).catch(() => null); if (r?.ok) return files.set(p, new Uint8Array(await r.arrayBuffer())); } };
  await Promise.all([get('assets/fonts/Nunito-Bold.ttf', 'assets/fonts/Nunito-Bold.ttf'), get('assets/shippy/avatar.png', '../bird-avatar.png', 'assets/shippy/avatar.png')]);
  const { start } = await import('./helium.js');
  const rt = await start({ wasm: 'arcade.wasm', files, onsave, jspi: false, onerror: fail, args: ['arcade', '--frames', ...(game ? ['--game', game] : [])] });
  const tick = t => { if (failed || !rt.alive()) return; rt.call('he_frame', t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  requestAnimationFrame(() => requestAnimationFrame(() => failed || load.remove()));
  document.querySelector('canvas').focus();
} catch (e) { fail(e); }
