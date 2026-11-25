(function (root) {
  'use strict';
  const FIRST_AFTER_MS = 8000, SECOND_AFTER_MS = 14000, REPEAT_MS = 15000, MAX_ATTEMPTS = 6;
  const inboundVideo = (report) => { let found = null; report.forEach((s) => { if (s.type === 'inbound-rtp' && (s.kind || s.mediaType) === 'video') found = s; }); return found; };
  class VideoStallWatch {
    constructor({ targets, onStall, intervalMs = 2000, now = Date.now, timers = { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (id) => clearInterval(id) } }) {
      Object.assign(this, { targets, onStall, intervalMs, now, timers, state: new Map(), timer: null, busy: false });
    }
    start() { this.timer = this.timer || this.timers.setInterval(() => this.tick(), this.intervalMs); return this; }
    stop() { this.timers.clearInterval(this.timer); this.timer = null; this.state.clear(); }
    due(level) { return level === 0 ? FIRST_AFTER_MS : level === 1 ? SECOND_AFTER_MS : SECOND_AFTER_MS + (level - 1) * REPEAT_MS; }
    async check(target, at) {
      const track = target.track;
      const report = track && track.readyState === 'live' ? await target.stats().catch(() => null) : null;
      const inbound = report && inboundVideo(report);
      const prev = this.state.get(target.key);
      const frames = inbound ? inbound.framesDecoded || 0 : -1;
      const fresh = !prev || prev.trackId !== track.id || frames !== prev.frames || frames < 0 || (target.hold && target.hold());
      fresh ? this.state.set(target.key, { trackId: track && track.id, frames, since: at, level: 0, played: (prev && prev.played) || frames > 0 }) : null;
      const st = this.state.get(target.key);
      const stalled = !fresh && st.played && st.level < MAX_ATTEMPTS && at - st.since >= this.due(st.level);
      const level = st.level;
      const verdict = stalled ? (st.level += 1, await this.onStall(target, Math.min(level + 1, 2), level + 1)) : null;
      verdict === 'hold' && this.state.set(target.key, { ...st, since: at, level: 0 });
      return stalled;
    }
    async tick() {
      if (this.busy) return [];
      this.busy = true;
      try {
        const at = this.now(), list = this.targets() || [], keys = new Set(list.map((x) => x.key));
        [...this.state.keys()].forEach((k) => keys.has(k) || this.state.delete(k));
        const fired = [];
        for (const target of list) (await this.check(target, at).catch(() => false)) && fired.push(target.key);
        return fired;
      } finally { this.busy = false; }
    }
  }
  root.HavenVideoStall = VideoStallWatch;
  typeof module !== 'undefined' && module.exports && (module.exports = VideoStallWatch);
})(typeof window !== 'undefined' ? window : globalThis);
