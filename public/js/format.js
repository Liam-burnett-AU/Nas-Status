/* Formatting helpers (Australian English, en-AU locale). */
(function () {
  'use strict';

  const LOCALE = 'en-AU';
  let timeZone; // undefined = viewer's own time zone
  const cache = new Map();

  function dtf(opts) {
    const key = JSON.stringify(opts) + '|' + timeZone;
    let f = cache.get(key);
    if (!f) {
      f = new Intl.DateTimeFormat(LOCALE, timeZone ? { ...opts, timeZone } : opts);
      cache.set(key, f);
    }
    return f;
  }

  const numberFmt = new Intl.NumberFormat(LOCALE);
  const compactFmt = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });

  const F = {
    setTimeZone(tz) {
      try {
        new Intl.DateTimeFormat(LOCALE, { timeZone: tz });
        timeZone = tz;
      } catch {
        timeZone = undefined;
      }
      cache.clear();
    },

    getTimeZone() {
      return timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    },

    /** Milliseconds to add to a UTC timestamp to get wall-clock time in the active zone. */
    tzOffset(ts) {
      const parts = dtf({
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(ts));
      const get = (type) => Number(parts.find((p) => p.type === type).value);
      const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
      return wall - Math.floor(ts / 1000) * 1000;
    },

    zoneName(ts = Date.now()) {
      const part = dtf({ timeZoneName: 'short' }).formatToParts(new Date(ts)).find((p) => p.type === 'timeZoneName');
      return part ? part.value : F.getTimeZone();
    },

    number(v) {
      return v === null || v === undefined || !Number.isFinite(v) ? '—' : numberFmt.format(v);
    },

    compact(v) {
      if (v === null || v === undefined || !Number.isFinite(v)) return '—';
      return Math.abs(v) < 10000 ? numberFmt.format(v) : compactFmt.format(v);
    },

    percent(v, digits = 0) {
      if (v === null || v === undefined || !Number.isFinite(v)) return '—';
      return `${v.toFixed(digits)}%`;
    },

    /** Uptime is floored so 99.996% never displays as a misleading 100.00%. */
    uptime(v) {
      if (v === null || v === undefined || !Number.isFinite(v)) return '—';
      if (v >= 100) return '100%';
      return `${(Math.floor(v * 100) / 100).toFixed(2)}%`;
    },

    /** Binary units, labelled the way Nextcloud labels them (GB = 1024³ bytes). */
    bytes(b) {
      if (b === null || b === undefined || !Number.isFinite(b)) return '—';
      const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
      let i = 0;
      let v = Math.abs(b);
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
      }
      const digits = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
      return `${b < 0 ? '-' : ''}${v.toFixed(digits)} ${units[i]}`;
    },

    ms(v) {
      if (v === null || v === undefined || !Number.isFinite(v)) return '—';
      return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
    },

    seconds(v) {
      if (v === null || v === undefined || !Number.isFinite(v)) return '—';
      if (v === 0) return 'Unlimited';
      if (v % 3600 === 0) return `${v / 3600} h`;
      if (v % 60 === 0) return `${v / 60} min`;
      return `${v} s`;
    },

    duration(ms) {
      if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return `${s} s`;
      const m = Math.round(s / 60);
      if (m < 60) return `${m} min`;
      const h = Math.floor(m / 60);
      if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
      const d = Math.floor(h / 24);
      return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
    },

    relative(ts, now = Date.now()) {
      if (!ts) return 'never';
      const diff = Math.round((now - ts) / 1000);
      if (diff < 5) return 'just now';
      if (diff < 60) return `${diff} s ago`;
      if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
      if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
      return F.dateTime(ts);
    },

    time(ts) {
      return dtf({ hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
    },

    hour(ts) {
      return dtf({ hour: 'numeric' }).format(new Date(ts));
    },

    dayShort(ts) {
      return dtf({ weekday: 'short', day: 'numeric' }).format(new Date(ts));
    },

    dateTime(ts, { year = false } = {}) {
      const opts = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
      if (year) opts.year = 'numeric';
      return dtf(opts).format(new Date(ts));
    },

    fullDateTime(ts) {
      return dtf({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(ts));
    },

    /** Format a YYYY-MM-DD calendar key (already in the site's zone). */
    dateKey(key, { weekday = true } = {}) {
      const [y, m, d] = key.split('-').map(Number);
      const opts = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
      if (weekday) opts.weekday = 'short';
      return new Intl.DateTimeFormat(LOCALE, opts).format(new Date(Date.UTC(y, m - 1, d)));
    },
  };

  window.NasFormat = F;
})();
