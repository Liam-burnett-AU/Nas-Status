// Persists a HistoryStore in a SQLite-backed Durable Object's key-value storage.
//
// Layout (keeps every value far below the 2 MB per-value limit):
//   meta          incidents, streak, latest snapshot, monitor back-off state
//   daily         90 daily summary buckets
//   s:<hour>      raw checks for one UTC hour (about 60 per key at a 1-minute interval)
//
// After each check only meta, daily and the current hour's chunk are written,
// which is about 3 rows written per check.

const SAMPLE_PREFIX = 's:';
const HOUR_MS = 3_600_000;
const MAX_KEYS_PER_CALL = 128; // Durable Object storage limit for multi-key put()/delete()

export function chunkKey(t) {
  return SAMPLE_PREFIX + String(Math.floor(t / HOUR_MS)).padStart(10, '0');
}

function batches(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class DurablePersistence {
  /** @param {DurableObjectStorage} storage */
  constructor(storage) {
    this.storage = storage;
    this.knownChunks = new Set();
  }

  /** Restore into the store and monitor. Returns false when nothing is saved yet. */
  async load(store, monitor) {
    const [fixed, chunks] = await Promise.all([
      this.storage.get(['meta', 'daily']),
      this.storage.list({ prefix: SAMPLE_PREFIX }),
    ]);
    const meta = fixed.get('meta');
    this.knownChunks = new Set(chunks.keys());
    if (!meta) return false;
    const samples = [];
    for (const value of chunks.values()) if (Array.isArray(value)) samples.push(...value);
    store.importState({ ...meta, daily: fixed.get('daily') || [], samples });
    if (meta.monitor) monitor.importState(meta.monitor);
    return true;
  }

  /**
   * @param {{full?: boolean}} opts full=true rewrites every chunk (used after a demo backfill)
   */
  async save(store, monitor, { full = false } = {}) {
    const { samples, daily, ...meta } = store.exportState();
    meta.monitor = monitor.exportState();

    const byChunk = new Map();
    for (const s of samples) {
      const key = chunkKey(s.t);
      let list = byChunk.get(key);
      if (!list) byChunk.set(key, (list = []));
      list.push(s);
    }

    const entries = { meta, daily };
    if (full) {
      for (const [key, list] of byChunk) entries[key] = list;
    } else if (samples.length) {
      const key = chunkKey(samples[samples.length - 1].t);
      entries[key] = byChunk.get(key);
    }

    const pairs = Object.entries(entries);
    for (const batch of batches(pairs, MAX_KEYS_PER_CALL)) {
      await this.storage.put(Object.fromEntries(batch));
    }
    for (const [key] of pairs) if (key.startsWith(SAMPLE_PREFIX)) this.knownChunks.add(key);

    // Remove chunks whose samples have all aged out of the retention window.
    const stale = [...this.knownChunks].filter((key) => !byChunk.has(key));
    for (const batch of batches(stale, MAX_KEYS_PER_CALL)) {
      await this.storage.delete(batch);
    }
    for (const key of stale) this.knownChunks.delete(key);
    store.dirty = false;
  }
}
