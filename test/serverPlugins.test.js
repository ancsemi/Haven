'use strict';

// A plugin file the server runs is server code: only the shipped copy is
// loaded, and the extension updater never touches it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SERVER_LOADED, isServerLoaded, fingerprint, loadServerPlugin } = require('../src/serverPlugins');

const ROOT = path.join(__dirname, '..');
const NAME = 'AutoModQuarantine.plugin.js';
const shipped = path.join(ROOT, 'plugins', NAME);

test('the shipped plugin matches its fingerprint, whatever the line endings', () => {
  const bytes = fs.readFileSync(shipped);
  assert.equal(fingerprint(bytes), SERVER_LOADED[NAME], 'the plugin changed: update its fingerprint in src/serverPlugins.js in the same commit');
  const crlf = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  assert.equal(fingerprint(crlf), SERVER_LOADED[NAME]);
  assert.equal(typeof loadServerPlugin(shipped), 'function');
});

test('an edited, replaced or unknown file is not run', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-srvplug-'));
  const said = [];
  try {
    const edited = path.join(tmp, NAME);
    fs.writeFileSync(edited, fs.readFileSync(shipped, 'utf8') + '\nglobalThis.__ranEdited = true;\n');
    assert.equal(loadServerPlugin(edited, m => said.push(m)), null);
    assert.equal(globalThis.__ranEdited, undefined, 'the edited file was never executed');
    assert.match(said[0], /not the file shipped/);

    const other = path.join(tmp, 'Other.plugin.js');
    fs.writeFileSync(other, 'globalThis.__ranOther = true; module.exports = class {};');
    assert.equal(loadServerPlugin(other, m => said.push(m)), null);
    assert.equal(globalThis.__ranOther, undefined);

    assert.equal(loadServerPlugin(path.join(tmp, 'gone', NAME), m => said.push(m)), null, 'a deleted plugin is fine');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the extension updater leaves server-run plugins alone', () => {
  assert.equal(isServerLoaded(NAME), true);
  assert.equal(isServerLoaded('plugins/' + NAME), true);
  assert.equal(isServerLoaded('BraidLayout.plugin.js'), false);
  const src = fs.readFileSync(path.join(ROOT, 'src/extensionUpdates.js'), 'utf8');
  assert.match(src, /endsWith\(extensionSuffix\(type\)\) && !isServerLoaded\(f\)/, 'never listed');
  assert.match(src, /assertValid\(!isServerLoaded\(item\.file\)/, 'never written');
  assert.match(fs.readFileSync(path.join(ROOT, 'src/routes/automodRelay.js'), 'utf8'), /return loadServerPlugin\(pluginPath\)/);
});

test('no bundled plugin or theme names a repo to update itself from', () => {
  for (const dir of ['plugins', 'themes']) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of fs.readdirSync(full).filter(f => /\.(plugin\.js|theme\.css)$/.test(f))) {
      const head = fs.readFileSync(path.join(full, file), 'utf8').slice(0, 4000);
      assert.doesNotMatch(head, /@update-repo/, `${dir}/${file}`);
    }
  }
});
