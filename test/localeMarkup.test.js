'use strict';

// Translated text is put into the page as markup, so the locale checker
// refuses markup the English text does not have, and no workflow merges a
// translation by itself.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const check = (strings) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-locale-'));
  try {
    const file = path.join(dir, 'zz.json');
    fs.writeFileSync(file, JSON.stringify({ _meta: { locale: 'zz', language: 'Test', flag: 'zz' }, ...strings }));
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/validate-locales.js'), file], { encoding: 'utf8' });
    return { ok: run.status === 0, out: run.stdout + run.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('plain text and translated command hints pass', () => {
  assert.equal(check({ auth: { page_title: 'Haven | Anmelden' }, commands: { gif_usage: 'Nutzung: /gif <Suchbegriff>' } }).ok, true);
});

test('markup the English text does not have is refused', () => {
  for (const bad of ['<img src=x onerror=alert(1)>', '<style>a{}</style>', '<b>x</b>', '<a href="https://evil.example">x</a>', '<script>', '<svg/onload=x>']) {
    const res = check({ auth: { page_title: bad } });
    assert.equal(res.ok, false, bad);
    assert.match(res.out, /markup the English text does not/);
  }
  assert.equal(check({ commands: { gif_usage: '/gif <img src=x>' } }).ok, false, 'a hint cannot be a real element');
  assert.equal(check({ commands: { gif_usage: '/gif <input>' } }).ok, false);
});

test('the bundled translations pass the markup check', () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/validate-locales.js')], { encoding: 'utf8', cwd: ROOT });
  assert.doesNotMatch(run.stdout + run.stderr, /markup the English text does not|script or data address/);
});

test('no workflow merges a pull request by itself', () => {
  const dir = path.join(ROOT, '.github/workflows');
  for (const f of fs.readdirSync(dir)) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(code, /gh pr merge|--auto\b|enablePullRequestAutoMerge/, f);
  }
});
