'use strict';

const fs = require('node:fs');
const path = require('node:path');

const THEME_API_VERSION = 1;
const BUILTIN_THEMES = ['', 'haven', 'discord', 'matrix', 'tron', 'halo', 'lotr', 'cyberpunk', 'nord', 'dracula', 'bloodborne', 'darksouls', 'eldenring', 'ice', 'abyss', 'minecraft', 'ffx', 'zelda', 'fallout', 'scripture', 'chapel', 'gospel', 'midnightpurple', 'crt', 'win95', 'rgb', 'daylight', 'cloudy', 'lemonade', 'strawberry'];
const THEME_FILENAME_PATTERN = /^(?!\.)[a-zA-Z0-9_. -]+\.theme\.css$/;

function metadataBlock(content) {
  if (typeof content !== 'string') return '';
  return content.match(/\/\*\*[\s\S]*?\*\//)?.[0] || '';
}

function metadataDeclarations(block) {
  if (!block) return [];
  const body = block.replace(/^\/\*\*/, '').replace(/\*\/$/, '');
  const lines = body.split(/\r?\n/);

  if (lines.length === 1) {
    const declarations = [];
    const tags = [...body.matchAll(/(?:^|\s)@([a-z][\w-]*)\b/gi)];
    for (let i = 0; i < tags.length; i++) {
      const valueStart = tags[i].index + tags[i][0].length;
      const valueEnd = i + 1 < tags.length ? tags[i + 1].index : body.length;
      declarations.push({
        tag: tags[i][1].toLowerCase(),
        value: body.slice(valueStart, valueEnd).trim(),
      });
    }
    return declarations;
  }

  return lines.flatMap(line => {
    const normalized = line.replace(/^\s*\*?\s*/, '');
    const match = normalized.match(/^@([a-z][\w-]*)(?:\s+(.*))?$/i);
    return match ? [{ tag: match[1].toLowerCase(), value: (match[2] || '').trim() }] : [];
  });
}

function classifyThemeApi(declared) {
  if (declared == null) {
    return {
      themeApi: null,
      themeApiDeclared: null,
      compatibility: 'legacy',
      compatible: true,
    };
  }

  const raw = String(declared).trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    return {
      themeApi: null,
      themeApiDeclared: raw,
      compatibility: 'invalid',
      compatible: false,
    };
  }

  const version = Number(raw);
  if (!Number.isSafeInteger(version)) {
    return {
      themeApi: null,
      themeApiDeclared: raw,
      compatibility: 'invalid',
      compatible: false,
    };
  }
  return {
    themeApi: version,
    themeApiDeclared: raw,
    compatibility: version === THEME_API_VERSION ? 'compatible' : 'unsupported',
    compatible: version === THEME_API_VERSION,
  };
}

// The colours the theme picker draws a theme's preview card with, read from
// the file's own palette tokens. Only plain colour literals are passed on,
// since the client puts them in a style attribute.
const SWATCH_TOKENS = { bg: '--bg-primary', panel: '--bg-secondary', accent: '--accent', text: '--text-primary' };
const COLOR_LITERAL = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?)\([\d\s.,%/+-]{1,60}\))$/i;

function themeSwatch(content) {
  if (typeof content !== 'string') return null;
  const swatch = {};
  for (const [key, token] of Object.entries(SWATCH_TOKENS)) {
    const value = content.match(new RegExp(`(?<![\\w-])${token}\\s*:\\s*([^;}!]+)`))?.[1].trim();
    if (value && COLOR_LITERAL.test(value)) swatch[key] = value;
  }
  return swatch.bg ? swatch : null;
}

function parseThemeMetadata(content) {
  const block = metadataBlock(content);
  const declarations = metadataDeclarations(block);
  const meta = {};
  const fields = {
    name: 'name',
    description: 'description',
    author: 'author',
    version: 'version',
    icon: 'icon',
    category: 'category',
    section: 'section',
  };

  for (const [property, tag] of Object.entries(fields)) {
    const value = declarations.find(item => item.tag === tag)?.value;
    if (value) meta[property] = value;
  }

  const themeApiDeclarations = declarations
    .filter(item => item.tag === 'haven-theme-api')
    .map(item => item.value);
  const declared = themeApiDeclarations.length > 1
    ? themeApiDeclarations.join(', ')
    : themeApiDeclarations[0];
  return {
    ...meta,
    ...classifyThemeApi(declared === undefined ? null : declared),
    // A file that sets the page background is a full palette, not a stackable
    // tweak. Settings toggles for those used to keep injecting :root tokens
    // after the picker moved to Matrix.
    palette: typeof content === 'string' && /--bg-primary\s*:/.test(content),
    swatch: themeSwatch(content),
  };
}

function isThemeFilename(file) {
  return typeof file === 'string' && THEME_FILENAME_PATTERN.test(file);
}

function themeFileFromRequestPath(requestPath) {
  if (typeof requestPath !== 'string') return null;
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (!decoded.toLowerCase().endsWith('.theme.css')) return undefined;
  const file = decoded.slice(1);
  if (decoded !== `/${file}` || !isThemeFilename(file)) return null;
  return file;
}

function createThemeFileMiddleware(directory) {
  return function serveThemeFile(req, res, next) {
    const originalPath = typeof req.originalUrl === 'string'
      ? req.originalUrl.split('?')[0].slice((req.baseUrl || '').length)
      : req.path;
    const file = themeFileFromRequestPath(originalPath);
    if (file === undefined) return next();
    if (!file) return res.sendStatus(404);

    try {
      const content = fs.readFileSync(path.join(directory, file), 'utf8');
      const metadata = parseThemeMetadata(content);
      if (!metadata.compatible) {
        return res.status(409).type('text/plain')
          .send('Theme API version is incompatible with this Haven server.');
      }
      res.setHeader('Cache-Control', 'no-cache');
      return res.type('text/css').send(content);
    } catch (err) {
      if (err?.code === 'ENOENT') return res.sendStatus(404);
      return res.sendStatus(500);
    }
  };
}

function readThemeMetadataFile(directory, file) {
  if (!isThemeFilename(file)) return null;
  try {
    const content = fs.readFileSync(path.join(directory, file), 'utf8');
    return { file, ...parseThemeMetadata(content) };
  } catch {
    return null;
  }
}

function readThemeMetadataSnapshot(directory) {
  return fs.readdirSync(directory)
    .filter(isThemeFilename)
    .map(file => {
      const content = fs.readFileSync(path.join(directory, file), 'utf8');
      return { file, ...parseThemeMetadata(content) };
    });
}

function compatibleThemeFiles(directory, files) {
  if (!Array.isArray(files)) return [];
  return [...new Set(files)].filter(file => readThemeMetadataFile(directory, file)?.compatible);
}

function validatedThemeDefault(directory, value, publishedFiles) {
  if (typeof value !== 'string' || !value) return '';
  const file = value.startsWith('file:') ? value.slice(5) : value;
  const usable = publishedFiles.includes(file) && readThemeMetadataFile(directory, file)?.compatible;
  if (usable) return `file:${file}`;
  // A name that can only refer to a theme file, but does not resolve to one, never
  // reaches the client as a theme name: it would apply no stylesheet and raise no
  // error, so an admin would see a healthy setting and an unthemed page.
  return isThemeFilename(file) ? '' : value;
}

// Whether an account may save `value` as its theme. Haven's own themes and
// published theme files are open to everyone. An unpublished file is only for
// people who manage the server, apart from the account's current theme and
// the server's Default Theme, so saving again never takes a look away.
function themePreferenceAllowed(value, { published = [], current = '', defaultTheme = '', canManage = false } = {}) {
  if (typeof value !== 'string' || !value.startsWith('file:')) return true;
  if (canManage === true) return true;
  if (value === current || value === defaultTheme) return true;
  return Array.isArray(published) && published.includes(value.slice(5));
}

module.exports = {
  THEME_API_VERSION,
  BUILTIN_THEMES,
  classifyThemeApi,
  compatibleThemeFiles,
  createThemeFileMiddleware,
  isThemeFilename,
  parseThemeMetadata,
  readThemeMetadataFile,
  readThemeMetadataSnapshot,
  themeFileFromRequestPath,
  themePreferenceAllowed,
  themeSwatch,
  validatedThemeDefault,
};
