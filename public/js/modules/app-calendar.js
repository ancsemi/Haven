// Calendar channels: in a channel with is_calendar set, a month of events
// takes the place of the message log. Anyone who may post adds events; anyone
// who can read the channel answers going, maybe or can't go. The server side
// is src/socketHandlers/calendar.js.
//
// Timed events are shown in the viewer's own time zone. All-day events are
// dates, stored as whole UTC days, so they are read with UTC dates and land
// on the same day for everyone.

const COLORS = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#9b59b6', '#1abc9c'];
const MAX_CHIPS = 3;
const STATUSES = ['going', 'maybe', 'declined'];
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export default {

_isCalendarChannel(code) {
  const ch = this.channels?.find(c => c.code === code);
  return !!(ch && ch.is_calendar && !ch.is_dm);
},

// Called by _renderMessages for a calendar channel. The month on show is
// kept while you stay in the channel, so a reload does not jump back.
_renderCalendar() {
  const container = document.getElementById('messages');
  if (!container) return;
  const code = this.currentChannel;
  if (!this._calendar || this._calendar.code !== code) {
    const now = new Date();
    this._calendar = { code, year: now.getFullYear(), month: now.getMonth(), events: new Map(), canPost: false, canModerate: false, loaded: false, error: null };
  }
  this._channelView = 'calendar';
  container.classList.add('calendar-view');
  container.innerHTML = `
    <div class="cal-root" id="cal-root">
      <div class="cal-toolbar">
        <button type="button" class="btn-sm cal-nav" data-cal="prev" aria-label="${this._escapeHtml(t('calendar.previous_month'))}">‹</button>
        <h2 class="cal-title" aria-live="polite"></h2>
        <button type="button" class="btn-sm cal-nav" data-cal="next" aria-label="${this._escapeHtml(t('calendar.next_month'))}">›</button>
        <button type="button" class="btn-sm" data-cal="today">${this._escapeHtml(t('calendar.today'))}</button>
        <span class="cal-spacer"></span>
        <button type="button" class="btn-sm btn-accent" data-cal="add" style="display:none">＋ ${this._escapeHtml(t('calendar.add_event'))}</button>
      </div>
      <div class="cal-grid" role="grid"></div>
      <p class="cal-status muted-text"></p>
      <div class="cal-agenda"></div>
    </div>`;
  const root = container.querySelector('#cal-root');
  root.querySelector('[data-cal="prev"]').addEventListener('click', () => this._calendarShift(-1));
  root.querySelector('[data-cal="next"]').addEventListener('click', () => this._calendarShift(1));
  root.querySelector('[data-cal="today"]').addEventListener('click', () => {
    const now = new Date();
    this._calendar.year = now.getFullYear();
    this._calendar.month = now.getMonth();
    this._calendarLoad();
  });
  root.querySelector('[data-cal="add"]').addEventListener('click', () => this._calendarOpenEditor(null, null));
  root.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cal-event]');
    if (chip) { this._calendarOpenEvent(Number(chip.dataset.calEvent)); return; }
    const more = e.target.closest('[data-cal-more]');
    if (more) {
      const row = root.querySelector(`.cal-agenda [data-cal-day="${more.dataset.calMore}"]`);
      if (row) { row.scrollIntoView({ behavior: this._scrollBehavior(), block: 'start' }); row.classList.add('cal-flash'); setTimeout(() => row.classList.remove('cal-flash'), 1200); }
      return;
    }
    const cell = e.target.closest('.cal-day');
    if (cell && this._calendar.canPost) this._calendarOpenEditor(null, cell.dataset.day);
  });
  this._calendarDraw();
  this._calendarLoad();
},

_calendarShift(by) {
  const st = this._calendar;
  if (!st) return;
  const d = new Date(st.year, st.month + by, 1);
  st.year = d.getFullYear();
  st.month = d.getMonth();
  this._calendarLoad();
},

// 0 for weeks that start on Sunday, 1 for Monday, and so on, from the
// browser's locale where it says.
_calendarWeekStart() {
  try {
    const loc = new Intl.Locale(navigator.language || 'en-US');
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    return info && info.firstDay ? info.firstDay % 7 : 0;
  } catch { return 0; }
},

// The days the grid shows: whole weeks around the month.
_calendarGrid() {
  const st = this._calendar;
  const first = new Date(st.year, st.month, 1);
  const weekStart = this._calendarWeekStart();
  const lead = (first.getDay() - weekStart + 7) % 7;
  const days = new Date(st.year, st.month + 1, 0).getDate();
  const weeks = Math.ceil((lead + days) / 7);
  return { first, weekStart, lead, days, cells: weeks * 7, start: new Date(st.year, st.month, 1 - lead), end: new Date(st.year, st.month, 1 - lead + weeks * 7) };
},

_calendarLoad() {
  const st = this._calendar;
  if (!st || !this.socket) return;
  const grid = this._calendarGrid();
  const token = (st.loadToken || 0) + 1;
  st.loadToken = token;
  st.loaded = false;
  this._calendarDraw();
  // A server without calendars never answers; say so instead of loading forever.
  setTimeout(() => {
    if (this._calendar !== st || st.loadToken !== token || st.loaded) return;
    st.loaded = true;
    st.error = t('calendar.load_failed');
    this._calendarDraw();
  }, 10000);
  this.socket.emit('calendar-events', { code: st.code, from: grid.start.toISOString(), to: grid.end.toISOString() }, (res) => {
    if (this._calendar !== st || st.loadToken !== token) return;
    st.loaded = true;
    if (!res || res.error) {
      st.error = (res && res.error) || t('calendar.load_failed');
    } else {
      st.error = null;
      st.events = new Map((res.events || []).map(ev => [ev.id, ev]));
      st.canPost = !!res.canPost;
      st.canModerate = !!res.canModerate;
    }
    this._calendarDraw();
  });
},

// Whether an event falls on a local calendar day.
_calendarOnDay(ev, day, dayStart, dayEnd) {
  if (ev.allDay) return ev.startsAt.slice(0, 10) <= day && ev.endsAt.slice(0, 10) >= day;
  const s = Date.parse(ev.startsAt);
  const e = Date.parse(ev.endsAt);
  return s < dayEnd && (e > dayStart || s >= dayStart);
},

_calendarSorted() {
  return [...(this._calendar?.events.values() || [])].sort((a, b) =>
    (a.allDay === b.allDay ? 0 : (a.allDay ? -1 : 1)) || a.startsAt.localeCompare(b.startsAt) || a.id - b.id);
},

_calendarDraw() {
  const st = this._calendar;
  const root = document.getElementById('cal-root');
  if (!st || !root) return;
  const esc = (s) => this._escapeHtml(s);
  const grid = this._calendarGrid();
  root.querySelector('.cal-title').textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(grid.first);
  root.querySelector('[data-cal="add"]').style.display = st.canPost ? '' : 'none';
  const status = root.querySelector('.cal-status');
  status.textContent = st.error || (st.loaded ? '' : t('calendar.loading'));
  status.style.display = status.textContent ? '' : 'none';
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  // 1 January 2023 was a Sunday.
  let html = Array.from({ length: 7 }, (_, i) => `<div class="cal-weekday" role="columnheader">${esc(weekday.format(new Date(2023, 0, 1 + ((grid.weekStart + i) % 7))))}</div>`).join('');
  const events = this._calendarSorted();
  const today = localDay(new Date());
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  for (let i = 0; i < grid.cells; i++) {
    const d = new Date(st.year, st.month, 1 - grid.lead + i);
    const day = localDay(d);
    const dayStart = d.getTime();
    const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const on = events.filter(ev => this._calendarOnDay(ev, day, dayStart, dayEnd));
    const chips = on.slice(0, MAX_CHIPS).map(ev => {
      const time = ev.allDay || Date.parse(ev.startsAt) < dayStart ? '' : `<span class="cal-chip-time">${esc(timeFmt.format(new Date(ev.startsAt)))}</span> `;
      return `<button type="button" class="cal-chip${ev.mine === 'going' ? ' cal-chip-going' : ''}" data-cal-event="${ev.id}" style="--cal-color:${ev.color || 'var(--accent)'}" title="${esc(ev.title)}">${time}${esc(ev.title)}</button>`;
    }).join('');
    const more = on.length > MAX_CHIPS ? `<button type="button" class="cal-more" data-cal-more="${day}">${esc(t('calendar.more', { count: on.length - MAX_CHIPS }))}</button>` : '';
    const cls = ['cal-day', d.getMonth() !== st.month ? 'cal-other' : '', day === today ? 'cal-today' : '', st.canPost ? 'cal-can-add' : ''].filter(Boolean).join(' ');
    html += `<div class="${cls}" role="gridcell" data-day="${day}" aria-label="${esc(d.toLocaleDateString(undefined, { dateStyle: 'full' }))}">
      <span class="cal-date">${d.getDate()}</span>${chips}${more}</div>`;
  }
  root.querySelector('.cal-grid').innerHTML = html;
  this._calendarDrawAgenda(root, grid, events);
},

// The month as a list, for small screens and for "+ more".
_calendarDrawAgenda(root, grid, events) {
  const st = this._calendar;
  const esc = (s) => this._escapeHtml(s);
  const byDay = new Map();
  for (let i = 0; i < grid.days; i++) {
    const d = new Date(st.year, st.month, 1 + i);
    const day = localDay(d);
    const dayStart = d.getTime();
    const dayEnd = new Date(st.year, st.month, 2 + i).getTime();
    // A long event is listed on its first day in this month only.
    const on = events.filter(ev => {
      if (!this._calendarOnDay(ev, day, dayStart, dayEnd)) return false;
      if (i === 0) return true;
      const prev = new Date(st.year, st.month, i);
      return !this._calendarOnDay(ev, localDay(prev), prev.getTime(), dayStart);
    });
    if (on.length) byDay.set(day, { d, on });
  }
  const box = root.querySelector('.cal-agenda');
  if (!byDay.size) {
    box.innerHTML = st.loaded && !st.error ? `<p class="cal-empty muted-text">${esc(t(st.canPost ? 'calendar.empty_can_add' : 'calendar.empty'))}</p>` : '';
    return;
  }
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  box.innerHTML = [...byDay.entries()].map(([day, { d, on }]) => `
    <section class="cal-agenda-day" data-cal-day="${day}">
      <h3>${esc(dayFmt.format(d))}</h3>
      ${on.map(ev => `<button type="button" class="cal-agenda-item" data-cal-event="${ev.id}" style="--cal-color:${ev.color || 'var(--accent)'}">
        <span class="cal-agenda-when">${esc(this._calendarWhen(ev, true))}</span>
        <span class="cal-agenda-title">${esc(ev.title)}</span>
        ${ev.location ? `<span class="cal-agenda-where">📍 ${esc(ev.location)}</span>` : ''}
        ${ev.going ? `<span class="cal-agenda-count">${esc(t('calendar.going_count', { count: ev.going }))}</span>` : ''}
      </button>`).join('')}
    </section>`).join('');
},

// "Saturday, March 14 · All day", "Mar 14, 7:00 – 10:00 PM" and the like.
_calendarWhen(ev, short = false) {
  const a = new Date(ev.startsAt);
  const b = new Date(ev.endsAt);
  try {
    if (ev.allDay) {
      const f = new Intl.DateTimeFormat(undefined, short ? { month: 'short', day: 'numeric', timeZone: 'UTC' } : { dateStyle: 'full', timeZone: 'UTC' });
      const days = ev.startsAt.slice(0, 10) === ev.endsAt.slice(0, 10) ? f.format(a) : f.formatRange(a, b);
      return `${days} · ${t('calendar.all_day')}`;
    }
    if (short) {
      const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
      return localDay(a) === localDay(b) ? time.formatRange(a, b) : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).formatRange(a, b);
    }
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).formatRange(a, b);
  } catch {
    return `${a.toLocaleString()} – ${b.toLocaleString()}`;
  }
},

_calendarMayEdit(ev) {
  const st = this._calendar;
  return !!(st && (st.canModerate || (ev.createdBy === this.user?.id && st.canPost)));
},

_calendarMayDelete(ev) {
  const st = this._calendar;
  return !!(st && (st.canModerate || ev.createdBy === this.user?.id));
},

_calendarOverlay(cls, html) {
  document.querySelector('.cal-modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay cal-modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  return { overlay, close };
},

// An event, who answered, and your own answer.
_calendarOpenEvent(id) {
  const st = this._calendar;
  if (!st) return;
  this.socket.emit('calendar-event', { id }, (res) => {
    if (!res || res.error) { this._showToast(res?.error || t('calendar.load_failed'), 'error'); return; }
    st.events.set(id, res.event);
    this._calendarShowEvent(res.event, res.attendees || []);
  });
},

_calendarShowEvent(ev, attendees) {
  const esc = (s) => this._escapeHtml(s);
  const label = { going: t('calendar.going'), maybe: t('calendar.maybe'), declined: t('calendar.declined') };
  const groups = STATUSES.map(s => {
    const names = attendees.filter(a => a.status === s).map(a => esc(a.name));
    return names.length ? `<div class="cal-attendees-row"><strong>${esc(label[s])} (${names.length})</strong> ${names.join(', ')}</div>` : '';
  }).join('');
  const { overlay, close } = this._calendarOverlay('cal-event-modal', `
    <div class="cal-event-stripe" style="--cal-color:${ev.color || 'var(--accent)'}"></div>
    <h3 class="cal-event-title">${esc(ev.title)}</h3>
    <p class="cal-event-when">🕒 ${esc(this._calendarWhen(ev))}</p>
    ${ev.location ? `<p class="cal-event-where">📍 ${esc(ev.location)}</p>` : ''}
    ${ev.description ? `<p class="cal-event-desc">${esc(ev.description)}</p>` : ''}
    ${ev.creatorName ? `<p class="cal-event-by muted-text">${esc(t('calendar.added_by', { name: ev.creatorName }))}</p>` : ''}
    <div class="cal-rsvp" role="group" aria-label="${esc(t('calendar.your_answer'))}">
      ${STATUSES.map(s => `<button type="button" class="btn-sm cal-rsvp-btn${ev.mine === s ? ' active' : ''}" data-rsvp="${s}" aria-pressed="${ev.mine === s}">${esc(label[s])}${s === 'going' ? ` · ${ev.going}` : (s === 'maybe' ? ` · ${ev.maybe}` : '')}</button>`).join('')}
    </div>
    <div class="cal-attendees">${groups}</div>
    <div class="modal-actions" style="margin-top:12px">
      ${this._calendarMayDelete(ev) ? `<button type="button" class="btn-sm cal-delete" data-cal-act="delete">${esc(t('calendar.delete'))}</button>` : ''}
      ${this._calendarMayEdit(ev) ? `<button type="button" class="btn-sm" data-cal-act="edit">${esc(t('calendar.edit'))}</button>` : ''}
      <button type="button" class="btn-sm btn-accent" data-cal-act="close">${esc(t('modals.common.close'))}</button>
    </div>`);
  overlay.dataset.calOpen = String(ev.id);
  overlay.querySelectorAll('[data-rsvp]').forEach(btn => btn.addEventListener('click', () => {
    // Pressing your current answer again takes it back.
    const status = ev.mine === btn.dataset.rsvp ? null : btn.dataset.rsvp;
    this.socket.emit('calendar-rsvp', { id: ev.id, status }, (res) => {
      if (!res || res.error) { this._showToast(res?.error || t('calendar.save_failed'), 'error'); return; }
      this._calendarOpenEvent(ev.id);
    });
  }));
  overlay.querySelector('[data-cal-act="close"]').addEventListener('click', close);
  overlay.querySelector('[data-cal-act="edit"]')?.addEventListener('click', () => { close(); this._calendarOpenEditor(ev, null); });
  overlay.querySelector('[data-cal-act="delete"]')?.addEventListener('click', async () => {
    const ok = await this._showConfirmModal(t('calendar.delete_title', { title: ev.title }), t('calendar.delete_body'), { danger: true });
    if (!ok) return;
    this.socket.emit('calendar-delete', { id: ev.id }, (res) => {
      if (!res || res.error) { this._showToast(res?.error || t('calendar.save_failed'), 'error'); return; }
      close();
    });
  });
},

// Add an event (ev null, optionally on `day`) or change one.
_calendarOpenEditor(ev, day) {
  const st = this._calendar;
  if (!st) return;
  const esc = (s) => this._escapeHtml(s);
  const now = new Date();
  const startDay = day || localDay(now);
  // A new event starts at the next whole hour, on the day that was clicked.
  const nextHour = pad((now.getHours() + 1) % 24) + ':00';
  const init = ev ? (ev.allDay
    ? { sd: ev.startsAt.slice(0, 10), st: nextHour, ed: ev.endsAt.slice(0, 10), et: nextHour }
    : { sd: localDay(new Date(ev.startsAt)), st: localTime(new Date(ev.startsAt)), ed: localDay(new Date(ev.endsAt)), et: localTime(new Date(ev.endsAt)) })
    : { sd: startDay, st: nextHour, ed: startDay, et: pad((now.getHours() + 2) % 24) + ':00' };
  let color = ev ? ev.color : null;
  const { overlay, close } = this._calendarOverlay('cal-editor', `
    <h3>${esc(t(ev ? 'calendar.edit_event' : 'calendar.new_event'))}</h3>
    <label class="cal-field"><span>${esc(t('calendar.title'))}</span>
      <input type="text" class="settings-text-input" id="cal-ed-title" maxlength="100" value="${esc(ev ? ev.title : '')}" required></label>
    <label class="checkbox-row cal-allday"><input type="checkbox" id="cal-ed-allday" ${ev && ev.allDay ? 'checked' : ''}> <span>${esc(t('calendar.all_day'))}</span></label>
    <div class="cal-field-row">
      <label class="cal-field"><span>${esc(t('calendar.starts'))}</span>
        <span class="cal-when-inputs"><input type="date" id="cal-ed-sd" value="${init.sd}"><input type="time" id="cal-ed-st" value="${init.st}"></span></label>
      <label class="cal-field"><span>${esc(t('calendar.ends'))}</span>
        <span class="cal-when-inputs"><input type="date" id="cal-ed-ed" value="${init.ed}"><input type="time" id="cal-ed-et" value="${init.et}"></span></label>
    </div>
    <label class="cal-field"><span>${esc(t('calendar.location'))}</span>
      <input type="text" class="settings-text-input" id="cal-ed-loc" maxlength="200" value="${esc(ev ? ev.location : '')}"></label>
    <label class="cal-field"><span>${esc(t('calendar.description'))}</span>
      <textarea class="settings-text-input" id="cal-ed-desc" maxlength="2000" rows="4">${esc(ev ? ev.description : '')}</textarea></label>
    <div class="cal-field"><span>${esc(t('calendar.color'))}</span>
      <div class="cal-swatches">
        <button type="button" class="cal-swatch cal-swatch-none" data-color="" aria-label="${esc(t('calendar.color_default'))}"></button>
        ${COLORS.map(c => `<button type="button" class="cal-swatch" data-color="${c}" style="--cal-color:${c}" aria-label="${c}"></button>`).join('')}
      </div></div>
    <p class="cal-error" role="alert" style="display:none"></p>
    <div class="modal-actions" style="margin-top:12px">
      <button type="button" class="btn-sm" data-cal-act="cancel">${esc(t('modals.common.cancel'))}</button>
      <button type="button" class="btn-sm btn-accent" data-cal-act="save">${esc(t('calendar.save'))}</button>
    </div>`);
  const $ = (sel) => overlay.querySelector(sel);
  const allDay = $('#cal-ed-allday');
  const error = $('.cal-error');
  const syncAllDay = () => { $('#cal-ed-st').style.display = allDay.checked ? 'none' : ''; $('#cal-ed-et').style.display = allDay.checked ? 'none' : ''; };
  const syncColor = () => overlay.querySelectorAll('.cal-swatch').forEach(b => b.classList.toggle('active', (b.dataset.color || null) === (color || null)));
  allDay.addEventListener('change', syncAllDay);
  // Moving the start forward pulls the end along when it would fall before it.
  $('#cal-ed-sd').addEventListener('change', () => { if ($('#cal-ed-ed').value < $('#cal-ed-sd').value) $('#cal-ed-ed').value = $('#cal-ed-sd').value; });
  overlay.querySelectorAll('.cal-swatch').forEach(b => b.addEventListener('click', () => { color = b.dataset.color || null; syncColor(); }));
  syncAllDay();
  syncColor();
  $('#cal-ed-title').focus();
  $('[data-cal-act="cancel"]').addEventListener('click', close);
  $('[data-cal-act="save"]').addEventListener('click', () => {
    const fail = (msg) => { error.textContent = msg; error.style.display = ''; };
    const sd = $('#cal-ed-sd').value;
    const ed = $('#cal-ed-ed').value || sd;
    if (!$('#cal-ed-title').value.trim()) return fail(t('calendar.need_title'));
    if (!sd) return fail(t('calendar.need_date'));
    const timed = (date, time) => new Date(`${date}T${time || '00:00'}`);
    const start = timed(sd, $('#cal-ed-st').value);
    const end = timed(ed, $('#cal-ed-et').value);
    if (!allDay.checked && (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))) return fail(t('calendar.need_date'));
    const payload = {
      title: $('#cal-ed-title').value,
      allDay: allDay.checked,
      startsAt: allDay.checked ? sd : start.toISOString(),
      endsAt: allDay.checked ? ed : end.toISOString(),
      location: $('#cal-ed-loc').value,
      description: $('#cal-ed-desc').value,
      color,
    };
    const event = ev ? 'calendar-update' : 'calendar-create';
    if (ev) payload.id = ev.id; else payload.code = st.code;
    this.socket.emit(event, payload, (res) => {
      // automod already told the sender why; the dialog stays open.
      if (res && res.blocked) return;
      if (!res || res.error) return fail(res?.error || t('calendar.save_failed'));
      st.events.set(res.event.id, res.event);
      close();
      // Show the month the event is in.
      const at = res.event.allDay ? new Date(`${res.event.startsAt.slice(0, 10)}T00:00`) : new Date(res.event.startsAt);
      if (at.getFullYear() !== st.year || at.getMonth() !== st.month) { st.year = at.getFullYear(); st.month = at.getMonth(); this._calendarLoad(); } else this._calendarDraw();
    });
  });
},

_listenCalendar() {
  // Everyone in the channel gets changes live. The broadcast leaves out
  // anyone's own answer, so the one this device already knows is kept.
  this.socket.on('calendar-changed', (data) => {
    const st = this._calendar;
    if (!data || !data.event || !st || st.code !== data.channelCode) return;
    const old = st.events.get(data.event.id);
    st.events.set(data.event.id, { ...data.event, mine: old ? old.mine : null });
    if (this._channelView === 'calendar' && this.currentChannel === st.code) this._calendarDraw();
  });
  this.socket.on('calendar-removed', (data) => {
    const st = this._calendar;
    if (!data || !st || st.code !== data.channelCode) return;
    st.events.delete(data.id);
    const open = document.querySelector('.cal-modal-overlay');
    if (open && open.dataset.calOpen === String(data.id)) open.remove();
    if (this._channelView === 'calendar' && this.currentChannel === st.code) this._calendarDraw();
  });
},

};
