'use strict';

// Runtime-agnostic: persistence lives in lib/persist-file.js (Node) and src/durable-storage.mjs (Workers).
const { STATUS, SEVERITY, CODE, FROM_CODE, COMPONENTS, OVERALL_MESSAGE } = require('./evaluate');

const DAY_MS = 86_400_000;
const STATE_VERSION = 1;
const COMPONENT_IDS = COMPONENTS.map((c) => c.id);
const STATUS_CODES = ['o', 'd', 'p', 'm', 'x', 'u'];
const MIN_MS = 60_000;
/** Chart buckets snap to these "round" intervals. */
const NICE_BUCKETS = [MIN_MS, 2 * MIN_MS, 5 * MIN_MS, 10 * MIN_MS, 15 * MIN_MS, 30 * MIN_MS, 60 * MIN_MS, 120 * MIN_MS, 180 * MIN_MS, 360 * MIN_MS];

const RANGES = Object.freeze({
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
});

function emptyCounts() {
  return { o: 0, d: 0, p: 0, m: 0, x: 0, u: 0 };
}

/** Uptime rule: operational + degraded are "up"; partial + major are "down"; maintenance/unknown are excluded. */
function uptimeFromCounts(c) {
  const up = c.o + c.d;
  const down = c.p + c.m;
  return up + down > 0 ? (up / (up + down)) * 100 : null;
}

function worstCode(counts) {
  let result = 'u';
  for (const code of STATUS_CODES) {
    if (counts[code] > 0 && SEVERITY[FROM_CODE[code]] > SEVERITY[FROM_CODE[result]]) result = code;
  }
  return result;
}

function round(v, digits) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

class HistoryStore {
  /**
   * @param {{timeZone: string, incidentThreshold: number, pollIntervalMs: number,
   *          rawRetentionMs?: number, dailyRetentionDays?: number, maxIncidents?: number}} opts
   */
  constructor(opts) {
    this.timeZone = opts.timeZone;
    this.incidentThreshold = opts.incidentThreshold;
    this.pollIntervalMs = opts.pollIntervalMs;
    this.rawRetentionMs = opts.rawRetentionMs ?? 7 * DAY_MS;
    this.dailyRetentionDays = opts.dailyRetentionDays ?? 90;
    this.maxIncidents = opts.maxIncidents ?? 100;
    this.dateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    this.wallFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    this.reset();
  }

  reset() {
    this.samples = [];
    this.daily = new Map();
    this.incidents = [];
    this.streak = { bad: 0, firstBadAt: null, good: 0, firstGoodAt: null };
    this.latest = null;
    this.dirty = false;
    this.historyCache = new Map();
  }

  // ---------------------------------------------------------------- dates
  dateKey(ts) {
    const parts = this.dateFormatter.formatToParts(new Date(ts));
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  /** Offset (ms) between UTC and wall-clock time in the configured zone. */
  tzOffset(ts) {
    const parts = this.wallFormatter.formatToParts(new Date(ts));
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return wall - Math.floor(ts / 1000) * 1000;
  }

  /** Calendar arithmetic on YYYY-MM-DD keys (immune to DST shifts). */
  static shiftDateKey(key, days) {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + days));
    return date.toISOString().slice(0, 10);
  }

  lastDateKeys(count, now = Date.now()) {
    const today = this.dateKey(now);
    const keys = [];
    for (let i = count - 1; i >= 0; i -= 1) keys.push(HistoryStore.shiftDateKey(today, -i));
    return keys;
  }

  // -------------------------------------------------------------- record
  /**
   * @param {number} ts
   * @param {{overall: string, message: string, components: Record<string, {status: string, message: string}>}} evaluation
   * @param {object} metrics numeric metrics for charts
   */
  record(ts, evaluation, metrics, { intervalMs } = {}) {
    const sample = {
      t: ts,
      s: CODE[evaluation.overall],
      c: Object.fromEntries(COMPONENT_IDS.map((id) => [id, CODE[evaluation.components[id]?.status || STATUS.UNKNOWN]])),
      rt: round(metrics.responseMs, 0),
      at: round(metrics.apiMs, 0),
      cpu: round(metrics.cpuPercent, 1),
      mem: round(metrics.memoryPercent, 1),
      swap: round(metrics.swapPercent, 1),
      free: metrics.freeBytes ?? null,
      au: metrics.activeUsers5m ?? null,
    };
    this.samples.push(sample);
    this.addToDaily(sample, intervalMs ?? this.pollIntervalMs);
    this.trackIncident(ts, evaluation);
    this.prune(ts);
    this.historyCache.clear();
    this.dirty = true;
    return sample;
  }

  addToDaily(sample, intervalMs) {
    const key = this.dateKey(sample.t);
    let bucket = this.daily.get(key);
    if (!bucket) {
      bucket = {
        d: key,
        n: 0,
        iv: Math.round(intervalMs / 1000),
        s: emptyCounts(),
        c: Object.fromEntries(COMPONENT_IDS.map((id) => [id, emptyCounts()])),
        rt: { sum: 0, n: 0, max: 0 },
      };
      this.daily.set(key, bucket);
    }
    bucket.n += 1;
    bucket.s[sample.s] += 1;
    for (const id of COMPONENT_IDS) {
      if (!bucket.c[id]) bucket.c[id] = emptyCounts();
      bucket.c[id][sample.c[id]] += 1;
    }
    if (sample.rt !== null) {
      bucket.rt.sum += sample.rt;
      bucket.rt.n += 1;
      bucket.rt.max = Math.max(bucket.rt.max, sample.rt);
    }
  }

  prune(now) {
    const cutoff = now - this.rawRetentionMs;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop].t < cutoff) drop += 1;
    if (drop) this.samples.splice(0, drop);

    const oldestKey = HistoryStore.shiftDateKey(this.dateKey(now), -(this.dailyRetentionDays - 1));
    for (const key of this.daily.keys()) {
      if (key < oldestKey) this.daily.delete(key);
    }

    const incidentCutoff = now - this.dailyRetentionDays * DAY_MS;
    this.incidents = this.incidents
      .filter((i) => i.endedAt === null || i.endedAt >= incidentCutoff)
      .slice(-this.maxIncidents);
  }

  // ------------------------------------------------------------ incidents
  openIncident() {
    const last = this.incidents[this.incidents.length - 1];
    return last && last.endedAt === null ? last : null;
  }

  trackIncident(ts, evaluation) {
    const { overall } = evaluation;
    if (overall === STATUS.UNKNOWN) return; // no information either way

    const affected = Object.entries(evaluation.components)
      .filter(([, c]) => c.status !== STATUS.OPERATIONAL && c.status !== STATUS.UNKNOWN)
      .map(([id, c]) => ({ id, ...c }));

    let incident = this.openIncident();

    if (overall !== STATUS.OPERATIONAL) {
      if (this.streak.bad === 0) this.streak.firstBadAt = ts;
      this.streak.bad += 1;
      this.streak.good = 0;
      this.streak.firstGoodAt = null;

      if (!incident && this.streak.bad >= this.incidentThreshold) {
        incident = {
          id: `inc-${this.streak.firstBadAt}`,
          status: overall,
          currentStatus: overall,
          startedAt: this.streak.firstBadAt,
          endedAt: null,
          components: [],
          title: '',
          updates: [],
        };
        this.incidents.push(incident);
      }
      if (incident) {
        if (SEVERITY[overall] > SEVERITY[incident.status]) incident.status = overall;
        for (const a of affected) if (!incident.components.includes(a.id)) incident.components.push(a.id);
        incident.title = HistoryStore.incidentTitle(incident);
        const message = affected.map((a) => `${HistoryStore.componentName(a.id)}: ${a.message}`).join(' · ') || OVERALL_MESSAGE[overall];
        const prev = incident.updates[incident.updates.length - 1];
        if (!prev || prev.status !== overall || prev.message !== message) {
          incident.updates.push({ t: prev ? ts : incident.startedAt, status: overall, message });
          if (incident.updates.length > 20) incident.updates.splice(1, incident.updates.length - 20);
        }
        incident.currentStatus = overall;
      }
    } else {
      if (this.streak.good === 0) this.streak.firstGoodAt = ts;
      this.streak.good += 1;
      this.streak.bad = 0;
      this.streak.firstBadAt = null;
      if (incident && this.streak.good >= this.incidentThreshold) {
        incident.endedAt = this.streak.firstGoodAt;
        incident.currentStatus = STATUS.OPERATIONAL;
        incident.updates.push({ t: incident.endedAt, status: STATUS.OPERATIONAL, message: 'All checks are passing again.' });
      }
    }
  }

  static componentName(id) {
    return COMPONENTS.find((c) => c.id === id)?.name || id;
  }

  static incidentTitle(incident) {
    const names = incident.components.map(HistoryStore.componentName);
    const label = incident.status === STATUS.MAINTENANCE ? 'Scheduled maintenance' : OVERALL_MESSAGE[incident.status];
    if (!names.length) return label;
    if (incident.status === STATUS.MAINTENANCE) return label;
    return `${label}: ${names.join(', ')}`;
  }

  // ---------------------------------------------------------------- reads
  /** Uptime % for a component (or 'overall') over a trailing window. */
  uptime(componentId, windowMs, now = Date.now()) {
    const counts = emptyCounts();
    if (windowMs <= this.rawRetentionMs) {
      const from = now - windowMs;
      for (const s of this.samples) {
        if (s.t < from) continue;
        const code = componentId === 'overall' ? s.s : s.c[componentId];
        counts[code] += 1;
      }
    } else {
      const days = Math.round(windowMs / DAY_MS);
      for (const key of this.lastDateKeys(days, now)) {
        const b = this.daily.get(key);
        if (!b) continue;
        const c = componentId === 'overall' ? b.s : b.c[componentId];
        if (!c) continue;
        for (const code of STATUS_CODES) counts[code] += c[code];
      }
    }
    return uptimeFromCounts(counts);
  }

  /** Per-day series for the uptime bars. */
  dailySeries(componentId, days = 90, now = Date.now()) {
    return this.lastDateKeys(days, now).map((key) => {
      const b = this.daily.get(key);
      const c = b ? (componentId === 'overall' ? b.s : b.c[componentId]) : null;
      if (!c) return { date: key, status: null, uptime: null, checks: 0, counts: null, intervalSeconds: null };
      const checks = STATUS_CODES.reduce((sum, code) => sum + c[code], 0);
      const worstStatus = worstCode(c);
      return {
        date: key,
        status: worstStatus === 'u' ? STATUS.UNKNOWN : FROM_CODE[worstStatus],
        uptime: uptimeFromCounts(c),
        checks,
        counts: {
          operational: c.o, degraded: c.d, partial_outage: c.p, major_outage: c.m, maintenance: c.x, unknown: c.u,
        },
        intervalSeconds: b.iv,
        avgResponseMs: componentId === 'web' && b.rt.n ? Math.round(b.rt.sum / b.rt.n) : undefined,
      };
    });
  }

  /** Downsampled time series for charts. */
  history(range, now = Date.now(), maxPoints = 180) {
    const rangeMs = RANGES[range];
    if (!rangeMs) throw new Error(`Unknown range "${range}"`);
    const minBucket = Math.max(rangeMs / maxPoints, this.pollIntervalMs);
    const bucketMs = NICE_BUCKETS.find((b) => b >= minBucket) || Math.ceil(minBucket / MIN_MS) * MIN_MS;
    // Align bucket edges to the local wall clock (matters for half-hour zones such as Adelaide).
    const offset = this.tzOffset(now);
    const end = Math.floor((now + offset) / bucketMs) * bucketMs - offset + bucketMs;
    const start = end - Math.ceil(rangeMs / bucketMs) * bucketMs;
    const cacheKey = `${range}:${end}:${this.samples.length}:${this.samples[this.samples.length - 1]?.t}`;
    const cached = this.historyCache.get(cacheKey);
    if (cached) return cached;

    const count = Math.round((end - start) / bucketMs);
    const acc = Array.from({ length: count }, () => ({
      rt: [0, 0], rtMax: null, at: [0, 0], cpu: [0, 0], mem: [0, 0], swap: [0, 0], free: null, au: null, s: null, n: 0,
    }));
    const add = (pair, v) => { if (v !== null && v !== undefined) { pair[0] += v; pair[1] += 1; } };

    for (const s of this.samples) {
      if (s.t < start || s.t >= end) continue;
      const a = acc[Math.floor((s.t - start) / bucketMs)];
      a.n += 1;
      add(a.rt, s.rt);
      if (s.rt !== null) a.rtMax = Math.max(a.rtMax ?? 0, s.rt);
      add(a.at, s.at);
      add(a.cpu, s.cpu);
      add(a.mem, s.mem);
      add(a.swap, s.swap);
      if (s.free !== null) a.free = s.free; // latest value in bucket
      if (s.au !== null) a.au = Math.max(a.au ?? 0, s.au);
      if (a.s === null || SEVERITY[FROM_CODE[s.s]] > SEVERITY[FROM_CODE[a.s]]) a.s = s.s;
    }

    const avg = (pair, digits) => (pair[1] ? round(pair[0] / pair[1], digits) : null);
    const points = acc.map((a, i) => ({
      t: start + i * bucketMs,
      n: a.n,
      status: a.s ? FROM_CODE[a.s] : null,
      responseMs: avg(a.rt, 0),
      responseMaxMs: a.rtMax,
      apiMs: avg(a.at, 0),
      cpuPercent: avg(a.cpu, 1),
      memoryPercent: avg(a.mem, 1),
      swapPercent: avg(a.swap, 1),
      freeBytes: a.free,
      activeUsers: a.au,
    }));

    const result = { range, from: start, to: end, bucketMs, points };
    this.historyCache.set(cacheKey, result);
    if (this.historyCache.size > 16) this.historyCache.delete(this.historyCache.keys().next().value);
    return result;
  }

  /** Response-time statistics from raw samples. */
  responseStats(windowMs, now = Date.now()) {
    const values = [];
    for (const s of this.samples) if (s.t >= now - windowMs && s.rt !== null) values.push(s.rt);
    if (!values.length) return null;
    values.sort((a, b) => a - b);
    const q = (p) => values[Math.min(values.length - 1, Math.max(0, Math.ceil((p / 100) * values.length) - 1))];
    return {
      avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
      p50: q(50),
      p95: q(95),
      max: values[values.length - 1],
      count: values.length,
    };
  }

  // ---------------------------------------------------------- persistence
  /** Plain-object snapshot of everything worth persisting. */
  exportState() {
    return {
      version: STATE_VERSION,
      savedAt: Date.now(),
      samples: this.samples,
      daily: [...this.daily.values()],
      incidents: this.incidents,
      streak: this.streak,
      latest: this.latest,
    };
  }

  /**
   * Restore from exportState() output. Throws on an incompatible or malformed
   * snapshot so the caller can decide what to do with it.
   */
  importState(data, now = Date.now()) {
    if (!data || typeof data !== 'object') throw new Error('state is not an object');
    if (data.version !== STATE_VERSION) throw new Error(`unsupported state version ${data.version}`);
    this.samples = Array.isArray(data.samples) ? data.samples.filter((s) => Number.isFinite(s?.t)) : [];
    this.samples.sort((a, b) => a.t - b.t);
    this.daily = new Map((Array.isArray(data.daily) ? data.daily : []).filter((b) => b && b.d).map((b) => [b.d, b]));
    this.incidents = Array.isArray(data.incidents) ? data.incidents : [];
    this.streak = { bad: 0, firstBadAt: null, good: 0, firstGoodAt: null, ...(data.streak && typeof data.streak === 'object' ? data.streak : {}) };
    this.latest = data.latest || null;
    this.historyCache.clear();
    this.prune(now);
    this.dirty = false;
  }
}

module.exports = { HistoryStore, RANGES, DAY_MS, STATE_VERSION, uptimeFromCounts };
