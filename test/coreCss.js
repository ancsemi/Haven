'use strict';

// style.css is a list of @import lines; the rules live in the files it
// imports. Tests that look for a rule read the stylesheet the way a browser
// does: style.css with every imported file put in place of its @import line.

const fs = require('node:fs');
const path = require('node:path');

const CSS_DIR = path.join(__dirname, '..', 'public', 'css');

function readCss(file, seen = new Set()) {
  if (seen.has(file)) return '';
  seen.add(file);
  const text = fs.readFileSync(path.join(CSS_DIR, file), 'utf8').replace(/^﻿/, '');
  return text.replace(/@import url\('\/css\/([\w.-]+\.css)(?:\?[^']*)?'\);/g, (_, name) => readCss(name, seen));
}

module.exports = { readCoreCss: () => readCss('style.css'), CSS_DIR };
