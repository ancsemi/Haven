// Blocked names (Settings, Admin, Who can sign up): words no username or
// display name may contain. The rules live in src/blockedNames.js; this is
// the admin's list, plus the members whose names already match it.

export default {
  _setupBlockedNames() {
    const save = document.getElementById('blocked-names-save');
    if (!save) return;
    save.addEventListener('click', () => {
      save.disabled = true;
      this._sendBlockedNames(() => { save.disabled = false; });
    });
  },

  _sendBlockedNames(done) {
    const input = document.getElementById('blocked-names-input');
    this.socket.emit('set-blocked-names', { words: input.value }, (res) => {
      done?.();
      if (!res || res.error) return this._showToast(res?.error || t('settings.admin.blocked_names_failed'), 'error');
      this._showBlockedNames(res);
      this._showToast(t('settings.admin.blocked_names_saved'), 'success');
    });
  },

  // The settings window's own Save button saves the list too, when it was
  // edited and not saved with the button beside it.
  _saveBlockedNamesIfChanged() {
    const input = document.getElementById('blocked-names-input');
    if (!input || !this.user?.isAdmin || input.value === (this._blockedNamesSaved ?? '')) return false;
    this._sendBlockedNames();
    return true;
  },

  // Called when the admin settings are filled in. Only the admin sees it.
  _loadBlockedNames() {
    const panel = document.getElementById('blocked-names-panel');
    if (!panel) return;
    panel.style.display = this.user?.isAdmin ? '' : 'none';
    if (!this.user?.isAdmin) return;
    this.socket.emit('get-blocked-names', (res) => {
      if (!res || res.error) return;
      this._showBlockedNames(res);
    });
  },

  _showBlockedNames({ words, matches }) {
    const input = document.getElementById('blocked-names-input');
    this._blockedNamesSaved = (words || []).join('\n');
    if (input && document.activeElement !== input) input.value = this._blockedNamesSaved;
    const box = document.getElementById('blocked-names-matches');
    if (!box) return;
    if (!matches || !matches.length) { box.textContent = ''; return; }
    const names = matches.map(m => m.displayName === m.username
      ? this._escapeHtml(m.username)
      : `${this._escapeHtml(m.displayName)} <span class="muted-text">(@${this._escapeHtml(m.username)})</span>`);
    box.innerHTML = `${this._escapeHtml(t('settings.admin.blocked_names_matches', { count: matches.length }))}<br>${names.join(', ')}`;
  },
};
