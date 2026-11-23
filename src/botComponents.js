'use strict';

// Embeds, buttons and dropdowns on bot messages, in Discord's shapes so a
// Discord bot's payload works here as it is:
//
//   embeds:     up to 10 cards with a title, text, fields, pictures, a colour
//   components: up to 5 action rows (type 1), each holding up to 5 buttons
//               (type 2) or one dropdown (type 3, Discord's string select)
//
// Only bots post these: a webhook through its API, a bot account over its
// own connection. A click or a pick goes back to the bot
// (socketHandlers/botInteractions.js), which answers with a private reply
// to the person, by editing the message, or by opening a form of text
// boxes (type 4, Discord's modal) for the person to fill in.
//
// Everything is checked and trimmed here, so the client can trust the shape
// it is handed. Text is cleaned like message text; links must be http(s) and
// pictures https or this server's uploads, like a bot's avatar.

const { sanitizeText } = require('./socketHandlers/helpers');
const { cleanWebhookAvatarUrl } = require('./webhookFields');

const LIMITS = {
  embeds: 10, total: 6000, title: 256, description: 4096, fields: 25,
  fieldName: 256, fieldValue: 1024, footer: 2048, author: 256,
  rows: 5, buttons: 5, label: 80, customId: 100, options: 25,
  optionText: 100, placeholder: 150, url: 2048,
  modalTitle: 45, inputs: 5, inputLabel: 45, inputPlaceholder: 100, inputValue: 4000,
};

const BUTTON = 2;
const SELECT = 3;
const TEXT_INPUT = 4;
// Discord's text box styles: one line, or a paragraph that takes line breaks.
const SHORT = 1;
const PARAGRAPH = 2;
// Discord's button styles: primary, secondary, success, danger, link.
const STYLES = new Set([1, 2, 3, 4, 5]);
const LINK = 5;

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_bot_parts (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      embeds TEXT,
      components TEXT
    );
  `);
}

class PartsError extends Error {}
const fail = (msg) => { throw new PartsError(msg); };

// Cleaned text, or undefined when there is none. Too long is refused rather
// than cut, so a bot learns its limit instead of posting half a sentence.
function text(value, max, where) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(`${where} must be a string`);
  const out = sanitizeText(value).trim();
  if (out.length > max) fail(`${where} is longer than ${max} characters`);
  return out || undefined;
}

function link(value, where) {
  if (value === undefined || value === null || value === '') return undefined;
  let url;
  try { url = new URL(String(value)); } catch { fail(`${where} is not a valid URL`); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.href.length > LIMITS.url) {
    fail(`${where} must be an http or https link`);
  }
  return url.href;
}

function picture(value, where) {
  if (value === undefined || value === null || value === '') return undefined;
  const url = cleanWebhookAvatarUrl(String(value));
  if (!url) fail(`${where} must be an https link or a /uploads/ file`);
  return url;
}

// A unicode emoji, as { "name": "👍" }. Discord's custom emoji ids mean
// nothing on this server, so only the name is kept.
function emoji(value, where) {
  if (value === undefined || value === null) return undefined;
  const name = typeof value === 'string' ? value : value && value.name;
  return text(name, 32, `${where}.emoji`);
}

function cleanEmbed(raw, i) {
  const at = `embeds[${i}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${at} must be an object`);
  const e = {};
  const set = (k, v) => { if (v !== undefined) e[k] = v; };
  set('title', text(raw.title, LIMITS.title, `${at}.title`));
  set('description', text(raw.description, LIMITS.description, `${at}.description`));
  set('url', link(raw.url, `${at}.url`));
  if (raw.color !== undefined && raw.color !== null) {
    if (!Number.isInteger(raw.color) || raw.color < 0 || raw.color > 0xFFFFFF) fail(`${at}.color must be a whole number from 0 to 16777215`);
    e.color = raw.color;
  }
  if (raw.timestamp !== undefined && raw.timestamp !== null) {
    const t = new Date(raw.timestamp);
    if (Number.isNaN(t.getTime())) fail(`${at}.timestamp must be an ISO 8601 date`);
    e.timestamp = t.toISOString();
  }
  if (raw.author) {
    const name = text(raw.author.name, LIMITS.author, `${at}.author.name`);
    if (name) e.author = { name, url: link(raw.author.url, `${at}.author.url`), icon_url: picture(raw.author.icon_url, `${at}.author.icon_url`) };
  }
  if (raw.footer) {
    const footer = text(raw.footer.text, LIMITS.footer, `${at}.footer.text`);
    if (footer) e.footer = { text: footer, icon_url: picture(raw.footer.icon_url, `${at}.footer.icon_url`) };
  }
  for (const k of ['thumbnail', 'image']) {
    const url = raw[k] ? picture(raw[k].url, `${at}.${k}.url`) : undefined;
    if (url) e[k] = { url };
  }
  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields)) fail(`${at}.fields must be an array`);
    if (raw.fields.length > LIMITS.fields) fail(`${at} has more than ${LIMITS.fields} fields`);
    e.fields = raw.fields.map((f, j) => {
      const where = `${at}.fields[${j}]`;
      if (!f || typeof f !== 'object') fail(`${where} must be an object`);
      const name = text(f.name, LIMITS.fieldName, `${where}.name`);
      const value = text(f.value, LIMITS.fieldValue, `${where}.value`);
      if (!name || !value) fail(`${where} needs a name and a value`);
      return { name, value, inline: f.inline === true };
    });
    if (!e.fields.length) delete e.fields;
  }
  if (!Object.keys(e).some(k => k !== 'color' && k !== 'url')) fail(`${at} is empty`);
  // Drop the undefined keys the nested objects picked up.
  return JSON.parse(JSON.stringify(e));
}

function embedLength(e) {
  return [e.title, e.description, e.author?.name, e.footer?.text, ...(e.fields || []).flatMap(f => [f.name, f.value])]
    .reduce((n, s) => n + (s ? s.length : 0), 0);
}

function cleanEmbeds(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('embeds must be an array');
  if (raw.length > LIMITS.embeds) fail(`A message can have up to ${LIMITS.embeds} embeds`);
  const embeds = raw.map(cleanEmbed);
  if (embeds.reduce((n, e) => n + embedLength(e), 0) > LIMITS.total) fail(`The embeds add up to more than ${LIMITS.total} characters`);
  return embeds;
}

function customId(value, where, seen) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) fail(`${where}.custom_id is required`);
  if (id.length > LIMITS.customId) fail(`${where}.custom_id is longer than ${LIMITS.customId} characters`);
  if (seen.has(id)) fail(`custom_id "${id}" is used twice in this message`);
  seen.add(id);
  return id;
}

function cleanButton(raw, where, seen) {
  const style = raw.style === undefined ? 1 : raw.style;
  if (!STYLES.has(style)) fail(`${where}.style must be 1 to 5`);
  const b = { type: BUTTON, style };
  const label = text(raw.label, LIMITS.label, `${where}.label`);
  const em = emoji(raw.emoji, where);
  if (!label && !em) fail(`${where} needs a label or an emoji`);
  if (label) b.label = label;
  if (em) b.emoji = { name: em };
  if (style === LINK) {
    b.url = link(raw.url, `${where}.url`);
    if (!b.url) fail(`${where} is a link button and needs a url`);
  } else {
    b.custom_id = customId(raw.custom_id, where, seen);
  }
  if (raw.disabled === true) b.disabled = true;
  return b;
}

function cleanSelect(raw, where, seen) {
  const s = { type: SELECT, custom_id: customId(raw.custom_id, where, seen) };
  if (!Array.isArray(raw.options) || !raw.options.length) fail(`${where}.options needs at least one option`);
  if (raw.options.length > LIMITS.options) fail(`${where} has more than ${LIMITS.options} options`);
  const values = new Set();
  s.options = raw.options.map((o, j) => {
    const at = `${where}.options[${j}]`;
    if (!o || typeof o !== 'object') fail(`${at} must be an object`);
    const label = text(o.label, LIMITS.optionText, `${at}.label`);
    const value = typeof o.value === 'string' ? o.value : '';
    if (!label) fail(`${at}.label is required`);
    if (!value || value.length > LIMITS.optionText) fail(`${at}.value is required (max ${LIMITS.optionText} characters)`);
    if (values.has(value)) fail(`${at}.value "${value}" is used twice`);
    values.add(value);
    const opt = { label, value };
    const description = text(o.description, LIMITS.optionText, `${at}.description`);
    if (description) opt.description = description;
    const em = emoji(o.emoji, at);
    if (em) opt.emoji = { name: em };
    if (o.default === true) opt.default = true;
    return opt;
  });
  const placeholder = text(raw.placeholder, LIMITS.placeholder, `${where}.placeholder`);
  if (placeholder) s.placeholder = placeholder;
  const min = raw.min_values === undefined ? 1 : raw.min_values;
  const max = raw.max_values === undefined ? 1 : raw.max_values;
  if (!Number.isInteger(min) || min < 0 || min > s.options.length) fail(`${where}.min_values must be 0 to the number of options`);
  if (!Number.isInteger(max) || max < 1 || max > s.options.length || max < min) fail(`${where}.max_values must be from min_values (and at least 1) to the number of options`);
  s.min_values = min;
  s.max_values = max;
  if (raw.disabled === true) s.disabled = true;
  return s;
}

function cleanComponents(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('components must be an array of action rows');
  if (raw.length > LIMITS.rows) fail(`A message can have up to ${LIMITS.rows} action rows`);
  const seen = new Set();
  return raw.map((row, i) => {
    const at = `components[${i}]`;
    if (!row || row.type !== 1 || !Array.isArray(row.components) || !row.components.length) {
      fail(`${at} must be an action row: { "type": 1, "components": [...] }`);
    }
    const kinds = row.components.map(c => c && c.type);
    if (kinds.includes(SELECT)) {
      if (row.components.length !== 1) fail(`${at} holds a dropdown, so it cannot hold anything else`);
      return { type: 1, components: [cleanSelect(row.components[0], `${at}.components[0]`, seen)] };
    }
    if (row.components.length > LIMITS.buttons) fail(`${at} has more than ${LIMITS.buttons} buttons`);
    return {
      type: 1,
      components: row.components.map((c, j) => {
        const where = `${at}.components[${j}]`;
        if (!c || c.type !== BUTTON) fail(`${where} has an unsupported type; use 2 (button) or 3 (dropdown)`);
        return cleanButton(c, where, seen);
      }),
    };
  });
}

// Checks what a bot sent. Returns { embeds, components } (each possibly
// empty, and null for a field the body left out, so an edit can tell "leave
// it" from "clear it"), or { error } with a message for the bot.
function clean(body) {
  try {
    return {
      embeds: body && 'embeds' in body ? cleanEmbeds(body.embeds) : null,
      components: body && 'components' in body ? cleanComponents(body.components) : null,
    };
  } catch (err) {
    if (err instanceof PartsError) return { error: err.message };
    throw err;
  }
}

// Saves the parts for a message; with neither, the row goes.
function record(db, messageId, { embeds, components }) {
  const e = embeds && embeds.length ? JSON.stringify(embeds) : null;
  const c = components && components.length ? JSON.stringify(components) : null;
  if (!e && !c) {
    db.prepare('DELETE FROM message_bot_parts WHERE message_id = ?').run(messageId);
    return;
  }
  db.prepare(`
    INSERT INTO message_bot_parts (message_id, embeds, components) VALUES (?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET embeds = excluded.embeds, components = excluded.components
  `).run(messageId, e, c);
}

function parse(row) {
  const out = {};
  try { if (row.embeds) out.embeds = JSON.parse(row.embeds); } catch { /* a damaged row shows no embeds */ }
  try { if (row.components) out.components = JSON.parse(row.components); } catch { /* nor buttons */ }
  return out;
}

// Each message id with its { embeds, components }.
function lookup(db, messageIds) {
  const out = new Map();
  if (!messageIds || !messageIds.length) return out;
  const ph = messageIds.map(() => '?').join(',');
  db.prepare(`SELECT message_id, embeds, components FROM message_bot_parts WHERE message_id IN (${ph})`)
    .all(...messageIds).forEach(r => out.set(r.message_id, parse(r)));
  return out;
}

function get(db, messageId) {
  const row = db.prepare('SELECT embeds, components FROM message_bot_parts WHERE message_id = ?').get(messageId);
  return row ? parse(row) : {};
}

// The button or dropdown with this custom_id, or null.
function findComponent(components, id) {
  for (const row of components || []) {
    for (const c of row.components || []) if (c.custom_id === id) return c;
  }
  return null;
}

// What a click or pick may send: a dropdown's picks must be its own values,
// as many as it allows. Returns { values } (empty for a button) or { error }.
function checkValues(component, raw) {
  if (component.type === BUTTON) return { values: [] };
  if (!Array.isArray(raw)) return { error: 'Pick from the list' };
  const allowed = new Set(component.options.map(o => o.value));
  const values = [...new Set(raw.filter(v => typeof v === 'string'))];
  if (values.length !== raw.length || values.some(v => !allowed.has(v))) return { error: 'That choice is not on the list' };
  if (values.length < component.min_values || values.length > component.max_values) return { error: 'Pick a different number of options' };
  return { values };
}

// What a person may type into a bot's text box: letters, marks, numbers,
// punctuation, symbols and spaces in any language, and whole emoji. Kept
// out is whatever could hide or reorder what the text says: control
// characters, direction overrides, zero-width spaces, invisible tag
// characters outside a flag, private use and unassigned code points, and
// Zalgo. Persian, Arabic and Indic writing needs the joiners and direction
// marks (U+200C to U+200F, U+061C), so those stay.
const TYPED_EMOJI = /\p{RGI_Emoji}/gv;
const TYPED_ALLOWED = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}‌-‏؜]*$/u;
// Some invisible characters count as letters or marks: Hangul fillers,
// variation selectors past the two emoji use, the grapheme joiner.
const TYPED_INVISIBLE = /[\p{Default_Ignorable_Code_Point}--[‌-‏؜︎️]]/v;
// As for display names: past three marks on one letter it is Zalgo.
const TYPED_MARK_RUN = /\p{M}{4,}/u;

// The text with its line breaks made \n, or { error } for the person.
function typed(raw, multiline) {
  const value = raw.replace(/\r\n?/g, '\n').normalize('NFC');
  // An emoji becomes a space, so marks either side of one never add up.
  let rest = value.replace(TYPED_EMOJI, ' ');
  if (multiline) rest = rest.replace(/[\n\t]/g, ' ');
  else if (/[\n\t]/.test(rest)) return { error: 'This box takes one line' };
  if (!TYPED_ALLOWED.test(rest) || TYPED_INVISIBLE.test(rest)) {
    return { error: 'This has an invisible or unsupported character. Try typing it instead of pasting it.' };
  }
  if (TYPED_MARK_RUN.test(rest)) return { error: 'Too many accent marks on one letter' };
  return { value };
}

function cleanTextInput(raw, where, seen, ceiling) {
  if (!raw || raw.type !== TEXT_INPUT) fail(`${where} must be a text input (type 4)`);
  const style = raw.style === undefined ? SHORT : raw.style;
  if (style !== SHORT && style !== PARAGRAPH) fail(`${where}.style must be 1 (one line) or 2 (paragraph)`);
  const input = { type: TEXT_INPUT, custom_id: customId(raw.custom_id, where, seen), style };
  input.label = text(raw.label, LIMITS.inputLabel, `${where}.label`);
  if (!input.label) fail(`${where}.label is required`);
  const placeholder = text(raw.placeholder, LIMITS.inputPlaceholder, `${where}.placeholder`);
  if (placeholder) input.placeholder = placeholder;
  const min = raw.min_length === undefined || raw.min_length === null ? 0 : raw.min_length;
  const max = raw.max_length === undefined || raw.max_length === null ? LIMITS.inputValue : raw.max_length;
  if (!Number.isInteger(min) || min < 0 || min > LIMITS.inputValue) fail(`${where}.min_length must be 0 to ${LIMITS.inputValue}`);
  if (!Number.isInteger(max) || max < 1 || max > LIMITS.inputValue || max < min) {
    fail(`${where}.max_length must be from min_length (and at least 1) to ${LIMITS.inputValue}`);
  }
  // A Discord bot may ask for more than this server's messages hold; it
  // gets the server's limit rather than a refusal.
  input.max_length = Math.min(max, ceiling);
  input.min_length = Math.min(min, input.max_length);
  input.required = raw.required !== false;
  if (raw.value !== undefined && raw.value !== null && raw.value !== '') {
    if (typeof raw.value !== 'string') fail(`${where}.value must be a string`);
    const pre = typed(raw.value, style === PARAGRAPH);
    if (pre.error) fail(`${where}.value: ${pre.error}`);
    if (pre.value.length > input.max_length) fail(`${where}.value is longer than ${input.max_length} characters`);
    input.value = pre.value;
  }
  return input;
}

// A form a bot opens in answer to a click: Discord's modal, a title and up
// to 5 action rows of one text box each. maxChars is this server's message
// limit, so a box never takes more than the bot could post back.
// Returns { custom_id, title, components } or { error } for the bot.
function cleanModal(raw, maxChars) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('The modal must be an object');
    const id = customId(raw.custom_id, 'modal', new Set());
    const title = text(raw.title, LIMITS.modalTitle, 'modal.title');
    if (!title) fail('modal.title is required');
    const rows = raw.components;
    if (!Array.isArray(rows) || !rows.length || rows.length > LIMITS.inputs) fail(`modal.components needs 1 to ${LIMITS.inputs} action rows`);
    const ceiling = Math.min(maxChars, LIMITS.inputValue);
    const seen = new Set();
    const components = rows.map((r, i) => {
      const at = `modal.components[${i}]`;
      if (!r || r.type !== 1 || !Array.isArray(r.components) || r.components.length !== 1) fail(`${at} must be an action row holding one text input`);
      return { type: 1, components: [cleanTextInput(r.components[0], `${at}.components[0]`, seen, ceiling)] };
    });
    return { custom_id: id, title, components };
  } catch (err) {
    if (err instanceof PartsError) return { error: err.message };
    throw err;
  }
}

// What a person sent back from a form: one string for each of its boxes and
// nothing else, each passing its box's rules. Returns { fields }, as
// [{ custom_id, value }] in the form's order, or { error } for the person.
function checkModalSubmit(modal, raw) {
  const inputs = modal.components.map(r => r.components[0]);
  if (!Array.isArray(raw) || raw.length > inputs.length) return { error: 'Invalid request' };
  const given = new Map();
  for (const f of raw) {
    if (!f || typeof f.custom_id !== 'string' || typeof f.value !== 'string' || given.has(f.custom_id)) return { error: 'Invalid request' };
    given.set(f.custom_id, f.value);
  }
  const fields = [];
  for (const input of inputs) {
    const got = typed(given.get(input.custom_id) || '', input.style === PARAGRAPH);
    given.delete(input.custom_id);
    if (got.error) return { error: `${input.label}: ${got.error}` };
    const n = got.value.length;
    if (!got.value.trim()) {
      if (input.required) return { error: `${input.label} is required` };
    } else if (n < input.min_length) {
      return { error: `${input.label} needs at least ${input.min_length} characters` };
    }
    if (n > input.max_length) return { error: `${input.label} takes up to ${input.max_length} characters` };
    fields.push({ custom_id: input.custom_id, value: got.value });
  }
  if (given.size) return { error: 'Invalid request' };
  return { fields };
}

// A line to show in a push when a message is only an embed.
function summary(embeds) {
  const e = (embeds || [])[0];
  return e ? (e.title || e.description || e.author?.name || e.footer?.text || '').slice(0, 200) : '';
}

// Every word and link a member would see, one per line, for AutoMod: a bot
// account's embeds and buttons are held to the same rules as its text.
function plainText({ embeds, components } = {}) {
  const out = [];
  for (const e of embeds || []) {
    out.push(e.title, e.description, e.url, e.author?.name, e.author?.url, e.footer?.text);
    for (const f of e.fields || []) out.push(f.name, f.value);
  }
  for (const row of components || []) {
    for (const c of row.components || []) {
      out.push(c.label, c.url, c.placeholder, c.value);
      for (const o of c.options || []) out.push(o.label, o.description);
    }
  }
  return out.filter(Boolean).join('\n');
}

module.exports = { plainText, ensureTable, clean, record, lookup, get, findComponent, checkValues, cleanModal, checkModalSubmit, summary, LIMITS, BUTTON, SELECT };
