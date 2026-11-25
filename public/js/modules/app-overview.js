// Overview channels: in a channel with is_overview set, a front page for the
// server takes the place of the message log. Under the server's banner, icon
// and name (the channel topic stays in the bar above, as a welcome line) it
// shows cards for the next events, the newest announcements and the most
// active forum topics in the channels the viewer can read (src/overview.js). Clicking an item opens it
// where it lives. The page refreshes itself when one of those channels
// changes while it is on screen.

const REFRESH_MS = 1500;
const LOAD_TIMEOUT_MS = 10000;
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export default {

_isOverviewChannel(code) {
  const ch = this.channels?.find(c => c.code === code);
  return !!(ch && ch.is_overview && !ch.is_dm);
},

// Called by _renderMessages for an overview channel.
_renderOverview() {
  const container = document.getElementById('messages');
  if (!container) return;
  const code = this.currentChannel;
  if (!this._overview || this._overview.code !== code) this._overview = { code, data: null, error: null, loaded: false, loadToken: 0 };
  this._channelView = 'overview';
  container.classList.add('overview-view');
  container.innerHTML = '<div class="ov-root" id="ov-root"></div>';
  container.querySelector('#ov-root').addEventListener('click', (e) => {
    const item = e.target.closest('[data-ov-kind]');
    if (item) this._overviewOpen(item.dataset.ovKind, item.dataset.ovCode, Number(item.dataset.ovId));
  });
  this._overviewDraw();
  this._overviewLoad();
},

_overviewLoad() {
  const st = this._overview;
  if (!st || !this.socket) return;
  const token = st.loadToken + 1;
  st.loadToken = token;
  // A server without overviews never answers; say so instead of waiting.
  setTimeout(() => {
    if (this._overview !== st || st.loadToken !== token || st.loaded) return;
    st.loaded = true;
    st.error = t('overview.load_failed');
    this._overviewDraw();
  }, LOAD_TIMEOUT_MS);
  this.socket.emit('overview-data', { code: st.code }, (res) => {
    if (this._overview !== st || st.loadToken !== token) return;
    st.loaded = true;
    st.error = !res || res.error ? (res && res.error) || t('overview.load_failed') : null;
    if (!st.error) st.data = res;
    this._overviewDraw();
  });
},

// Several changes in a row make one refresh.
_overviewRefreshSoon(code) {
  const st = this._overview;
  if (!st || this._channelView !== 'overview' || this.currentChannel !== st.code) return;
  if (code && !(st.data?.watch || []).includes(code) && code !== st.code) return;
  clearTimeout(this._overviewTimer);
  this._overviewTimer = setTimeout(() => this._overviewLoad(), REFRESH_MS);
},

_overviewDraw() {
  const root = document.getElementById('ov-root');
  const st = this._overview;
  if (!root || !st || this._channelView !== 'overview') return;
  const esc = (s) => this._escapeHtml(s);
  const settings = this.serverSettings || {};
  const name = settings.server_name || settings.server_name_effective || 'Haven';
  const banner = settings.server_banner ? ` style="background-image:url('${esc(settings.server_banner)}')"` : '';
  const icon = settings.server_icon ? `<img class="ov-icon" src="${esc(settings.server_icon)}" alt="">` : '';
  const data = st.data || {};
  const today = localDay(new Date());
  // All-day events are UTC dates; one is over once its date is before today.
  const events = (data.events || []).filter(ev => !ev.allDay || ev.endsAt.slice(0, 10) >= today);
  const card = (kind, title, items, empty) => `
    <section class="ov-card ov-${kind}">
      <h3>${esc(title)}</h3>
      ${!st.loaded && !st.data ? `<p class="muted-text">${esc(t('overview.loading'))}</p>`
        : items.length ? `<ul class="ov-list">${items.join('')}</ul>` : `<p class="muted-text ov-empty">${esc(empty)}</p>`}
    </section>`;
  const item = (kind, it, inner) => `<li><button type="button" class="ov-item" data-ov-kind="${kind}" data-ov-code="${esc(it.channelCode)}" data-ov-id="${it.id}">${inner}</button></li>`;
  const where = (it) => `<span class="ov-channel">#${esc(it.channelName)}</span>`;
  const eventItems = events.map(ev => {
    const start = new Date(ev.allDay ? `${ev.startsAt.slice(0, 10)}T00:00` : ev.startsAt);
    const going = ev.mine === 'going' ? `<span class="ov-going">✓ ${esc(t('calendar.going'))}</span>` : '';
    return item('event', ev, `
      <span class="ov-date" style="--cal-color:${esc(ev.color || 'var(--accent)')}">
        <span class="ov-date-month">${esc(start.toLocaleDateString(undefined, { month: 'short' }))}</span>
        <span class="ov-date-day">${start.getDate()}</span>
      </span>
      <span class="ov-body">
        <span class="ov-title">${esc(ev.title)}</span>
        <span class="ov-meta">${esc(this._calendarWhen(ev, true))} · ${where(ev)}${ev.going ? ` · ${esc(t('calendar.going_count', { count: ev.going }))}` : ''} ${going}</span>
      </span>`);
  });
  const newsItems = (data.announcements || []).map(a => item('message', a, `
      <span class="ov-body">
        <span class="ov-meta"><strong>${esc(a.author)}</strong> · ${where(a)} · ${esc(this._relativeTime(a.createdAt))}</span>
        <span class="ov-excerpt">${esc(this._replyPreviewText(a.excerpt))}</span>
      </span>`));
  const topicItems = (data.topics || []).map(p => {
    const title = p.title || this._replyPreviewText(p.excerpt).split('\n')[0];
    return item('topic', p, `
      <span class="ov-body">
        <span class="ov-title">${p.closed ? '🔒 ' : ''}${esc(title)}</span>
        <span class="ov-meta">${where(p)} · ${esc(t(p.replies === 1 ? 'overview.replies_one' : 'overview.replies_other', { count: p.replies }))} · ${esc(t('overview.active', { when: this._relativeTime(p.activityAt) }))}</span>
      </span>`);
  });
  root.innerHTML = `
    <header class="ov-hero${banner ? ' ov-has-banner' : ''}"${banner}>
      <div class="ov-hero-inner">${icon}<h2 class="ov-name">${esc(name)}</h2></div>
    </header>
    ${st.error ? `<p class="ov-error">${esc(st.error)}</p>` : ''}
    <div class="ov-grid">
      ${card('events', `📅 ${t('overview.events')}`, eventItems, t('overview.no_events'))}
      ${card('news', `📢 ${t('overview.announcements')}`, newsItems, t('overview.no_announcements'))}
      ${card('topics', `🗂️ ${t('overview.topics')}`, topicItems, t('overview.no_topics'))}
    </div>`;
},

// Opens an item where it lives: an event in its calendar, an announcement at
// its place in the channel, a topic in its thread.
_overviewOpen(kind, code, id) {
  if (!code || !id) return;
  if (kind === 'message') { this._searchJumpTo(code, id); return; }
  if (kind === 'event') {
    const ev = (this._overview?.data?.events || []).find(e => e.id === id);
    const at = ev ? new Date(ev.allDay ? `${ev.startsAt.slice(0, 10)}T00:00` : ev.startsAt) : new Date();
    // The calendar opens on the event's month, with the event on top.
    this._calendar = { code, year: at.getFullYear(), month: at.getMonth(), events: new Map(), canPost: false, canModerate: false, loaded: false, error: null };
    this.switchChannel(code);
    this._calendarOpenEvent(id);
    return;
  }
  this.switchChannel(code);
  setTimeout(() => { if (this.currentChannel === code) this._openThread(id); }, 600);
},

_listenOverview() {
  this.socket.on('new-message', (data) => this._overviewRefreshSoon(data?.channelCode));
  this.socket.on('calendar-changed', (data) => this._overviewRefreshSoon(data?.channelCode));
  this.socket.on('calendar-removed', (data) => this._overviewRefreshSoon(data?.channelCode));
},

};
