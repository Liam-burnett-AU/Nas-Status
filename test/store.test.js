'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HistoryStore, DAY_MS } = require('../lib/store');
const { FilePersistence } = require('../lib/persist-file');
const { Monitor } = require('../lib/monitor');
const { STATUS } = require('../lib/evaluate');

const MIN = 60_000;
const ev = (overall, web = overall) => ({
  overall,
  message: overall,
  components: {
    web: { status: web, message: `web ${web}` },
    api: { status: STATUS.OPERATIONAL, message: 'ok' },
    storage: { status: STATUS.OPERATIONAL, message: 'ok' },
    resources: { status: STATUS.OPERATIONAL, message: 'ok' },
  },
});
const metrics = { responseMs: 100, apiMs: 200, cpuPercent: 10, memoryPercent: 50, swapPercent: 0, freeBytes: 1e12, activeUsers5m: 1 };
const newStore = (opts = {}) => new HistoryStore({ timeZone: 'Australia/Brisbane', incidentThreshold: 2, pollIntervalMs: MIN, ...opts });

test('a single bad check does not open an incident; two do', () => {
  const s = newStore();
  const t0 = Date.UTC(2026, 9, 20, 0, 0);
  s.record(t0, ev(STATUS.OPERATIONAL), metrics);
  s.record(t0 + MIN, ev(STATUS.MAJOR), metrics);
  s.record(t0 + 2 * MIN, ev(STATUS.OPERATIONAL), metrics);
  assert.equal(s.incidents.length, 0);
  s.record(t0 + 3 * MIN, ev(STATUS.MAJOR), metrics);
  s.record(t0 + 4 * MIN, ev(STATUS.MAJOR), metrics);
  assert.equal(s.incidents.length, 1);
  assert.equal(s.incidents[0].startedAt, t0 + 3 * MIN);
  assert.equal(s.incidents[0].endedAt, null);
  assert.deepEqual(s.incidents[0].components, ['web']);
});

test('incident resolves after consecutive good checks, at the first good check', () => {
  const s = newStore();
  const t0 = Date.UTC(2026, 9, 20, 0, 0);
  s.record(t0, ev(STATUS.MAJOR), metrics);
  s.record(t0 + MIN, ev(STATUS.MAJOR), metrics);
  s.record(t0 + 2 * MIN, ev(STATUS.OPERATIONAL), metrics);
  assert.equal(s.incidents[0].endedAt, null);
  s.record(t0 + 3 * MIN, ev(STATUS.OPERATIONAL), metrics);
  assert.equal(s.incidents[0].endedAt, t0 + 2 * MIN);
  assert.equal(s.incidents[0].status, STATUS.MAJOR);
  assert.equal(s.incidents[0].currentStatus, STATUS.OPERATIONAL);
});

test('incident escalates to the worst status seen and logs updates', () => {
  const s = newStore();
  const t0 = Date.UTC(2026, 9, 20, 0, 0);
  s.record(t0, ev(STATUS.DEGRADED), metrics);
  s.record(t0 + MIN, ev(STATUS.DEGRADED), metrics);
  s.record(t0 + 2 * MIN, ev(STATUS.MAJOR), metrics);
  assert.equal(s.incidents[0].status, STATUS.MAJOR);
  assert.equal(s.incidents[0].updates.length, 2);
  assert.match(s.incidents[0].title, /^Major outage/);
});

test('unknown evaluations neither open nor close incidents', () => {
  const s = newStore();
  const t0 = Date.UTC(2026, 9, 20, 0, 0);
  s.record(t0, ev(STATUS.MAJOR), metrics);
  s.record(t0 + MIN, ev(STATUS.UNKNOWN), metrics);
  s.record(t0 + 2 * MIN, ev(STATUS.MAJOR), metrics);
  assert.equal(s.incidents.length, 1);
});

test('uptime counts degraded as up, outages as down, excludes maintenance', () => {
  const s = newStore();
  const now = Date.UTC(2026, 9, 20, 12, 0);
  const seq = [STATUS.OPERATIONAL, STATUS.DEGRADED, STATUS.MAJOR, STATUS.MAINTENANCE, STATUS.OPERATIONAL];
  seq.forEach((st, i) => s.record(now - (seq.length - i) * MIN, ev(st), metrics));
  assert.equal(s.uptime('web', DAY_MS, now), 75);
});

test('daily buckets use local calendar days in the configured zone', () => {
  const s = newStore();
  // 23:30 UTC on 20 Oct is 09:30 on 21 Oct in Brisbane (UTC+10).
  s.record(Date.UTC(2026, 9, 20, 23, 30), ev(STATUS.OPERATIONAL), metrics);
  assert.ok(s.daily.has('2026-10-21'));
  const series = s.dailySeries('web', 90, Date.UTC(2026, 9, 20, 23, 31));
  assert.equal(series.length, 90);
  assert.equal(series[89].date, '2026-10-21');
  assert.equal(series[89].status, STATUS.OPERATIONAL);
  assert.equal(series[0].date, '2026-07-24');
  assert.equal(series[0].status, null);
});

test('date key arithmetic is calendar-based (DST safe)', () => {
  assert.equal(HistoryStore.shiftDateKey('2026-03-01', -1), '2026-02-28');
  assert.equal(HistoryStore.shiftDateKey('2024-03-01', -1), '2024-02-29');
  assert.equal(HistoryStore.shiftDateKey('2026-01-01', -1), '2025-12-31');
});

test('history buckets average values and keep gaps as null', () => {
  const s = newStore();
  const now = Date.UTC(2026, 9, 20, 12, 0, 30);
  s.record(now - 10 * MIN, ev(STATUS.OPERATIONAL), { ...metrics, responseMs: 100 });
  s.record(now - 5 * MIN, ev(STATUS.DEGRADED), { ...metrics, responseMs: 300 });
  const h = s.history('1h', now);
  assert.equal(h.bucketMs, MIN);
  assert.equal(h.points.length, 60);
  assert.ok(h.from <= now && now < h.to);
  const filled = h.points.filter((p) => p.n > 0);
  assert.deepEqual(filled.map((p) => p.responseMs), [100, 300]);
  assert.equal(filled[1].status, STATUS.DEGRADED);
  assert.equal(h.points.filter((p) => p.responseMs === null).length, 58);
  const day = s.history('24h', now);
  assert.equal(day.bucketMs, 10 * MIN);
  const week = s.history('7d', now);
  assert.equal(week.bucketMs, 60 * MIN);
});

test('prunes raw samples older than the retention window', () => {
  const s = newStore({ rawRetentionMs: 60 * MIN });
  const now = Date.UTC(2026, 9, 20, 12, 0);
  s.record(now - 2 * 60 * MIN, ev(STATUS.OPERATIONAL), metrics);
  s.record(now, ev(STATUS.OPERATIONAL), metrics);
  assert.equal(s.samples.length, 1);
});

test('persists atomically and reloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-status-'));
  const file = path.join(dir, 'history.json');
  const p = new FilePersistence(file);
  const s = newStore();
  const now = Date.now();
  s.record(now - MIN, ev(STATUS.MAJOR), metrics);
  s.record(now, ev(STATUS.MAJOR), metrics);
  s.latest = { checkedAt: now };
  const cfg = { pollIntervalMs: MIN, thresholds: {} };
  const m = new Monitor({ config: cfg, store: s, client: {} });
  m.infoGate.fail(now, 'Authentication rejected');
  p.save(s, m);
  const t = newStore();
  const m2 = new Monitor({ config: cfg, store: t, client: {} });
  assert.equal(p.load(t, m2), true);
  assert.ok(m2.infoGate.isBlocked(now + 1000), 'auth back-off survives a restart');
  assert.equal(t.samples.length, 2);
  assert.equal(t.incidents.length, 1);
  assert.equal(t.latest.checkedAt, now);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('a corrupt history file is moved aside instead of crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-status-'));
  const file = path.join(dir, 'history.json');
  fs.writeFileSync(file, '{not json');
  const s = newStore();
  assert.equal(new FilePersistence(file).load(s), false);
  assert.equal(s.samples.length, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')));
  fs.rmSync(dir, { recursive: true });
});
