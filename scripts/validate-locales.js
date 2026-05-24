#!/usr/bin/env node
/**
 * validate-locales.js (#5357)
 * ----------------------------------------------------------------------
 * Validates one or more `public/locales/*.json` files against the master
 * English locale (`en.json`). Used by the translations auto-merge CI
 * workflow (.github/workflows/translations-autovalidate.yml) and also
 * runnable locally:
 *
 *   node scripts/validate-locales.js                   # check all locales
 *   node scripts/validate-locales.js public/locales/fr.json
 *
 * Exit code 0 = pass, 1 = fail. Warnings (extra keys, missing keys) do
 * NOT fail the run — only structural problems do, so partial translations
 * are still mergeable.
 *
 * Checks performed:
 *   1. File parses as JSON.
 *   2. Top-level `_meta.locale`, `_meta.language`, `_meta.flag` exist
 *      and are strings (and `_meta.locale` matches the filename).
 *   3. Every key that's present in the target has the same VALUE TYPE
 *      (string vs object) as the corresponding key in en.json. (i.e.
 *      no accidentally turning a string into an object or vice versa,
 *      which would break the i18n lookup at runtime.)
 *   4. No keys reference paths that don't exist in en.json (warn — could
 *      indicate a typo or a stale string).
 *   5. Reports missing keys (warn — fine for in-progress translations).
 *
 * IMPORTANT FOR FUTURE AGENTS:
 *   If you add new translation keys to en.json, the other locale files
 *   will fall behind (missing keys are reported as warnings, not errors).
 *   That's intentional so en.json can ship without blocking on every
 *   other language. The CI workflow only auto-merges PRs that touch
 *   non-en locales; PRs that touch en.json still need normal review.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'public', 'locales');
const MASTER_FILE = path.join(LOCALES_DIR, 'en.json');

function loadJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw); // throws on parse error — caught by caller
}

// Walk an object and yield "dot.path" -> typeof value pairs.
// Arrays are treated as terminal values (we store their type as 'array').
function* walk(obj, prefix = '') {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    yield [prefix, Array.isArray(obj) ? 'array' : typeof obj];
    return;
  }
  for (const k of Object.keys(obj)) {
    const child = obj[k];
    const next = prefix ? `${prefix}.${k}` : k;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      yield* walk(child, next);
    } else {
      yield [next, Array.isArray(child) ? 'array' : typeof child];
    }
  }
}

function buildShape(obj) {
  const map = new Map();
  for (const [k, t] of walk(obj)) map.set(k, t);
  return map;
}

function validateLocale(filePath, master) {
  const result = { file: filePath, errors: [], warnings: [] };
  let data;
  try {
    data = loadJson(filePath);
  } catch (err) {
    result.errors.push(`Invalid JSON: ${err.message}`);
    return result;
  }
  // _meta requirements
  if (!data || typeof data !== 'object') {
    result.errors.push('Top-level value is not an object');
    return result;
  }
  const meta = data._meta;
  if (!meta || typeof meta !== 'object') {
    result.errors.push('Missing _meta object');
  } else {
    for (const field of ['locale', 'language', 'flag']) {
      if (typeof meta[field] !== 'string' || !meta[field].trim()) {
        result.errors.push(`Missing or non-string _meta.${field}`);
      }
    }
    const fname = path.basename(filePath, '.json');
    if (typeof meta.locale === 'string' && meta.locale !== fname) {
      result.errors.push(`_meta.locale "${meta.locale}" doesn't match filename "${fname}.json"`);
    }
  }
  // Structure compatibility with master
  const shape = buildShape(data);
  for (const [k, t] of shape) {
    if (k.startsWith('_meta')) continue;
    if (!master.has(k)) {
      result.warnings.push(`Unknown key "${k}" — not present in en.json (possible typo or stale)`);
      continue;
    }
    const masterType = master.get(k);
    if (masterType !== t) {
      result.errors.push(`Key "${k}" type mismatch — en.json has "${masterType}", this file has "${t}"`);
    }
  }
  // Missing keys (warn only)
  let missing = 0;
  for (const k of master.keys()) {
    if (k.startsWith('_meta')) continue;
    if (!shape.has(k)) missing++;
  }
  if (missing > 0) {
    result.warnings.push(`${missing} keys missing from this locale (partial translation — OK, English will be used as fallback)`);
  }
  return result;
}

function main() {
  let master;
  try {
    master = buildShape(loadJson(MASTER_FILE));
  } catch (err) {
    console.error(`FATAL: cannot load master locale ${MASTER_FILE}: ${err.message}`);
    process.exit(2);
  }

  const argv = process.argv.slice(2);
  let targets;
  if (argv.length > 0) {
    targets = argv.map(p => path.resolve(p));
  } else {
    targets = fs.readdirSync(LOCALES_DIR)
      .filter(f => f.endsWith('.json') && f !== 'en.json')
      .map(f => path.join(LOCALES_DIR, f));
  }

  let failed = 0;
  for (const file of targets) {
    const rel = path.relative(process.cwd(), file);
    const res = validateLocale(file, master);
    if (res.errors.length === 0) {
      console.log(`✓ ${rel}  (${res.warnings.length} warning${res.warnings.length === 1 ? '' : 's'})`);
    } else {
      failed++;
      console.log(`✗ ${rel}`);
    }
    for (const w of res.warnings) console.log(`    warn: ${w}`);
    for (const e of res.errors)   console.log(`    ERROR: ${e}`);
  }

  if (failed > 0) {
    console.error(`\n${failed} locale file(s) failed validation.`);
    process.exit(1);
  }
  console.log(`\nAll ${targets.length} locale file(s) passed.`);
}

if (require.main === module) main();

module.exports = { validateLocale, buildShape };
