'use strict';

// Which release an update goes to (Settings > Admin > Updates).
//
// Stable follows GitHub's latest release, which never includes a
// pre-release. Early access takes pre-releases too (v4.27.0-beta.1),
// whichever release is newest. Stable releases come out about weekly after
// the pre-releases before them have been tried; early access gets every
// release as it is made. Docker has the same two: :latest and :beta.

const API = 'https://api.github.com/repos/ancsemi/Haven/releases';

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

// -1, 0 or 1, the way semantic versioning orders them: a pre-release comes
// before the release it leads to (4.27.0-beta.2 < 4.27.0), and beta.10
// comes after beta.9.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) {
    if (x.pre.length === y.pre.length) return 0;
    return x.pre.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

// The release to update to: GitHub's release object.
async function latestRelease({ early = false, headers = {} } = {}) {
  if (!early) {
    const r = await fetch(`${API}/latest`, { headers });
    if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
    return r.json();
  }
  const r = await fetch(`${API}?per_page=20`, { headers });
  if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
  const list = (await r.json()).filter(rel => rel && !rel.draft && parseVersion(rel.tag_name));
  if (!list.length) throw new Error('GitHub lists no releases');
  return list.reduce((best, rel) => (compareVersions(rel.tag_name, best.tag_name) > 0 ? rel : best));
}

function earlyAccessOn(db) {
  try {
    return db.prepare("SELECT value FROM server_settings WHERE key = 'update_channel_early'").get()?.value === 'true';
  } catch (err) {
    console.warn('[update] Could not read the update channel, using stable:', err.message);
    return false;
  }
}

module.exports = { compareVersions, parseVersion, latestRelease, earlyAccessOn };
