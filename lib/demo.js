'use strict';

const { NextcloudError } = require('./nextcloud');

const GIB_IN_KIB = 1024 * 1024;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Small deterministic PRNG so the demo looks the same on every start. */
function hashNoise(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Smooth noise in [0,1) for a timestamp, varying over `periodMs`. */
function smooth(t, periodMs, seed) {
  const i = Math.floor(t / periodMs);
  const f = (t % periodMs) / periodMs;
  const a = hashNoise(i * 7919 + seed);
  const b = hashNoise((i + 1) * 7919 + seed);
  const s = f * f * (3 - 2 * f);
  return a + (b - a) * s;
}

/** 0..1 activity curve peaking mid-afternoon, quiet overnight (local to the demo). */
function dayCycle(t, tzOffsetMs) {
  const hour = (((t + tzOffsetMs) % DAY) + DAY) % DAY / HOUR;
  return Math.max(0, Math.sin(((hour - 7) / 16) * Math.PI)) ** 1.4;
}

/**
 * A fake Nextcloud client with the same interface as NextcloudClient.
 * Returns payloads shaped exactly like the real serverinfo API.
 */
class DemoClient {
  constructor({ anchor = Date.now(), timeZone = 'UTC' } = {}) {
    this.anchor = anchor;
    this.canReadServerInfo = true;
    this.canReadAdminEndpoints = true;
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date(anchor));
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    const m = /GMT([+-]\d+)(?::(\d+))?/.exec(tzName);
    this.tzOffsetMs = m ? (Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0)) * MIN : 0;

    // Scripted events, relative to the anchor so the demo always has a story.
    const at = (daysAgo, hour, minute) => {
      const dayStart = Math.floor((anchor + this.tzOffsetMs) / DAY) * DAY - this.tzOffsetMs;
      return dayStart - daysAgo * DAY + hour * HOUR + minute * MIN;
    };
    this.events = [
      { kind: 'down', from: at(3, 2, 10), to: at(3, 2, 24) },
      { kind: 'slow', from: at(12, 14, 5), to: at(12, 14, 47) },
      { kind: 'maintenance', from: at(27, 1, 0), to: at(27, 1, 26) },
      // Older events are sampled every 10 minutes, so they must span several checks.
      { kind: 'api500', from: at(55, 9, 30), to: at(55, 10, 5) },
      { kind: 'slow', from: at(71, 19, 10), to: at(71, 19, 55) },
      { kind: 'down', from: at(84, 4, 0), to: at(84, 4, 32) },
    ];
  }

  eventAt(t) {
    return this.events.find((e) => t >= e.from && t < e.to)?.kind || null;
  }

  responseMs(t) {
    const base = 95 + 70 * dayCycle(t, this.tzOffsetMs) + 40 * smooth(t, 20 * MIN, 1);
    const spike = hashNoise(Math.floor(t / MIN)) > 0.985 ? 300 + 500 * hashNoise(Math.floor(t / MIN) + 3) : 0;
    const event = this.eventAt(t) === 'slow' ? 1500 + 1300 * smooth(t, 4 * MIN, 9) : 0;
    return Math.round(base + spike + event);
  }

  async getStatus(t = Date.now()) {
    const event = this.eventAt(t);
    if (event === 'down') throw new NextcloudError(`No response within 10 s`, { kind: 'timeout' });
    return {
      elapsedMs: this.responseMs(t),
      data: {
        installed: true,
        maintenance: event === 'maintenance',
        needsDbUpgrade: false,
        version: '31.0.9.1',
        versionstring: '31.0.9',
        edition: '',
        productname: 'Nextcloud',
        extendedSupport: false,
      },
    };
  }

  diskUsedGiB(t) {
    // ~2.38 TiB used, growing about 1.1 GiB a day with some churn.
    return 2440 + ((t - this.anchor) / DAY) * 1.1 + 6 * smooth(t, 6 * HOUR, 4);
  }

  async getServerInfo(t = Date.now()) {
    const event = this.eventAt(t);
    if (event === 'down') throw new NextcloudError('No response within 10 s', { kind: 'timeout' });
    if (event === 'maintenance') throw new NextcloudError('Service unavailable (HTTP 503)', { kind: 'http', status: 503 });
    if (event === 'api500') throw new NextcloudError('HTTP 500', { kind: 'http', status: 500 });

    const activity = dayCycle(t, this.tzOffsetMs);
    const cores = 8;
    const load1 = cores * (0.06 + 0.32 * activity + 0.18 * smooth(t, 9 * MIN, 2));
    const load5 = cores * (0.06 + 0.3 * activity + 0.12 * smooth(t, 25 * MIN, 2));
    const load15 = cores * (0.06 + 0.28 * activity + 0.08 * smooth(t, 60 * MIN, 2));
    const memTotalKiB = 32 * GIB_IN_KIB;
    const memUsedFraction = 0.46 + 0.16 * activity + 0.06 * smooth(t, 30 * MIN, 5);
    const swapTotalKiB = 4 * GIB_IN_KIB;
    const swapUsedFraction = 0.04 + 0.05 * smooth(t, 3 * HOUR, 6);
    const totalGiB = 3726;
    const usedGiB = this.diskUsedGiB(t);
    const freeBytes = Math.round((totalGiB - usedGiB) * 1024 ** 3);
    const users5m = Math.round(5 * activity * smooth(t, 7 * MIN, 8));

    return {
      elapsedMs: Math.round(this.responseMs(t) * 2.1 + 120),
      data: {
        nextcloud: {
          system: {
            version: '31.0.9.1',
            theme: '',
            enable_avatars: 'yes',
            enable_previews: 'yes',
            'memcache.local': '\\OC\\Memcache\\APCu',
            'memcache.distributed': '\\OC\\Memcache\\Redis',
            'filelocking.enabled': 'yes',
            'memcache.locking': '\\OC\\Memcache\\Redis',
            debug: 'no',
            freespace: freeBytes,
            cpuload: [load1, load5, load15],
            cpunum: cores,
            mem_total: memTotalKiB,
            mem_free: Math.round(memTotalKiB * (1 - memUsedFraction)),
            swap_total: swapTotalKiB,
            swap_free: Math.round(swapTotalKiB * (1 - swapUsedFraction)),
            apps: {
              num_installed: 64,
              num_updates_available: 2,
              app_updates: { calendar: '5.5.3', photos: '4.0.1' },
            },
            update: { lastupdatedat: Math.floor((t - 3 * HOUR) / 1000), available: false },
          },
          storage: {
            num_users: 12,
            num_disabled_users: 1,
            num_files: 1_284_391 + Math.round(((t - this.anchor) / DAY) * 820),
            num_storages: 19,
            num_storages_local: 2,
            num_storages_home: 12,
            num_storages_other: 5,
            size_appdata_storage: 18.6 * 1024 ** 3,
            num_files_appdata: 96_412,
          },
          shares: {
            num_shares: 187,
            num_shares_user: 74,
            num_shares_groups: 21,
            num_shares_link: 63,
            num_shares_mail: 9,
            num_shares_room: 14,
            num_shares_link_no_password: 17,
            num_fed_shares_sent: 6,
            num_fed_shares_received: 3,
          },
        },
        server: {
          webserver: 'Apache/2.4.62 (Debian)',
          php: {
            version: '8.3.14',
            memory_limit: 1024 * 1024 ** 2,
            max_execution_time: 3600,
            upload_max_filesize: 16 * 1024 ** 3,
            opcache_revalidate_freq: 60,
            opcache: {
              opcache_enabled: true,
              memory_usage: { used_memory: 141 * 1024 ** 2, free_memory: 107 * 1024 ** 2, wasted_memory: 8 * 1024 ** 2 },
              opcache_statistics: { num_cached_scripts: 7412, hits: 98_412_331, misses: 7_420, opcache_hit_rate: 99.9924 },
            },
            apcu: {
              cache: { num_slots: 4099, num_hits: 18_440_120, num_misses: 412_876, num_entries: 6_731 },
              sma: { num_seg: 1, seg_size: 128 * 1024 ** 2, avail_mem: 71 * 1024 ** 2 },
            },
            extensions: new Array(52).fill('ext'),
          },
          fpm: false,
          database: { type: 'pgsql', version: '16.6', size: 2.73 * 1024 ** 3 },
        },
        activeUsers: {
          last5minutes: users5m,
          last1hour: Math.max(users5m, Math.round(7 * activity)),
          last24hours: 10,
          last7days: 11,
          last1month: 12,
          last3months: 12,
          last6months: 13,
          lastyear: 13,
        },
      },
    };
  }

  async getDiskData(t = Date.now()) {
    const usedGiB = this.diskUsedGiB(t);
    return [
      [Math.round(38.4 * 10) / 10, Math.round(193.2 * 10) / 10],
      [Math.round(usedGiB * 10) / 10, Math.round((3726 - usedGiB) * 10) / 10],
    ];
  }

  async getBasicData(t = Date.now()) {
    const uptimeS = Math.floor((t - (this.anchor - 41 * DAY - 5 * HOUR - 17 * MIN)) / 1000);
    const d = Math.floor(uptimeS / 86400);
    const h = Math.floor((uptimeS % 86400) / 3600);
    const m = Math.floor((uptimeS % 3600) / 60);
    const s = uptimeS % 60;
    return {
      servertime: new Date(t).toString(),
      uptime: `${d} days, ${h} hours, ${m} minutes, ${s} seconds`,
      thermalzones: [
        { zone: 'thermal_zone0', type: 'x86_pkg_temp', temp: Math.round((41 + 14 * dayCycle(t, this.tzOffsetMs) + 4 * smooth(t, 5 * MIN, 11)) * 10) / 10 },
        { zone: 'thermal_zone1', type: 'acpitz', temp: Math.round((33 + 6 * dayCycle(t, this.tzOffsetMs)) * 10) / 10 },
      ],
    };
  }
}

/**
 * Backfill 90 days of history through the real monitoring pipeline:
 * 10-minute resolution for older days, 1-minute for the last 7 days.
 */
async function backfill(monitor, client, { now = Date.now(), days = 90 } = {}) {
  const fineFrom = now - 7 * DAY;
  let t = now - days * DAY;
  while (t < now) {
    const step = t < fineFrom ? 10 * MIN : MIN;
    await monitor.runOnce(t, { intervalMs: step });
    t += step;
  }
}

module.exports = { DemoClient, backfill };
