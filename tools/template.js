#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const USAGE = `Haven server templates

  node tools/template.js export --data <dir> [--out file.json] [--posts pinned|none] [--post-authors "Guide,Welcome Bot"]
                                [--exclude-channel name]... [--no-assets] [--name text] [--description text] [--author text]
  node tools/template.js import <file.json> --data <dir> [--mode merge|replace] [--dry-run] [--as admin-username]
                                [--no-posts] [--no-webhooks] [--no-join] [--install-themes]
  node tools/template.js check <file.json>

--data is Haven's data folder (the one holding haven.db and uploads/).
export only reads the database. Stop Haven before import, or restart it afterwards.
merge adds what is missing and leaves everything already on the server alone.
replace also updates matching channels, roles and settings to the template. Neither mode deletes anything.`;
function parseArgs(argv) {
  const out = { _: [], multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (['dry-run', 'no-assets', 'no-posts', 'no-webhooks', 'no-join', 'install-themes', 'help'].includes(key)) { out[key] = true; continue; }
    const val = argv[++i];
    if (val === undefined) throw new Error(`--${key} needs a value`);
    key === 'exclude-channel' ? (out.multi[key] = [...(out.multi[key] || []), val]) : (out[key] = val);
  }
  return out;
}
function readTemplate(file) {
  const stat = fs.statSync(file);
  const { LIMITS, validateTemplate } = require('../src/serverTemplate');
  if (stat.size > LIMITS.bytes) throw new Error(`${file} is larger than ${LIMITS.bytes / 1048576} MB`);
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
  const res = validateTemplate(json);
  if (res.errors) throw new Error(`The template is not valid:\n  ${res.errors.join('\n  ')}`);
  res.warnings.forEach((w) => console.warn(`warning: ${w}`));
  return res.template;
}
function printReport(r) {
  const line = (label, list) => list.length && console.log(`${label} (${list.length}): ${list.join(', ')}`);
  console.log(`${r.dryRun ? 'Dry run, nothing was changed' : 'Applied'} (${r.mode})`);
  line('Created roles', r.created.roles); line('Created channels', r.created.channels); line('Updated roles', r.updated.roles); line('Updated channels', r.updated.channels);
  line('Updated settings', r.updated.settings); line('Already on the server, left alone', [...r.existing.roles, ...r.existing.channels, ...r.existing.settings]);
  line('On the server but not in the template, kept', [...r.extra.roles, ...r.extra.channels]); line('Created webhooks', r.created.webhooks);
  line('Copied files', r.created.files); line('Installed themes', r.created.themes); line('Created emojis', r.created.emojis); line('Created stickers', r.created.stickers);
  console.log(`Posts: ${r.counts.posts}, role menus: ${r.counts.roleMenus}, link rules: ${r.counts.domains}, role channel access rows: ${r.counts.access}`);
  r.warnings.forEach((w) => console.warn(`warning: ${w}`));
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help || !['export', 'import', 'check'].includes(cmd)) return console.log(USAGE);
  if (cmd === 'check') {
    const tpl = readTemplate(args._[1] || '');
    return console.log(JSON.stringify(require('../src/serverTemplate').summarizeTemplate(tpl), null, 2));
  }
  if (!args.data) throw new Error('--data <dir> is required');
  const dataDir = path.resolve(args.data);
  const themesDir = path.join(__dirname, '..', 'themes');
  // Images are read and written through that server's storage: its uploads
  // folder, or its bucket when HAVEN_EXTERNAL_STORAGE is set.
  process.env.HAVEN_DATA_DIR = dataDir;
  if (cmd === 'export') {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(dataDir, 'haven.db'), { readonly: true, fileMustExist: true });
    const { exportTemplate } = require('../src/serverTemplate');
    const { template, warnings } = await exportTemplate(db, {
      themesDir, posts: args.posts === 'none' ? 'none' : 'pinned', assets: !args['no-assets'],
      postAuthors: args['post-authors'] ? args['post-authors'].split(',').map((s) => s.trim()).filter(Boolean) : null,
      excludeChannels: args.multi['exclude-channel'] || [], meta: { name: args.name, description: args.description, author: args.author },
      havenVersion: require('../package.json').version,
    });
    db.close();
    warnings.forEach((w) => console.warn(`warning: ${w}`));
    const json = JSON.stringify(template, null, 2) + '\n';
    args.out ? fs.writeFileSync(args.out, json) : process.stdout.write(json);
    if (args.out) console.error(`Wrote ${args.out}: ${template.channels.length} channels, ${template.roles.length} roles, ${template.posts.length} posts, ${Object.keys(template.assets).length} files`);
    return;
  }
  const file = args._[1];
  if (!file) throw new Error('Give the template file to import');
  const tpl = readTemplate(file);
  const { initDatabase } = require('../src/database');
  const db = initDatabase();
  const actor = args.as
    ? db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND is_admin = 1').get(args.as)
    : db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
  if (args.as && !actor) throw new Error(`${args.as} is not an admin on this server`);
  const report = await require('../src/serverTemplate').applyTemplate(db, tpl, {
    mode: args.mode === 'replace' ? 'replace' : 'merge', actorId: actor ? actor.id : null, themesDir,
    dryRun: !!args['dry-run'], posts: !args['no-posts'], webhooks: !args['no-webhooks'], joinMembers: !args['no-join'], installThemes: !!args['install-themes'],
  });
  db.close();
  printReport(report);
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
