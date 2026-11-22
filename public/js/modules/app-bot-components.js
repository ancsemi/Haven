// Embeds, buttons and dropdowns on bot messages (src/botComponents.js). The
// server checked every field, in Discord's shapes, before it got here; text
// is still escaped and links and pictures still go through the usual guards.
//
// A click or a pick goes to the server, which hands it to the bot. The bot
// answers on its own: a private reply, a new message, or an edit that swaps
// these parts, which arrives as message bot parts.

const BUTTON = 2;
const SELECT = 3;
const LINK = 5;

export default {

_setupBotComponents() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.bot-parts .bot-btn[data-custom-id]');
    if (btn) {
      e.stopPropagation();
      this._sendBotInteraction(btn, btn.dataset.customId);
      return;
    }
    const opt = e.target.closest('.bot-select-option[data-value]');
    if (opt) {
      const sel = opt.closest('.bot-select');
      if (sel.dataset.multi === '1') return; // the checkbox does the work; Done sends
      e.preventDefault();
      sel.open = false;
      this._sendBotInteraction(sel, sel.dataset.customId, [opt.dataset.value], opt.dataset.label);
      return;
    }
    const done = e.target.closest('.bot-select-done');
    if (done) {
      const sel = done.closest('.bot-select');
      const picked = [...sel.querySelectorAll('input:checked')].map(i => i.closest('.bot-select-option'));
      sel.open = false;
      this._sendBotInteraction(sel, sel.dataset.customId, picked.map(o => o.dataset.value), picked.map(o => o.dataset.label).join(', '));
      return;
    }
    // A click anywhere else closes an open dropdown, as a menu would.
    document.querySelectorAll('.bot-select[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; });
  });
  document.addEventListener('change', (e) => {
    const box = e.target.closest('.bot-select input[type="checkbox"]');
    if (box) this._botSelectCount(box.closest('.bot-select'));
  });

  this.socket.on('message-bot-parts', (data) => {
    if (!data || data.channelCode !== this.currentChannel) return;
    const html = this._botPartsHtml({ id: data.messageId, embeds: data.embeds, components: data.components });
    document.querySelectorAll(`[data-msg-id="${Number(data.messageId)}"]`).forEach(el => {
      const old = el.querySelector('.bot-parts');
      if (old) {
        if (html) old.outerHTML = html; else old.remove();
        return;
      }
      el.querySelector('.message-content, .thread-msg-content')?.insertAdjacentHTML('afterend', html);
    });
  });
},

_sendBotInteraction(el, customId, values, pickedLabel) {
  const host = el.closest('.bot-parts');
  const messageId = parseInt(host?.dataset.botMsg, 10);
  if (!messageId || !customId || el.classList.contains('busy')) return;
  el.classList.add('busy');
  const summary = el.matches('.bot-select') ? el.querySelector('.bot-select-label') : null;
  if (summary && pickedLabel) summary.textContent = pickedLabel;
  const payload = { messageId, customId };
  if (values) payload.values = values;
  this.socket.emit('bot-interaction', payload, (res) => {
    el.classList.remove('busy');
    // Like Discord, a dropdown goes back to how the bot set it; the bot
    // shows a lasting choice by editing the message.
    if (summary) summary.textContent = el.dataset.placeholder;
    if (res?.error) this._showToast(res.error, 'error');
  });
},

_botSelectCount(sel) {
  const n = sel.querySelectorAll('input:checked').length;
  const done = sel.querySelector('.bot-select-done');
  if (done) done.disabled = n < Number(sel.dataset.min) || n > Number(sel.dataset.max);
  sel.querySelectorAll('input:not(:checked)').forEach(i => { i.disabled = n >= Number(sel.dataset.max); });
},

_botPartsHtml(msg) {
  const embeds = Array.isArray(msg.embeds) ? msg.embeds : [];
  const rows = Array.isArray(msg.components) ? msg.components : [];
  if (!embeds.length && !rows.length) return '';
  return `<div class="bot-parts" data-bot-msg="${Number(msg.id)}">${embeds.map(e => this._botEmbedHtml(e)).join('')}${rows.map(r => this._botRowHtml(r)).join('')}</div>`;
},

_botLinkHtml(url, inner, cls = '') {
  if (!/^https?:\/\//i.test(url || '')) return inner;
  return `<a${cls ? ` class="${cls}"` : ''} href="${this._escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${inner}</a>`;
},

_botImgHtml(url, cls) {
  const src = this._botAvatarSrcAttr(url);
  return src ? `<img class="${cls}" ${src} alt="" loading="lazy">` : '';
},

_botEmbedHtml(e) {
  const esc = (s) => this._escapeHtml(s || '');
  const color = Number.isInteger(e.color) ? '#' + e.color.toString(16).padStart(6, '0') : '';
  const author = e.author ? `<div class="bot-embed-author">${e.author.icon_url ? this._botImgHtml(e.author.icon_url, 'bot-embed-author-icon') : ''}${this._botLinkHtml(e.author.url, esc(e.author.name))}</div>` : '';
  const title = e.title ? `<div class="bot-embed-title">${this._botLinkHtml(e.url, esc(e.title))}</div>` : '';
  const desc = e.description ? `<div class="bot-embed-desc">${this._formatContent(e.description)}</div>` : '';
  const fields = (e.fields || []).length
    ? `<div class="bot-embed-fields">${e.fields.map(f => `<div class="bot-embed-field${f.inline ? ' inline' : ''}"><div class="bot-embed-field-name">${esc(f.name)}</div><div class="bot-embed-field-value">${this._formatContent(f.value)}</div></div>`).join('')}</div>`
    : '';
  const image = e.image ? this._botImgHtml(e.image.url, 'bot-embed-image') : '';
  const footerBits = [e.footer ? esc(e.footer.text) : '', e.timestamp ? esc(this._fmtDateTime(e.timestamp)) : ''].filter(Boolean).join(' • ');
  const footer = footerBits ? `<div class="bot-embed-footer">${e.footer?.icon_url ? this._botImgHtml(e.footer.icon_url, 'bot-embed-footer-icon') : ''}<span>${footerBits}</span></div>` : '';
  const thumb = e.thumbnail ? this._botImgHtml(e.thumbnail.url, 'bot-embed-thumb') : '';
  return `<div class="bot-embed"${color ? ` style="--embed-c:${color}"` : ''}><div class="bot-embed-main">${author}${title}${desc}${fields}${image}${footer}</div>${thumb}</div>`;
},

_botRowHtml(row) {
  const items = Array.isArray(row?.components) ? row.components : [];
  return `<div class="bot-row">${items.map(c => c.type === SELECT ? this._botSelectHtml(c) : c.type === BUTTON ? this._botButtonHtml(c) : '').join('')}</div>`;
},

_botButtonHtml(b) {
  const style = [1, 2, 3, 4, 5].includes(b.style) ? b.style : 2;
  const inner = `${b.emoji?.name ? `<span class="bot-btn-emoji">${this._emojiGlyphHtml(b.emoji.name, 18)}</span>` : ''}${b.label ? `<span>${this._escapeHtml(b.label)}</span>` : ''}`;
  if (style === LINK) {
    if (b.disabled || !/^https?:\/\//i.test(b.url || '')) return `<span class="bot-btn bot-btn-s5 disabled">${inner}</span>`;
    return `<a class="bot-btn bot-btn-s5" href="${this._escapeHtml(b.url)}" target="_blank" rel="noopener noreferrer nofollow" title="${this._escapeHtml(t('bot_parts.external_link', { url: b.url }))}">${inner}<span class="bot-btn-ext" aria-hidden="true">↗</span></a>`;
  }
  return `<button type="button" class="bot-btn bot-btn-s${style}" data-custom-id="${this._escapeHtml(b.custom_id)}"${b.disabled ? ' disabled' : ''}>${inner}</button>`;
},

_botSelectHtml(s) {
  const opts = Array.isArray(s.options) ? s.options : [];
  const min = Number.isInteger(s.min_values) ? s.min_values : 1;
  const max = Number.isInteger(s.max_values) ? s.max_values : 1;
  const multi = max > 1 || min === 0;
  const defaults = opts.filter(o => o.default);
  const placeholder = defaults.length ? defaults.map(o => o.label).join(', ') : (s.placeholder || t('bot_parts.select_placeholder'));
  const esc = (v) => this._escapeHtml(v || '');
  const optHtml = opts.map(o => {
    const em = o.emoji?.name ? `<span class="bot-select-emoji">${this._emojiGlyphHtml(o.emoji.name, 18)}</span>` : '';
    const text = `<span class="bot-select-text"><span>${esc(o.label)}</span>${o.description ? `<small>${esc(o.description)}</small>` : ''}</span>`;
    return multi
      ? `<label class="bot-select-option" data-value="${esc(o.value)}" data-label="${esc(o.label)}"><input type="checkbox" value="${esc(o.value)}"${o.default ? ' checked' : ''}>${em}${text}</label>`
      : `<button type="button" class="bot-select-option" data-value="${esc(o.value)}" data-label="${esc(o.label)}">${em}${text}</button>`;
  }).join('');
  const foot = multi
    ? `<div class="bot-select-foot"><small>${esc(t('bot_parts.select_count', { min, max }))}</small><button type="button" class="bot-select-done"${defaults.length < min ? ' disabled' : ''}>${esc(t('bot_parts.select_done'))}</button></div>`
    : '';
  if (s.disabled) return `<div class="bot-select disabled"><div class="bot-select-summary"><span class="bot-select-label">${esc(placeholder)}</span></div></div>`;
  return `<details class="bot-select" data-custom-id="${esc(s.custom_id)}" data-placeholder="${esc(placeholder)}" data-min="${min}" data-max="${max}"${multi ? ' data-multi="1"' : ''}>
    <summary class="bot-select-summary"><span class="bot-select-label">${esc(placeholder)}</span><span class="bot-select-caret" aria-hidden="true">▾</span></summary>
    <div class="bot-select-menu">${optHtml}${foot}</div>
  </details>`;
},
};
