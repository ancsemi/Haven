// "Merge into..." on a channel's menu (admin only): pick the channel it merges
// into, read what the merge will do, untick any re-post that should stay, and
// merge. For the duplicates a Ferry import leaves next to channels copied by
// hand. The server plans the merge again when it runs (src/mergeChannels.js),
// so this page only shows and picks.

export default {

_initChannelMerge() {
  document.querySelector('[data-action="merge-channel"]')?.addEventListener('click', () => {
    const code = this._ctxMenuChannel;
    if (!code) return;
    this._closeChannelCtxMenu();
    this._openMergeModal(code);
  });
  const modal = document.getElementById('merge-channel-modal');
  const close = () => { if (modal) modal.style.display = 'none'; this._mergeFrom = null; };
  document.getElementById('merge-channel-cancel')?.addEventListener('click', close);
  modal?.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.getElementById('merge-channel-back')?.addEventListener('click', () => this._openMergeModal(this._mergeFrom));
  document.getElementById('merge-channel-go')?.addEventListener('click', () => this._runMerge());

  // Everyone in a channel that was merged away is taken to the one it went
  // into, and their sidebar loses it.
  this.socket.on('channel-merged', (data) => {
    if (!data || !data.code) return;
    const here = this.currentChannel === data.code;
    this._removeChannelLocally(data.code);
    if (this.voice && this.voice.inVoice && this.voice.currentChannel === data.code) this._leaveVoice();
    if (here && data.into) {
      this.switchChannel(data.into);
      this._showToast(t('modals.merge_channel.merged_away', { name: data.name || '' }), 'info');
    }
  });
},

// Channels this one can merge into: the same kind, and not a DM. The server
// checks again, with what this page cannot see (sub-channels, protection).
_mergeTargets(ch) {
  return this.channels
    .filter(c => c.code !== ch.code && !c.is_dm && !!c.is_forum === !!ch.is_forum
      && !!c.forum_blog === !!ch.forum_blog && c.text_enabled !== 0)
    .sort((a, b) => a.name.localeCompare(b.name));
},

_openMergeModal(code) {
  const ch = this.channels.find(c => c.code === code);
  if (!ch) return;
  this._mergeFrom = code;
  this._mergeTo = null;
  this._mergePreview = null;
  document.getElementById('merge-channel-desc').textContent = t('modals.merge_channel.desc', { name: ch.name });
  document.getElementById('merge-channel-preview').style.display = 'none';
  document.getElementById('merge-channel-back').style.display = 'none';
  document.getElementById('merge-channel-go').style.display = 'none';

  const list = document.getElementById('merge-channel-targets');
  list.style.display = '';
  const targets = this._mergeTargets(ch);
  list.innerHTML = targets.length
    ? targets.map(c => {
      const parent = c.parent_channel_id ? this.channels.find(p => p.id === c.parent_channel_id) : null;
      const where = parent ? ` <span class="merge-channel-dim">${this._escapeHtml(parent.name)} ›</span>` : '';
      return `<div class="organize-item" data-target="${c.code}"><span class="merge-channel-dim">#</span><span style="flex:1">${where} ${this._escapeHtml(c.name)}</span></div>`;
    }).join('')
    : `<p class="merge-channel-empty">${t('modals.merge_channel.no_targets')}</p>`;
  list.querySelectorAll('[data-target]').forEach(el => {
    el.addEventListener('click', () => this._showMergePreview(el.dataset.target));
  });
  document.getElementById('merge-channel-modal').style.display = 'flex';
},

_showMergePreview(toCode) {
  const from = this.channels.find(c => c.code === this._mergeFrom);
  const to = this.channels.find(c => c.code === toCode);
  if (!from || !to) return;
  this._mergeTo = toCode;
  const box = document.getElementById('merge-channel-preview');
  document.getElementById('merge-channel-targets').style.display = 'none';
  document.getElementById('merge-channel-back').style.display = '';
  box.style.display = '';
  box.innerHTML = `<p class="merge-channel-empty">${t('modals.merge_channel.loading')}</p>`;

  this.socket.emit('merge-channels-preview', { fromCode: from.code, toCode: to.code }, (p) => {
    if (this._mergeTo !== toCode) return;
    if (!p || p.error) {
      box.innerHTML = `<p class="merge-channel-empty">${this._escapeHtml(p?.error || t('modals.merge_channel.failed'))}</p>`;
      return;
    }
    this._mergePreview = p;
    const c = p.counts;
    const esc = (s) => this._escapeHtml(String(s ?? ''));
    let html = `<p><strong>${esc(t(c.messages === 1 ? 'modals.merge_channel.summary_one' : 'modals.merge_channel.summary_many', { n: c.messages, from: from.name, to: to.name }))}</strong></p>`;
    if (c.duplicates) html += `<p>${esc(t(c.duplicates === 1 ? 'modals.merge_channel.duplicates_one' : 'modals.merge_channel.duplicates_many', { n: c.duplicates }))}</p>`;
    if (c.webhooks || c.scheduled || c.roleMenus || c.ferryLinks) {
      html += `<p class="merge-channel-dim">${esc(t('modals.merge_channel.carried', { webhooks: c.webhooks, scheduled: c.scheduled, menus: c.roleMenus, links: c.ferryLinks }))}</p>`;
    }
    if (p.repostCount) {
      html += `<h4>${esc(t('modals.merge_channel.reposts_title', { n: p.repostCount }))}</h4>
        <p class="merge-channel-dim">${esc(t('modals.merge_channel.reposts_desc'))}</p>
        <div class="merge-channel-ticks">
          <button class="btn-sm" type="button" data-tick="all">${esc(t('modals.merge_channel.select_all'))}</button>
          <button class="btn-sm" type="button" data-tick="none">${esc(t('modals.merge_channel.select_none'))}</button>
        </div>`;
      const when = (at) => { try { return this._fmtDateTime(new Date(at.endsWith('Z') ? at : at.replace(' ', 'T') + 'Z')); } catch { return at; } };
      const chName = (side) => '#' + (side.inSource ? from.name : to.name);
      html += p.reposts.map(r => `
        <label class="merge-repost">
          <input type="checkbox" value="${r.drop.id}" checked>
          <span class="merge-repost-body">
            <span class="merge-repost-text">${esc(r.drop.content)}</span>
            <span class="merge-channel-dim">${esc(t('modals.merge_channel.repost_drop'))}: ${esc(r.drop.author)} · ${esc(when(r.drop.at))} · ${esc(chName(r.drop))}</span>
            <span class="merge-channel-dim">${esc(t('modals.merge_channel.repost_keep'))}: ${esc(r.keep.author)} · ${esc(when(r.keep.at))} · ${esc(chName(r.keep))}</span>
          </span>
        </label>`).join('');
      if (p.repostCount > p.reposts.length) {
        html += `<p class="merge-channel-dim">${esc(t('modals.merge_channel.reposts_more', { shown: p.reposts.length, n: p.repostCount }))}</p>`;
      }
    }
    box.innerHTML = html;
    box.querySelectorAll('[data-tick]').forEach(btn => btn.addEventListener('click', () => {
      const on = btn.dataset.tick === 'all';
      box.querySelectorAll('.merge-repost input').forEach(cb => { cb.checked = on; });
    }));
    document.getElementById('merge-channel-go').style.display = '';
  });
},

async _runMerge() {
  const from = this.channels.find(c => c.code === this._mergeFrom);
  const to = this.channels.find(c => c.code === this._mergeTo);
  if (!from || !to || !this._mergePreview) return;
  const ok = await this._showConfirmModal(
    '⚠️ ' + t('modals.merge_channel.title'),
    t('modals.merge_channel.confirm', { from: from.name, to: to.name }),
    { danger: true, confirmLabel: t('modals.merge_channel.merge_btn') }
  );
  if (!ok) return;
  const dropReposts = [...document.querySelectorAll('#merge-channel-preview .merge-repost input:checked')].map(cb => Number(cb.value));
  const go = document.getElementById('merge-channel-go');
  go.disabled = true;
  this.socket.emit('merge-channels', { fromCode: from.code, toCode: to.code, dropReposts }, (r) => {
    go.disabled = false;
    if (!r || r.error) {
      this._showToast(r?.error || t('modals.merge_channel.failed'), 'error');
      return;
    }
    document.getElementById('merge-channel-modal').style.display = 'none';
    this._mergeFrom = null;
    this._showToast(t('modals.merge_channel.done', { name: to.name, moved: r.moved, dupes: r.duplicates + r.reposts }), 'success');
    if (this.currentChannel === from.code) this.switchChannel(to.code);
  });
},

};
