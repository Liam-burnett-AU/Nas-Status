'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseServerInfo, normaliseStatusPhp } = require('../lib/normalise');
const { serverInfoPayload } = require('./helpers/mock-nextcloud');

const GIB = 1024 ** 3;

test('converts KiB memory figures to bytes and computes usage', () => {
  const n = normaliseServerInfo(serverInfoPayload());
  assert.equal(n.memory.totalBytes, 8 * GIB);
  assert.equal(n.memory.availableBytes, 2 * GIB);
  assert.equal(n.memory.usedBytes, 6 * GIB);
  assert.equal(n.memory.percent, 75);
  assert.equal(n.swap.totalBytes, GIB);
  assert.equal(n.swap.percent, 0);
});

test('CPU percent is the 1-minute load average per thread', () => {
  const n = normaliseServerInfo(serverInfoPayload());
  assert.equal(n.cpu.cores, 4);
  assert.equal(n.cpu.load1, 1);
  assert.equal(n.cpu.percent, 25);
});

test('treats -1, false and null sentinels as unknown', () => {
  const n = normaliseServerInfo(serverInfoPayload({
    system: { mem_total: -1, mem_free: -1, swap_total: -1, swap_free: -1, cpuload: false, cpunum: 0, freespace: null },
  }));
  assert.equal(n.memory.totalBytes, null);
  assert.equal(n.memory.percent, null);
  assert.equal(n.swap.totalBytes, null);
  assert.equal(n.cpu.percent, null);
  assert.equal(n.cpu.load1, null);
  assert.equal(n.disk.freeBytes, null);
});

test('zero swap is reported as "none", not unknown', () => {
  const n = normaliseServerInfo(serverInfoPayload({ system: { swap_total: 0, swap_free: 0 } }));
  assert.equal(n.swap.totalBytes, 0);
  assert.equal(n.swap.percent, null);
});

test('matches the data volume from diskdata by free space', () => {
  const n = normaliseServerInfo(serverInfoPayload(), { diskData: [[20.5, 79.5], [524.3, 500.0]] });
  assert.equal(n.disk.volumes.length, 2);
  assert.equal(n.disk.dataVolumeIndex, 1);
  assert.ok(Math.abs(n.disk.totalBytes - 1024.3 * GIB) < 1);
  assert.ok(Math.abs(n.disk.percent - (524.3 / 1024.3) * 100) < 0.01);
});

test('does not guess a data volume when nothing matches', () => {
  const n = normaliseServerInfo(serverInfoPayload(), { diskData: [[10, 20], [30, 40]] });
  assert.equal(n.disk.dataVolumeIndex, null);
  assert.equal(n.disk.totalBytes, null);
  assert.equal(n.disk.percent, null);
});

test('handles PHP empty arrays for app_updates, opcache and apcu', () => {
  const n = normaliseServerInfo(serverInfoPayload());
  assert.deepEqual(n.apps.updates, []);
  assert.equal(n.apps.installed, 50);
  assert.equal(n.caching.opcache, null);
  assert.equal(n.caching.apcu, null);
});

test('reads app updates from an object map, sorted', () => {
  const n = normaliseServerInfo(serverInfoPayload({ system: { apps: { num_installed: 3, num_updates_available: 2, app_updates: { photos: '4.0.1', calendar: '5.5.3' } } } }));
  assert.deepEqual(n.apps.updates, [{ id: 'calendar', version: '5.5.3' }, { id: 'photos', version: '4.0.1' }]);
});

test('never copies PHP-FPM process details (request URIs)', () => {
  const n = normaliseServerInfo(serverInfoPayload());
  assert.equal(n.fpm.totalProcesses, 4);
  assert.ok(!JSON.stringify(n).includes('secret'));
  assert.ok(!('procs' in n.fpm));
});

test('simplifies memcache class names and parses numeric strings', () => {
  const n = normaliseServerInfo(serverInfoPayload());
  assert.equal(n.caching.local, 'APCu');
  assert.equal(n.caching.distributed, null);
  assert.equal(n.caching.locking, 'Redis');
  assert.equal(n.server.dbSizeBytes, 123456789);
  assert.equal(n.update.available, true);
  assert.equal(n.update.availableVersion, '30.0.5');
  assert.equal(n.update.lastCheckedAt, 1_760_000_000_000);
});

test('opcache and apcu hit rates', () => {
  const info = serverInfoPayload();
  info.server.php.opcache = { opcache_enabled: true, memory_usage: { used_memory: 60, free_memory: 30, wasted_memory: 10 }, opcache_statistics: { opcache_hit_rate: 99.5, num_cached_scripts: 10 } };
  info.server.php.apcu = { cache: { num_hits: 90, num_misses: 10, num_entries: 5 }, sma: { num_seg: 1, seg_size: 100, avail_mem: 25 } };
  const n = normaliseServerInfo(info);
  assert.equal(n.caching.opcache.hitRate, 99.5);
  assert.equal(n.caching.opcache.memoryPercent, 70);
  assert.equal(n.caching.apcu.hitRate, 90);
  assert.equal(n.caching.apcu.memoryPercent, 75);
});

test('survives a completely empty payload', () => {
  const n = normaliseServerInfo({});
  assert.equal(n.cpu.percent, null);
  assert.equal(n.storage.users, null);
  assert.equal(n.apps, null);
});

test('status.php normalisation', () => {
  const s = normaliseStatusPhp({ installed: true, maintenance: true, needsDbUpgrade: false, version: '30.0.4.1', versionstring: '30.0.4', productname: 'Nextcloud' });
  assert.equal(s.maintenance, true);
  assert.equal(s.versionString, '30.0.4');
});
