'use strict';

// Plugin files the SERVER itself runs. A plugin is browser code an admin may
// add, edit or update, but the AutoMod link checks also load one into the
// server process, where it runs with everything the server can reach. So
// that file is treated as server code:
//
//   - it loads only when it is exactly the file this version of Haven
//     shipped (the fingerprint below); an edited, replaced or updated copy is
//     refused and the AI link checks stay off, with the reason in the log;
//   - the in-app extension updater never checks, offers or replaces it
//     (src/extensionUpdates.js).
//
// Changing the plugin therefore means changing its fingerprint here in the
// same commit, which test/serverPlugins.test.js enforces. That is on purpose:
// an edit to that file is an edit to the server and gets reviewed as one.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// sha256 of the file with line endings as LF.
const SERVER_LOADED = Object.freeze({
  'AutoModQuarantine.plugin.js': '9e935df454cfa19459e92657b84cea012f67dbb3047ed5526d0445adfe95f03c',
});

function isServerLoaded(file) {
  return Object.prototype.hasOwnProperty.call(SERVER_LOADED, path.basename(String(file)));
}

function fingerprint(bytes) {
  return crypto.createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
}

// The plugin's export, or null with a logged reason. Never throws: the
// server starts without the plugin.
function loadServerPlugin(pluginPath, log = console.warn) {
  const name = path.basename(pluginPath);
  try {
    if (!isServerLoaded(name)) {
      log(`[plugins] ${name} is not a plugin the server runs; not loaded`);
      return null;
    }
    if (!fs.existsSync(pluginPath)) return null; // an admin may delete it
    if (fingerprint(fs.readFileSync(pluginPath)) !== SERVER_LOADED[name]) {
      log(`[plugins] ${name} is not the file shipped with this version of Haven, so the server will not run it. AI link checks stay off until the original file is restored.`);
      return null;
    }
    return require(pluginPath);
  } catch (err) {
    log(`[plugins] ${name} could not be loaded: ${err.message}`);
    return null;
  }
}

module.exports = { SERVER_LOADED, isServerLoaded, fingerprint, loadServerPlugin };
