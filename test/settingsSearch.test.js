'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const HTML = read('public/app.html');
const SOURCE = read('public/js/modules/app-forum.js');
const el = (props) => {
  const classes = new Set(props.classes || []);
  return { ...props, scrollTop: 50, classList: { contains: c => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
};
const hidden = (node) => node.classList.contains('settings-search-hidden');
function buildDom() {
  const marks = [...HTML.matchAll(/<div class="(settings-section[^"]*|admin-settings)" id="([^"]+)"/g)];
  const panelAt = HTML.indexOf('id="admin-mod-panel"');
  const units = marks.map((m, i) => el({ id: m[2], classes: m[1].split(' '), inPanel: m.index > panelAt && m[1] === 'admin-settings', textContent: HTML.slice(m.index, marks[i + 1]?.index ?? HTML.indexOf('/settings-body-admin')).replace(/<[^>]+>/g, ' ') }));
  const adminGroupAt = HTML.indexOf('class="settings-nav-admin-group"');
  const navMarks = [...HTML.slice(0, HTML.indexOf('</nav>', adminGroupAt)).matchAll(/<div class="(settings-nav-item|settings-nav-group-label)[^"]*"(?:[^>]*data-target="([^"]+)")?/g)];
  const navNodes = navMarks.map(m => el({ classes: [m[1]], target: m[2], admin: m.index > adminGroupAt, style: {} }));
  navNodes.forEach((n, i) => { n.nextElementSibling = navNodes[i + 1]?.admin === n.admin ? navNodes[i + 1] : null; });
  const bodies = [el({ id: 'settings-body-user' }), el({ id: 'settings-body-admin' })];
  const matchOne = (sel, u) => sel === '.settings-section:not(#admin-mod-panel)' ? u.classList.contains('settings-section') && u.id !== 'admin-mod-panel' : sel === '#admin-mod-panel > .admin-settings' ? u.inPanel : sel === '.settings-section' && u.classList.contains('settings-section');
  const input = { value: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
  const nav = { insertBefore() {}, querySelector: sel => navNodes.find(n => n.classList.contains('settings-nav-item') && sel === `.settings-nav-item[data-target="${n.target}"]`) || null, querySelectorAll: sel => sel === '.settings-nav-group-label' ? navNodes.filter(n => n.classList.contains('settings-nav-group-label')) : [] };
  const modal = { addEventListener() {}, querySelectorAll: sel => sel === '.settings-body' ? bodies : units.filter(u => sel.split(',').some(s => matchOne(s.trim(), u))) };
  const document = { getElementById: id => ({ 'settings-nav': nav, 'settings-modal': modal })[id] || null, createElement: () => ({ querySelector: () => input }) };
  return { document, input, units, navNodes, bodies };
}
function search(query) {
  const dom = buildDom();
  const context = vm.createContext({ module: { exports: {} }, document: dom.document, t: k => k, localStorage: { getItem: () => null }, console });
  vm.runInContext(SOURCE.replace(/^export default/m, 'module.exports ='), context, { filename: 'app-forum.js' });
  context.module.exports._setupSettingsSearch.call({});
  dom.input.value = query;
  dom.input.listeners.input();
  const unit = id => dom.units.find(u => u.id === id);
  const navItem = id => dom.navNodes.find(n => n.target === id);
  return { ...dom, unit, navItem };
}
test('admin settings are searched one section at a time', () => {
  const r = search('role');
  assert.equal(hidden(r.unit('section-roles')), false);
  assert.equal(hidden(r.navItem('section-roles')), false);
  assert.equal(hidden(r.unit('section-update')), true);
  assert.equal(hidden(r.navItem('section-update')), true);
  assert.equal(hidden(r.navItem('section-branding')), true);
  assert.equal(hidden(r.unit('admin-mod-panel')), false);
});
test('every admin nav entry points at a section the search can hide', () => {
  const r = search('zzzz-no-such-setting');
  const adminItems = r.navNodes.filter(n => n.admin && n.target);
  assert.ok(adminItems.length > 20);
  adminItems.forEach(n => assert.equal(hidden(n), true, n.target));
});
test('user settings still filter and the body scrolls back to the top', () => {
  const r = search('zoom');
  assert.equal(hidden(r.unit('section-zoom')), false);
  assert.equal(hidden(r.unit('section-password')), true);
  assert.equal(hidden(r.navItem('section-password')), true);
  r.bodies.forEach(b => assert.equal(b.scrollTop, 0));
});
test('clearing the query shows everything again', () => {
  const r = search('role');
  r.input.value = '';
  r.input.listeners.input();
  r.units.forEach(u => assert.equal(hidden(u), false, u.id));
  r.navNodes.forEach(n => assert.equal(hidden(n), false));
});
