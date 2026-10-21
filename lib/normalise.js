'use strict';

const KIB = 1024;
const GIB = 1024 ** 3;

/** Finite number or null. Accepts numeric strings (PHP sometimes returns them). */
function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Non-negative finite number or null (serverinfo uses -1 for "unknown"). */
function nonNeg(v) {
  const n = num(v);
  return n === null || n < 0 ? null : n;
}

function int(v) {
  const n = nonNeg(v);
  return n === null ? null : Math.round(n);
}

function text(v, max = 200) {
  if (v === null || v === undefined || typeof v === 'object') return null;
  const s = String(v).trim();
  if (!s || s === 'N/A') return null;
  return s.length > max ? s.slice(0, max) : s;
}

function yesNo(v) {
  if (v === true || v === 'yes' || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 'no' || v === 0 || v === '0' || v === 'false') return false;
  return null;
}

function pct(part, total) {
  if (part === null || total === null || total <= 0) return null;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

/** "\\OC\\Memcache\\APCu" -> "APCu", "none" -> null */
function memcacheName(v) {
  const s = text(v);
  if (!s || s.toLowerCase() === 'none') return null;
  const parts = s.split('\\').filter(Boolean);
  return parts[parts.length - 1] || s;
}

function normaliseCpu(system) {
  const cores = int(system.cpunum);
  const load = Array.isArray(system.cpuload) ? system.cpuload.map(num) : [];
  const [load1 = null, load5 = null, load15 = null] = load;
  const percent = load1 !== null && cores ? (load1 / cores) * 100 : null;
  return { load1, load5, load15, cores: cores || null, percent };
}

function normaliseMemory(system) {
  const total = nonNeg(system.mem_total);
  const free = nonNeg(system.mem_free);
  const totalBytes = total && total > 0 ? total * KIB : null;
  const availableBytes = totalBytes !== null && free !== null ? Math.min(free * KIB, totalBytes) : null;
  const usedBytes = totalBytes !== null && availableBytes !== null ? totalBytes - availableBytes : null;
  return { totalBytes, availableBytes, usedBytes, percent: pct(usedBytes, totalBytes) };
}

function normaliseSwap(system) {
  const total = nonNeg(system.swap_total);
  const free = nonNeg(system.swap_free);
  if (!total) return { totalBytes: total === 0 ? 0 : null, freeBytes: null, usedBytes: null, percent: null };
  const totalBytes = total * KIB;
  const freeBytes = free !== null ? Math.min(free * KIB, totalBytes) : null;
  const usedBytes = freeBytes !== null ? totalBytes - freeBytes : null;
  return { totalBytes, freeBytes, usedBytes, percent: pct(usedBytes, totalBytes) };
}

/**
 * diskdata is a list of [usedGiB, availableGiB] pairs (no mount names upstream).
 */
function normaliseVolumes(diskData) {
  if (!Array.isArray(diskData)) return [];
  const volumes = [];
  for (const entry of diskData) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const used = nonNeg(entry[0]);
    const avail = nonNeg(entry[1]);
    if (used === null || avail === null) continue;
    const usedBytes = used * GIB;
    const availableBytes = avail * GIB;
    const totalBytes = usedBytes + availableBytes;
    if (totalBytes <= 0) continue;
    volumes.push({ usedBytes, availableBytes, totalBytes, percent: pct(usedBytes, totalBytes) });
  }
  return volumes;
}

function normaliseDisk(system, diskData) {
  const freeBytes = nonNeg(system.freespace);
  const volumes = normaliseVolumes(diskData);
  let totalBytes = null;
  let matchedVolume = null;
  if (freeBytes !== null && freeBytes > 0) {
    // Identify the data volume: the one whose free space matches Nextcloud's
    // data directory free space (diskdata is rounded to 0.1 GiB, so allow slack).
    let best = null;
    for (let i = 0; i < volumes.length; i += 1) {
      const diff = Math.abs(volumes[i].availableBytes - freeBytes);
      const tolerance = Math.max(freeBytes * 0.02, 0.2 * GIB);
      if (diff <= tolerance && (best === null || diff < best.diff)) best = { i, diff };
    }
    if (best) {
      matchedVolume = best.i;
      totalBytes = volumes[best.i].totalBytes;
    }
  }
  const usedBytes = totalBytes !== null && freeBytes !== null ? Math.max(0, totalBytes - freeBytes) : null;
  return {
    freeBytes,
    totalBytes,
    usedBytes,
    percent: pct(usedBytes, totalBytes),
    dataVolumeIndex: matchedVolume,
    volumes,
  };
}

function normaliseOpcache(opcache) {
  if (!opcache || typeof opcache !== 'object' || Array.isArray(opcache) || !Object.keys(opcache).length) return null;
  const stats = opcache.opcache_statistics || {};
  const mem = opcache.memory_usage || {};
  const used = nonNeg(mem.used_memory);
  const free = nonNeg(mem.free_memory);
  const wasted = nonNeg(mem.wasted_memory) || 0;
  const total = used !== null && free !== null ? used + free + wasted : null;
  return {
    enabled: yesNo(opcache.opcache_enabled),
    hitRate: num(stats.opcache_hit_rate),
    cachedScripts: int(stats.num_cached_scripts),
    hits: int(stats.hits),
    misses: int(stats.misses),
    memoryUsedBytes: used,
    memoryTotalBytes: total,
    memoryPercent: total ? pct(used + wasted, total) : null,
  };
}

function normaliseApcu(apcu) {
  if (!apcu || typeof apcu !== 'object' || Array.isArray(apcu)) return null;
  const cache = apcu.cache && typeof apcu.cache === 'object' ? apcu.cache : null;
  const sma = apcu.sma && typeof apcu.sma === 'object' ? apcu.sma : null;
  if (!cache && !sma) return null;
  const hits = cache ? int(cache.num_hits) : null;
  const misses = cache ? int(cache.num_misses) : null;
  const lookups = hits !== null && misses !== null ? hits + misses : null;
  const segSize = sma ? nonNeg(sma.seg_size) : null;
  const segments = sma ? nonNeg(sma.num_seg) : null;
  const avail = sma ? nonNeg(sma.avail_mem) : null;
  const total = segSize !== null && segments !== null ? segSize * segments : null;
  return {
    hitRate: lookups ? (hits / lookups) * 100 : null,
    entries: cache ? int(cache.num_entries ?? cache.nentries) : null,
    hits,
    misses,
    memoryTotalBytes: total,
    memoryUsedBytes: total !== null && avail !== null ? Math.max(0, total - avail) : null,
    memoryPercent: total !== null && avail !== null ? pct(total - avail, total) : null,
  };
}

function normaliseFpm(fpm) {
  if (!fpm || typeof fpm !== 'object' || Array.isArray(fpm)) return null;
  // Deliberately never copy fpm.procs: it contains request URIs and client details.
  return {
    pool: text(fpm.pool, 60),
    processManager: text(fpm['process-manager'], 20),
    activeProcesses: int(fpm['active-processes']),
    idleProcesses: int(fpm['idle-processes']),
    totalProcesses: int(fpm['total-processes']),
    maxActiveProcesses: int(fpm['max-active-processes']),
    maxChildrenReached: int(fpm['max-children-reached']),
    slowRequests: int(fpm['slow-requests']),
    acceptedConnections: int(fpm['accepted-conn']),
    listenQueue: int(fpm['listen-queue']),
  };
}

function normaliseApps(apps) {
  if (!apps || typeof apps !== 'object') return null;
  const updatesRaw = apps.app_updates && typeof apps.app_updates === 'object' && !Array.isArray(apps.app_updates)
    ? apps.app_updates
    : {};
  const updates = Object.entries(updatesRaw)
    .map(([id, version]) => ({ id: text(id, 80), version: text(version, 40) }))
    .filter((u) => u.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    installed: int(apps.num_installed),
    updatesAvailable: int(apps.num_updates_available) ?? updates.length,
    updates,
  };
}

function normaliseUpdate(update) {
  if (!update || typeof update !== 'object') return null;
  const last = nonNeg(update.lastupdatedat);
  return {
    available: Boolean(update.available),
    availableVersion: text(update.available_version, 40),
    lastCheckedAt: last ? last * 1000 : null,
  };
}

function normaliseThermal(zones) {
  if (!Array.isArray(zones)) return [];
  return zones
    .map((z) => ({ zone: text(z?.zone, 40), type: text(z?.type, 60), temp: num(z?.temp) }))
    .filter((z) => z.temp !== null && z.temp > -50 && z.temp < 200);
}

/**
 * Turn the raw serverinfo "info" payload (plus optional admin endpoints) into
 * a predictable snapshot. Every field is either a sane value or null.
 */
function normaliseServerInfo(info, { diskData = null, basicData = null } = {}) {
  const nc = info?.nextcloud || {};
  const system = nc.system || {};
  const storage = nc.storage || {};
  const shares = nc.shares || {};
  const server = info?.server || {};
  const php = server.php || {};
  const db = server.database || {};
  const active = info?.activeUsers || {};

  return {
    version: text(system.version, 40),
    aioVersion: text(system.aio_version, 40),
    cpu: normaliseCpu(system),
    memory: normaliseMemory(system),
    swap: normaliseSwap(system),
    disk: normaliseDisk(system, diskData),
    storage: {
      users: int(storage.num_users),
      disabledUsers: int(storage.num_disabled_users),
      files: int(storage.num_files),
      storages: int(storage.num_storages),
      storagesLocal: int(storage.num_storages_local),
      storagesHome: int(storage.num_storages_home),
      storagesOther: int(storage.num_storages_other),
      appdataBytes: nonNeg(storage.size_appdata_storage),
      appdataFiles: int(storage.num_files_appdata),
    },
    shares: {
      total: int(shares.num_shares),
      user: int(shares.num_shares_user),
      group: int(shares.num_shares_groups),
      link: int(shares.num_shares_link),
      linkNoPassword: int(shares.num_shares_link_no_password),
      email: int(shares.num_shares_mail),
      room: int(shares.num_shares_room),
      federatedSent: int(shares.num_fed_shares_sent),
      federatedReceived: int(shares.num_fed_shares_received),
    },
    activeUsers: {
      last5minutes: int(active.last5minutes),
      last1hour: int(active.last1hour),
      last24hours: int(active.last24hours),
      last7days: int(active.last7days),
      last1month: int(active.last1month),
      last3months: int(active.last3months),
      last6months: int(active.last6months),
      lastyear: int(active.lastyear),
    },
    server: {
      webserver: text(server.webserver, 80),
      phpVersion: text(php.version, 20),
      phpMemoryLimitBytes: num(php.memory_limit),
      phpMaxExecutionTime: num(php.max_execution_time),
      phpUploadMaxBytes: num(php.upload_max_filesize),
      phpExtensions: Array.isArray(php.extensions) ? php.extensions.length : null,
      dbType: text(db.type, 20),
      dbVersion: text(db.version, 40),
      dbSizeBytes: nonNeg(db.size),
    },
    caching: {
      local: memcacheName(system['memcache.local']),
      distributed: memcacheName(system['memcache.distributed']),
      locking: memcacheName(system['memcache.locking']),
      fileLocking: yesNo(system['filelocking.enabled']),
      opcache: normaliseOpcache(php.opcache),
      apcu: normaliseApcu(php.apcu),
    },
    fpm: normaliseFpm(server.fpm),
    config: {
      debug: yesNo(system.debug),
      previews: yesNo(system.enable_previews),
      avatars: yesNo(system.enable_avatars),
    },
    apps: normaliseApps(system.apps),
    update: normaliseUpdate(system.update),
    uptimeText: text(basicData?.uptime, 80),
    thermal: normaliseThermal(basicData?.thermalzones),
  };
}

function normaliseStatusPhp(status) {
  return {
    installed: yesNo(status?.installed),
    maintenance: yesNo(status?.maintenance) === true,
    needsDbUpgrade: yesNo(status?.needsDbUpgrade) === true,
    version: text(status?.version, 40),
    versionString: text(status?.versionstring, 40),
    productName: text(status?.productname, 60),
    edition: text(status?.edition, 40),
  };
}

module.exports = { normaliseServerInfo, normaliseStatusPhp, normaliseVolumes, num, nonNeg, pct };
