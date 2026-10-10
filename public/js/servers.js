// ═══════════════════════════════════════════════════════════
// Haven: Multi-Server Manager
// See other Haven servers in your sidebar with live status
// ═══════════════════════════════════════════════════════════

class ServerManager {
  constructor() {
    this.servers = this._load();
    this.statusCache = new Map();
    this.checkInterval = null;
    this.selfFingerprint = null;
    // Servers the Desktop app says the user removed, on any server. Filled
    // from the Desktop app's shared list; always empty in a browser.
    this.desktopRemoved = new Set();
    // Servers in the Desktop app's shared list, as last read.
    this.desktopListed = new Set();
    this.selfFingerprintReady = this._fetchSelfFingerprint();
    // Desktop bootstrap: pull the cross-server history from the Electron
    // main process synchronously (preload exposes it as a plain array).
    // This means the sidebar shows the user's known network IMMEDIATELY
    // on first-join to a new server, instead of waiting for an async sync.
    this.bootstrappedFromDesktop = this._mergeDesktopBootstrap();
  }

  _desktop() {
    return (typeof window !== 'undefined' && window.havenDesktop) || null;
  }

  /** True in a Desktop app that asks the user itself, in its own dialog,
   *  before a server page adds, removes or renames a server. This page then
   *  does not ask a second time, and hands the app no automatic changes
   *  (the app would only ask about them, or refuse them). */
  desktopGated() {
    const desktop = this._desktop();
    return !!(desktop && desktop.serverListGated === true);
  }

  /** True when the Desktop app asks the user before this server is removed
   *  or renamed (it is in the app's list), so the page's own question is
   *  skipped. */
  desktopAsksFor(url) {
    return this.desktopGated() && this.desktopListed.has(this._normalizeUrl(url));
  }

  /** Merge the Desktop app's cross-server history into the local list.
   *  Returns true if any new servers were added. Removed-server tracking
   *  is honored so the user doesn't see servers they intentionally deleted. */
  _mergeDesktopBootstrap() {
    const desktop = this._desktop();
    // Newer Desktop versions keep one shared list (removals, order, names).
    const shared = desktop && desktop.initialServerList;
    if (shared && Array.isArray(shared.servers)) {
      try { return this.applyDesktopList(shared).added > 0; }
      catch (err) {
        console.warn('[Servers] could not apply the Desktop server list', err);
        return false;
      }
    }
    try {
      const history = (desktop && Array.isArray(desktop.initialServerHistory))
        ? desktop.initialServerHistory
        : null;
      if (!history || !history.length) return false;
      const removed = this._loadRemoved();
      const have = new Set(this.servers.map(s => this._normalizeUrl(s.url)));
      let added = false;
      for (const h of history) {
        if (!h || !h.url) continue;
        const url = this._normalizeUrl(h.url);
        if (!url || have.has(url) || removed.has(url) || removed.has(h.url)) continue;
        this.servers.push({
          name: h.name || url,
          url,
          icon: h.icon || null,
          iconData: h.iconData || null,
          addedAt: h.lastConnected || Date.now(),
        });
        have.add(url);
        added = true;
      }
      if (added) this._save();
      return added;
    } catch (err) {
      console.warn('[Servers] could not read the Desktop server history', err);
      return false;
    }
  }

  // ── Desktop shared list ──────────────────────────────
  // Each server keeps this list in its own browser storage, so without the
  // Desktop app's shared copy the lists drift apart per server. With it, the
  // Desktop list decides: removals, the order, and names the user chose.

  /** True once this page has handed its own removals to the Desktop list;
   *  from then on the Desktop list wins over this page's removed set. */
  _trustsDesktop() {
    try { return localStorage.getItem('haven_servers_desktop_list') === '1'; }
    catch { return false; } // storage blocked: keep this page's own removals
  }

  _isUrlName(entry) {
    const name = String(entry && entry.name || '').trim();
    return !name || name === entry.url || this._normalizeUrl(name) === this._normalizeUrl(entry.url);
  }

  /** Bring this page's list in line with the Desktop app's shared list
   *  ({ servers, removed, order, hasOrder }). Returns counts of what changed. */
  applyDesktopList(list) {
    const stats = { added: 0, removed: 0, renamed: 0 };
    if (!list || !Array.isArray(list.servers)) return stats;
    const gone = new Set((Array.isArray(list.removed) ? list.removed : []).map(u => this._normalizeUrl(u)).filter(Boolean));
    this.desktopRemoved = gone;
    this.desktopListed = new Set(list.servers.map(ds => this._normalizeUrl(ds && ds.url)).filter(Boolean));
    const trusted = this._trustsDesktop();
    const localRemoved = this._loadRemoved();
    let removedChanged = false;
    let changed = false;

    // Removed on any server: removed here too.
    const kept = [];
    for (const s of this.servers) {
      const url = this._normalizeUrl(s.url);
      if (!gone.has(url)) { kept.push(s); continue; }
      stats.removed++;
      this.statusCache.delete(url);
      if (!localRemoved.has(url)) { localRemoved.add(url); removedChanged = true; }
    }
    if (kept.length !== this.servers.length) { this.servers = kept; changed = true; }

    // Known to the app but not to this page, and newer edits from elsewhere.
    const byUrl = new Map(this.servers.map(s => [this._normalizeUrl(s.url), s]));
    for (const ds of list.servers) {
      const url = this._normalizeUrl(ds && ds.url);
      if (!url || gone.has(url)) continue;
      const local = byUrl.get(url);
      if (local) {
        const edit = this._adoptDesktopEdit(local, ds);
        if (edit.changed) changed = true;
        if (edit.renamed) stats.renamed++;
        continue;
      }
      if (localRemoved.has(url)) {
        // Until this page has handed its removals over, they still count.
        if (!trusted) continue;
        localRemoved.delete(url);
        removedChanged = true;
      }
      const entry = {
        name: ds.name || url,
        url,
        icon: ds.customIcon && ds.icon ? ds.icon : null,
        addedAt: ds.lastConnected || Date.now(),
      };
      if (ds.customName) entry.customName = true;
      if (ds.customIcon && ds.icon) entry.customIcon = true;
      if (ds.editedAt) entry.editedAt = Number(ds.editedAt) || 0;
      this.servers.push(entry);
      byUrl.set(url, entry);
      stats.added++;
      changed = true;
    }

    if (list.hasOrder && Array.isArray(list.order) && this._applyOrder(list.order)) changed = true;
    if (removedChanged) this._saveRemoved(localRemoved);
    if (changed) this._save();
    return stats;
  }

  /** The newer user edit of a name or icon wins. Without any user edit, a
   *  real name from the app replaces a bare address. */
  _adoptDesktopEdit(local, ds) {
    const theirs = Number(ds.editedAt) || 0;
    const mine = Number(local.editedAt) || 0;
    const before = local.name;
    let changed = false;
    if (theirs > mine) {
      if (ds.name) local.name = ds.name;
      if (ds.customName) local.customName = true;
      else delete local.customName;
      if (ds.customIcon && ds.icon) {
        if (local.icon !== ds.icon) { local.icon = ds.icon; local.iconData = null; }
        local.customIcon = true;
      } else if (local.customIcon) {
        delete local.customIcon;
        local.icon = null;
        local.iconData = null;
      }
      local.editedAt = theirs;
      changed = true;
    } else if (theirs === mine && !local.customName && !ds.customName && ds.name
        && this._isUrlName(local) && !this._isUrlName(ds)) {
      local.name = ds.name;
      changed = true;
    }
    return { changed, renamed: local.name !== before };
  }

  /** Sort by a list of addresses; servers it does not list go last, in the
   *  order they had. Returns true when the order changed. */
  _applyOrder(order) {
    const rank = new Map();
    order.forEach((u, i) => { const n = this._normalizeUrl(u); if (n && !rank.has(n)) rank.set(n, i); });
    const before = this.servers.map(s => s.url).join('\n');
    const indexed = this.servers.map((s, i) => ({ s, i, r: rank.has(this._normalizeUrl(s.url)) ? rank.get(this._normalizeUrl(s.url)) : Infinity }));
    indexed.sort((a, b) => (a.r - b.r) || (a.i - b.i));
    this.servers = indexed.map(x => x.s);
    return this.servers.map(s => s.url).join('\n') !== before;
  }

  /** Reconcile with the Desktop app: take its removals, servers, order and
   *  names, and give it what only this page knows. Throws when the Desktop
   *  app cannot be reached. Returns counts of what changed here. */
  async reconcileWithDesktop() {
    const desktop = this._desktop();
    if (!desktop) return { added: 0, removed: 0, renamed: 0 };
    if (typeof desktop.getServerList !== 'function') return this._legacyDesktopMerge(desktop);

    let list = await desktop.getServerList();
    if (!list || !Array.isArray(list.servers)) return { added: 0, removed: 0, renamed: 0 };

    // A Desktop app that asks before every removal would ask about each of
    // these, so there this page's earlier removals stay its own.
    if (!this._trustsDesktop() && !this.desktopGated()) {
      // First time with the shared list: servers removed on this server are
      // removed for every server, then the shared list leads.
      const gone = new Set((list.removed || []).map(u => this._normalizeUrl(u)));
      const here = this._normalizeUrl(typeof location !== 'undefined' ? location.origin : '');
      const mine = [...this._loadRemoved()].map(u => this._normalizeUrl(u)).filter(u => u && u !== here && !gone.has(u));
      if (mine.length && typeof desktop.removeServerHistory === 'function') {
        for (const url of mine) await desktop.removeServerHistory(url);
        list = await desktop.getServerList();
      }
      try { localStorage.setItem('haven_servers_desktop_list', '1'); }
      catch (err) { console.warn('[Servers] could not save the Desktop list flag', err); }
    }

    const stats = this.applyDesktopList(list);
    await this._pushToDesktop(desktop, list);
    return stats;
  }

  /** Give the Desktop app the servers, user edits and first order that only
   *  this page has. A Desktop app that asks before every change only gets
   *  the order: servers and edits reach it when the user makes them. */
  async _pushToDesktop(desktop, list) {
    const known = new Map(list.servers.map(s => [this._normalizeUrl(s.url), s]));
    for (const s of (this.desktopGated() ? [] : this.servers)) {
      const url = this._normalizeUrl(s.url);
      if (this.desktopRemoved.has(url)) continue;
      const ds = known.get(url);
      if (!ds && typeof desktop.addServerHistory === 'function') await desktop.addServerHistory(url, s.name);
      if (s.editedAt && (!ds || (Number(ds.editedAt) || 0) < s.editedAt)) await this._pushEdit(s);
    }
    if (!list.hasOrder && this.servers.length > 1 && typeof desktop.setServerOrder === 'function') {
      await desktop.setServerOrder(this.servers.map(s => s.url));
    }
  }

  /** user: the user made this edit just now. A Desktop app that asks first
   *  only asks about edits marked this way; it takes unmarked ones for
   *  syncing and leaves its list as it is. */
  _pushEdit(server, { user = false } = {}) {
    const desktop = this._desktop();
    if (!desktop || typeof desktop.updateServerName !== 'function') return Promise.resolve();
    const opts = {
      custom: !!server.customName,
      icon: server.customIcon ? (server.icon || null) : null,
      editedAt: server.editedAt || Date.now(),
    };
    if (user) opts.user = true;
    return Promise.resolve(desktop.updateServerName(server.url, server.name, opts));
  }

  /** Desktop versions without the shared list: the plain history, merged
   *  both ways, with this page's removals kept out. */
  async _legacyDesktopMerge(desktop) {
    const stats = { added: 0, removed: 0, renamed: 0 };
    if (typeof desktop.getServerHistory !== 'function') return stats;
    const history = await desktop.getServerHistory();
    const removed = this._loadRemoved();
    const historyUrls = new Set();
    for (const h of (history || [])) {
      if (!h || !h.url) continue;
      const url = this._normalizeUrl(h.url);
      historyUrls.add(url);
      if (removed.has(url) || removed.has(h.url)) continue;
      if (this.add(h.name || url, url)) stats.added++;
    }
    if (typeof desktop.addServerHistory === 'function') {
      for (const s of this.servers) {
        if (historyUrls.has(this._normalizeUrl(s.url))) continue;
        Promise.resolve(desktop.addServerHistory(s.url, s.name))
          .catch((err) => { console.warn('[Desktop] could not add to server history', err); });
      }
    }
    return stats;
  }

  /** Fetch the current server's fingerprint so we can hide "self" from the sidebar. */
  async _fetchSelfFingerprint() {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        if (data.fingerprint) this.selfFingerprint = data.fingerprint;
      }
    } catch (err) { console.warn('[Servers] could not read this server fingerprint', err); }
  }

  _load() {
    try {
      const raw = JSON.parse(localStorage.getItem('haven_servers') || '[]');
      // Normalize URLs on load to dedup legacy entries while preserving
      // subpath-hosted servers like https://host/community.
      const seen = new Set();
      const deduped = [];
      for (const s of raw) {
        const normalizedUrl = this._normalizeUrl(s?.url || '');
        if (!normalizedUrl || seen.has(normalizedUrl)) continue;
        s.url = normalizedUrl;
        seen.add(normalizedUrl);
        deduped.push(s);
      }
      const marked = this._markOldNamesCustom(deduped);
      if (deduped.length !== raw.length || marked) {
        localStorage.setItem('haven_servers', JSON.stringify(deduped));
      }
      return deduped;
    } catch { return []; }
  }

  /** Before 4.19 a stored name never followed the server, so every name a
   *  list from then holds was typed by the user or kept on purpose. Once,
   *  mark those (not a bare address, not the default "Haven") as the
   *  user's own so the server's name does not replace them. editedAt 1 is
   *  older than any real edit: an edit made in the Desktop app wins, and
   *  the name is only handed to the app when it has no edit of its own.
   *  Returns true when an entry changed. */
  _markOldNamesCustom(list) {
    const KEY = 'haven_servers_names_kept';
    if (localStorage.getItem(KEY) === '1') return false;
    let changed = false;
    for (const s of list) {
      const name = String(s.name || '').trim();
      if (s.customName || name === 'Haven' || this._isUrlName(s)) continue;
      s.customName = true;
      if (!s.editedAt) s.editedAt = 1;
      changed = true;
    }
    try { localStorage.setItem(KEY, '1'); }
    catch (err) { console.warn('[Servers] could not save the kept-names flag', err); }
    return changed;
  }

  _save() {
    localStorage.setItem('haven_servers', JSON.stringify(this.servers));
  }

  add(name, url, icon = null, opts = {}) {
    url = this._normalizeUrl(url);
    if (this.servers.find(s => this._normalizeUrl(s.url) === url)) return false;

    const removed = this._loadRemoved();
    if (opts.userInitiated) {
      // User explicitly adding: clear from removed set so sync won't fight it
      if (removed.has(url)) {
        removed.delete(url);
        this._saveRemoved(removed);
      }
      this.desktopRemoved.delete(url);
    } else if (removed.has(url) || this.desktopRemoved.has(url)) {
      // Bootstrap / sync path: never resurrect a server the user has removed,
      // here or (in the Desktop app) on any other server.
      return false;
    }

    const entry = { name, url, icon, addedAt: Date.now() };
    // A name the user typed is theirs: the server's own name does not
    // replace it (a bare address or the default "Haven" still follows it).
    if (opts.customName && String(name || '').trim() !== 'Haven' && !this._isUrlName(entry)) {
      entry.customName = true;
      entry.editedAt = Date.now();
    }
    this.servers.push(entry);
    this._save();
    this.checkServer(url);
    return true;
  }

  /** Hand a name the user chose to the Desktop app's shared list (call once
   *  the app knows the server). */
  shareName(url) {
    const normalizedUrl = this._normalizeUrl(url);
    const server = this.servers.find(s => this._normalizeUrl(s.url) === normalizedUrl);
    if (!server || !server.customName) return Promise.resolve();
    return this._pushEdit(server);
  }

  update(url, updates) {
    const normalizedUrl = this._normalizeUrl(url);
    const server = this.servers.find(s => this._normalizeUrl(s.url) === normalizedUrl);
    if (!server) return false;
    if (updates.name !== undefined) server.name = updates.name;
    if (updates.icon !== undefined) {
      server.icon = updates.icon;
      delete server.customIcon;
    }
    this._save();
    return true;
  }

  /** The user edited a server's name or icon. A name other than the one the
   *  server reports is the user's own and is kept (and shared with every
   *  server in the Desktop app); the server's own name goes back to
   *  following the server. Returns true when the edit was made; in a
   *  Desktop app that asks first, a promise of that, false when the user
   *  said no there. */
  editByUser(url, { name, icon = null }) {
    const normalizedUrl = this._normalizeUrl(url);
    const server = this.servers.find(s => this._normalizeUrl(s.url) === normalizedUrl);
    if (!server || !name) return false;
    const status = this.statusCache.get(normalizedUrl);
    const reported = status && status.online ? status : null;
    const next = { ...server };
    if (name !== next.name) next.customName = true;
    if (reported && name === reported.name) delete next.customName;
    next.name = name;
    const newIcon = icon || null;
    if (newIcon !== (next.icon || null)) {
      next.icon = newIcon;
      next.iconData = null;
    }
    if (newIcon && newIcon !== (reported && reported.icon)) next.customIcon = true;
    else delete next.customIcon;
    next.editedAt = Date.now();
    const seen = (e) => [e.name, e.customIcon ? (e.icon || null) : null].join('\n');
    if (this.desktopAsksFor(normalizedUrl) && seen(next) !== seen(server)) {
      // The app asks the user; the edit is made here once it said yes.
      return this._pushEdit(next, { user: true }).then((changed) => (changed === true ? this._replaceServer(server, next) : false));
    }
    this._replaceServer(server, next);
    if (!this.desktopGated()) {
      this._pushEdit(next).catch((err) => { console.warn('[Desktop] could not share the server name', err); });
    }
    return true;
  }

  _replaceServer(server, next) {
    const i = this.servers.indexOf(server);
    if (i < 0) return false;
    this.servers[i] = next;
    this._save();
    return true;
  }

  remove(url) {
    const normalizedUrl = this._removeHere(url);
    // In the Desktop app the removal applies to every server's list.
    const desktop = this._desktop();
    if (desktop && typeof desktop.removeServerHistory === 'function') {
      Promise.resolve(desktop.removeServerHistory(normalizedUrl))
        .catch((err) => { console.warn('[Desktop] could not remove from server history', err); });
    }
  }

  /** In a Desktop app that asks first: the app asks the user, and the
   *  server is removed here only once it is gone from the app's list.
   *  Marked as the user's own, since the app takes unmarked removals for
   *  syncing. Resolves to true when it was removed. */
  async removeThroughDesktop(url) {
    const normalizedUrl = this._normalizeUrl(url);
    const history = await this._desktop().removeServerHistory(normalizedUrl, { user: true });
    // Anything but a list without it means the app kept it.
    if (!Array.isArray(history) || history.some(h => this._normalizeUrl(h && h.url) === normalizedUrl)) return false;
    this._removeHere(normalizedUrl);
    return true;
  }

  /** Remove a server from this page's own list. Returns its address. */
  _removeHere(url) {
    const normalizedUrl = this._normalizeUrl(url);
    this.servers = this.servers.filter(s => this._normalizeUrl(s.url) !== normalizedUrl);
    this.statusCache.delete(normalizedUrl);
    this._save();
    this.markRemoved(normalizedUrl);
    if (normalizedUrl && this._desktop()) this.desktopRemoved.add(normalizedUrl);
    return normalizedUrl;
  }

  /** Reorder servers by an array of URLs in the desired order. Servers the
   *  list leaves out (this server, a second address of one shown) keep
   *  their places; only the listed ones move among theirs. */
  reorder(orderedUrls) {
    const want = [...new Set((orderedUrls || []).map(u => this._normalizeUrl(u)))];
    const byUrl = new Map(this.servers.map(s => [this._normalizeUrl(s.url), s]));
    const moving = want.filter(u => byUrl.has(u));
    const movingSet = new Set(moving);
    let i = 0;
    this.servers = this.servers.map(s => (movingSet.has(this._normalizeUrl(s.url)) ? byUrl.get(moving[i++]) : s));
    this._save();
    const desktop = this._desktop();
    if (desktop && typeof desktop.setServerOrder === 'function') {
      Promise.resolve(desktop.setServerOrder(this.servers.map(s => s.url)))
        .catch((err) => { console.warn('[Desktop] could not share the server order', err); });
    }
  }

  /** Every server with its last status. A server answering with the same
   *  fingerprint as one earlier in the list is the same server under a
   *  second address and carries duplicateOf: { url, name } of the first. */
  getAll() {
    const firstByFingerprint = new Map();
    return this.servers.map(s => {
      const status = this.statusCache.get(s.url) || { online: null, name: s.name };
      const out = { ...s, status };
      const fp = status.online === true ? status.fingerprint : null;
      if (fp) {
        const first = firstByFingerprint.get(fp);
        if (first) out.duplicateOf = { url: first.url, name: first.name };
        else firstByFingerprint.set(fp, s);
      }
      return out;
    });
  }

  /** True for this server itself, by address or by fingerprint. */
  isSelf(server, currentOrigin) {
    if (this.selfFingerprint && server.status && server.status.fingerprint === this.selfFingerprint) return true;
    try { return new URL(server.url).origin === currentOrigin; }
    catch { return false; } // an unparsable address is never this server
  }

  /** Servers for Manage Servers: everything but this server. */
  otherServers(currentOrigin) {
    return this.getAll().filter(s => !this.isSelf(s, currentOrigin));
  }

  /** Servers for the rail: everything but this server and second addresses
   *  of a server already shown. */
  railServers(currentOrigin) {
    return this.otherServers(currentOrigin).filter(s => !s.duplicateOf);
  }

  /** Follow the name a server reports, unless the user chose one. "Haven"
   *  is the default of a server that never set a name and is skipped.
   *  Returns true when the stored name changed. */
  _refreshName(normalizedUrl, reportedName) {
    const entry = this.servers.find(s => this._normalizeUrl(s.url) === normalizedUrl);
    const name = String(reportedName || '').trim();
    if (!entry || entry.customName || !name || name === 'Haven' || name === entry.name) return false;
    entry.name = name;
    this._save();
    // A Desktop app that asks first takes a server's name only from that
    // server's own page.
    const desktop = this._desktop();
    if (desktop && typeof desktop.updateServerName === 'function' && !this.desktopGated()) {
      Promise.resolve(desktop.updateServerName(entry.url, name))
        .catch((err) => { console.warn('[Desktop] could not share the server name', err); });
    }
    return true;
  }

  /** Check one server. Resolves to { renamed } (true when its stored name
   *  followed a new name from the server). */
  async checkServer(url) {
    const normalizedUrl = this._normalizeUrl(url);
    let renamed = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const healthBase = normalizedUrl;

      // The timer is cleared whether the request answers or fails.
      const res = await fetch(`${healthBase}/api/health`, {
        signal: controller.signal,
        mode: 'cors'
      }).finally(() => clearTimeout(timeout));

      if (res.ok) {
        const data = await res.json();
        const discoveredIcon = data.icon ? new URL(data.icon, `${healthBase}/`).toString() : null;
        this.statusCache.set(normalizedUrl, {
          online: true,
          name: data.name || normalizedUrl,
          icon: discoveredIcon,
          version: data.version,
          fingerprint: data.fingerprint || null,
          checkedAt: Date.now()
        });
        if (data.name) renamed = this._refreshName(normalizedUrl, data.name);
        // Persist discovered icon to the server entry so it survives
        // across page reloads and offline periods (an icon the user chose
        // stays)
        if (discoveredIcon) {
          const entry = this.servers.find(s => this._normalizeUrl(s.url) === normalizedUrl);
          if (entry && !entry.customIcon) {
            // Always update the icon URL (server may have changed its icon)
            if (entry.icon !== discoveredIcon) {
              entry.icon = discoveredIcon;
              entry.iconData = null; // clear stale thumbnail
              this._save();
            }
            // Generate a small base64 thumbnail so the icon travels
            // with the encrypted sync bundle across servers
            if (!entry.iconData) {
              this._fetchIconThumbnail(discoveredIcon).then(dataUrl => {
                if (dataUrl) { entry.iconData = dataUrl; this._save(); }
              });
            }
          }
        }
      } else {
        this.statusCache.set(normalizedUrl, { online: false, checkedAt: Date.now() });
      }
    } catch {
      this.statusCache.set(normalizedUrl, { online: false, checkedAt: Date.now() });
    }
    return { renamed };
  }

  /** Check every server. Resolves to how many names followed their server. */
  async checkAll() {
    const results = await Promise.allSettled(this.servers.map(s => this.checkServer(s.url)));
    return results.filter(r => r.status === 'fulfilled' && r.value && r.value.renamed).length;
  }

  startPolling(intervalMs = 30000) {
    this.checkAll();
    this.checkInterval = setInterval(() => this.checkAll(), intervalMs);
  }

  stopPolling() {
    if (this.checkInterval) clearInterval(this.checkInterval);
  }

  // ── Encrypted server-side sync ───────────────────────
  // Stores the server list as an AES-256-GCM blob on each Haven server.
  // wrappingHex: the 64-char hex string from HavenE2E.deriveWrappingKey()

  /** Fetch a remote icon and shrink it to a tiny base64 data URL. */
  async _fetchIconThumbnail(iconUrl) {
    try {
      const res = await fetch(iconUrl, { mode: 'cors', signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) return null;
      const bmp = await createImageBitmap(blob);
      const size = 48;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0, size, size);
      bmp.close();
      return canvas.toDataURL('image/png');
    } catch { return null; }
  }

  /** Merge with this account's encrypted list on this server. Resolves to
   *  { ok, added }; ok is false when the server could not be reached. */
  async syncWithServer(token, wrappingHex) {
    if (!token || !wrappingHex) return { ok: true, added: 0 };
    let added = 0;
    try {
      // 1. Fetch the encrypted blob from the server
      const res = await fetch('/api/auth/user-servers', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) return { ok: false, added: 0 };
      const { blob } = await res.json();

      // 2. Decrypt server-side list (if any)
      let remoteServers = [];
      if (blob) {
        try {
          const decrypted = await this._decryptBlob(blob, wrappingHex);
          remoteServers = JSON.parse(decrypted);
          if (!Array.isArray(remoteServers)) remoteServers = [];
        } catch {
          // Decryption failed: blob was encrypted with a different password
          // or is corrupted. Start fresh from localStorage.
          console.warn('[ServerSync] Could not decrypt server blob, using local list');
        }
      }

      // 3. Load removed-servers set (removals are local-only, never synced)
      const removed = this._loadRemoved();

      // 4. Merge: union by URL, filtering out locally-removed servers
      const localUrls = new Set(this.servers.map(s => this._normalizeUrl(s.url)));
      const remoteUrls = new Set(remoteServers.map(s => this._normalizeUrl(s.url)));
      let changed = false;

      // Add remote servers we don't have locally (and haven't removed, here
      // or in the Desktop app)
      for (const rs of remoteServers) {
        if (!rs || !rs.url) continue;
        const normalizedUrl = this._normalizeUrl(rs.url);
        if (!localUrls.has(rs.url) && !localUrls.has(normalizedUrl)
            && !removed.has(rs.url) && !removed.has(normalizedUrl)
            && !this.desktopRemoved.has(normalizedUrl)) {
          rs.url = normalizedUrl; // store the normalized form
          this.servers.push(rs);
          localUrls.add(normalizedUrl); // prevent duplicate adds within same sync
          changed = true;
          added++;
        }
      }

      // Check if we have servers the remote doesn't
      for (const ls of this.servers) {
        if (!remoteUrls.has(ls.url)) changed = true;
      }

      // 5. Save merged list locally
      if (changed) this._save();

      // 6. Push updated encrypted blob back if our list is longer
      if (changed || !blob) {
        await this._pushToServer(token, wrappingHex);
      }
      return { ok: true, added };
    } catch (err) {
      console.warn('[ServerSync] Sync failed:', err.message);
      return { ok: false, added };
    }
  }

  async _pushToServer(token, wrappingHex) {
    try {
      const payload = JSON.stringify(this.servers.map(s => {
        const out = { url: s.url, name: s.name, icon: s.icon, iconData: s.iconData || null, addedAt: s.addedAt };
        if (s.customName) out.customName = true;
        if (s.customIcon) out.customIcon = true;
        if (s.editedAt) out.editedAt = s.editedAt;
        return out;
      }));
      const blob = await this._encryptBlob(payload, wrappingHex);
      await fetch('/api/auth/user-servers', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ blob })
      });
    } catch (err) {
      console.warn('[ServerSync] Push failed:', err.message);
    }
  }

  // ── Crypto helpers (AES-256-GCM with PBKDF2) ─────────

  async _encryptBlob(plaintext, wrappingHex) {
    const keyBytes = this._hexToBytes(wrappingHex);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this._deriveAESKey(keyBytes, salt);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext)
    );
    // Format: base64(salt + iv + ciphertext)
    const combined = new Uint8Array(16 + 12 + ct.byteLength);
    combined.set(salt, 0);
    combined.set(iv, 16);
    combined.set(new Uint8Array(ct), 28);
    return btoa(String.fromCharCode(...combined));
  }

  async _decryptBlob(blob, wrappingHex) {
    const keyBytes = this._hexToBytes(wrappingHex);
    const raw = Uint8Array.from(atob(blob), c => c.charCodeAt(0));
    const salt = raw.slice(0, 16);
    const iv = raw.slice(16, 28);
    const ct = raw.slice(28);
    const key = await this._deriveAESKey(keyBytes, salt);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  }

  async _deriveAESKey(keyBytes, salt) {
    const raw = await crypto.subtle.importKey('raw', keyBytes, 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
      raw,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  _hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }

  /** Normalize a Haven server URL to its base path (strips /app(.html), query, hash, trailing slash). */
  _normalizeUrl(url) {
    url = String(url || '').trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      parsed.search = '';
      let pathname = parsed.pathname || '/';
      pathname = pathname.replace(/\/+$/, '') || '/';
      pathname = pathname.replace(/\/app(?:\.html)?$/i, '') || '/';
      pathname = pathname.replace(/\/+$/, '') || '/';
      return pathname === '/' ? parsed.origin : parsed.origin + pathname;
    } catch {
      return url.replace(/\/+$/, '');
    }
  }

  // ── Removed-servers tracking (local-only) ─────────────

  _loadRemoved() {
    try {
      return new Set(JSON.parse(localStorage.getItem('haven_servers_removed') || '[]'));
    } catch { return new Set(); }
  }

  _saveRemoved(set) {
    localStorage.setItem('haven_servers_removed', JSON.stringify([...set]));
  }

  markRemoved(url) {
    const normalizedUrl = this._normalizeUrl(url);
    const removed = this._loadRemoved();
    if (normalizedUrl) removed.add(normalizedUrl);
    this._saveRemoved(removed);
  }
}
