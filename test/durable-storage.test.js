'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HistoryStore } = require('../lib/store');
const { Monitor } = require('../lib/monitor');
const { STATUS } = require('../lib/evaluate');

/** In-memory stand-in for DurableObjectStorage's key-value API, enforcing its 128-key limit. */
class FakeStorage {
  constructor() {
    this.data = new Map();
    this.writes = 0;
  }
  async get(keys) {
    return new Map(keys.filter((k) => this.data.has(k)).map((k) => [k, structuredClone(this.data.get(k))]));
  }
  async list({ prefix }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
    return new Map(keys.map((k) => [k, structuredClone(this.data.get(k))]));
  }
  async put(entries) {
    const pairs = Object.entries(entries);
    if (pairs.length > 128) throw new Error('put() accepts at most 128 keys');
    for (const [k, v] of pairs) this.data.set(k, structuredClone(v));
    this.writes += pairs.length;
  }
  async delete(keys) {
    if (keys.length > 128) throw new Error('delete() accepts at most 128 keys');
    for (const k of keys) this.data.delete(k);
    this.writes += keys.length;
  }
}

const MIN = 60_000;
const ev = (overall) => ({
  overall,
  message: overall,
  components: Object.fromEntries(['web', 'api', 'storage', 'resources'].map((id) => [id, { status: overall, message: overall }])),
});
const metrics = { responseMs: 120, apiMs: 300, cpuPercent: 10, memoryPercent: 40, swapPercent: 1, freeBytes: 1e12, activeUsers5m: 2 };
const cfg = { pollIntervalMs: MIN, thresholds: {} };
const newStore = () => new HistoryStore({ timeZone: 'Australia/Brisbane', incidentThreshold: 2, pollIntervalMs: MIN });

test('full save of 7 days batches writes and reloads every sample', async () => {
  const { DurablePersistence } = await import('../src/durable-storage.mjs');
  const storage = new FakeStorage();
  const store = newStore();
  const monitor = new Monitor({ config: cfg, store, client: {} });
  const now = Date.now();
  for (let t = now - 7 * 24 * 60 * MIN + MIN; t <= now; t += 10 * MIN) store.record(t, ev(STATUS.OPERATIONAL), metrics);
  store.record(now + MIN, ev(STATUS.MAJOR), metrics);
  store.record(now + 2 * MIN, ev(STATUS.MAJOR), metrics);
  monitor.infoGate.fail(now, 'Authentication rejected');
  await new DurablePersistence(storage).save(store, monitor, { full: true });

  const chunkCount = [...storage.data.keys()].filter((k) => k.startsWith('s:')).length;
  assert.ok(chunkCount > 128, `expected more than 128 hourly chunks, got ${chunkCount}`);

  const restored = newStore();
  const m2 = new Monitor({ config: cfg, store: restored, client: {} });
  assert.equal(await new DurablePersistence(storage).load(restored, m2), true);
  assert.equal(restored.samples.length, store.samples.length);
  assert.deepEqual(restored.samples, store.samples);
  assert.equal(restored.incidents.length, 1);
  assert.ok(m2.infoGate.isBlocked(now + 1000), 'auth back-off is restored');
});

test('a routine save writes only meta, daily and the current hour', async () => {
  const { DurablePersistence } = await import('../src/durable-storage.mjs');
  const storage = new FakeStorage();
  const store = newStore();
  const monitor = new Monitor({ config: cfg, store, client: {} });
  const p = new DurablePersistence(storage);
  const now = Date.now();
  store.record(now - MIN, ev(STATUS.OPERATIONAL), metrics);
  await p.save(store, monitor);
  storage.writes = 0;
  store.record(now, ev(STATUS.OPERATIONAL), metrics);
  await p.save(store, monitor);
  assert.ok(storage.writes <= 3, `expected at most 3 rows written, got ${storage.writes}`);
});

test('chunks whose samples aged out are deleted', async () => {
  const { DurablePersistence } = await import('../src/durable-storage.mjs');
  const storage = new FakeStorage();
  const store = new HistoryStore({ timeZone: 'UTC', incidentThreshold: 2, pollIntervalMs: MIN, rawRetentionMs: 2 * 60 * MIN });
  const monitor = new Monitor({ config: cfg, store, client: {} });
  const p = new DurablePersistence(storage);
  const t0 = Date.UTC(2026, 9, 20, 0, 30);
  for (let h = 0; h < 5; h += 1) {
    store.record(t0 + h * 60 * MIN, ev(STATUS.OPERATIONAL), metrics);
    await p.save(store, monitor);
  }
  const chunks = [...storage.data.keys()].filter((k) => k.startsWith('s:'));
  assert.equal(chunks.length, store.samples.length, 'one live chunk per remaining hourly sample');
  assert.ok(chunks.length <= 3);
});

test('load returns false on empty storage', async () => {
  const { DurablePersistence } = await import('../src/durable-storage.mjs');
  const store = newStore();
  assert.equal(await new DurablePersistence(new FakeStorage()).load(store, new Monitor({ config: cfg, store, client: {} })), false);
});
