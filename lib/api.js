'use strict';

const { COMPONENTS, STATUS, OVERALL_MESSAGE } = require('./evaluate');
const { DAY_MS } = require('./store');

const HOUR_MS = 3_600_000;

function uptimeWindows(store, id, now) {
  return {
    '24h': store.uptime(id, DAY_MS, now),
    '7d': store.uptime(id, 7 * DAY_MS, now),
    '30d': store.uptime(id, 30 * DAY_MS, now),
    '90d': store.uptime(id, 90 * DAY_MS, now),
  };
}

/**
 * Build the public /api/status payload. Every field is whitelisted here so
 * nothing sensitive from the raw serverinfo response can leak by accident.
 */
function buildStatus({ config, store, monitor, now = Date.now() }) {
  const latest = store.latest;
  const evaluation = latest?.evaluation || null;
  const info = latest?.info || null;
  const details = config.showServerDetails;

  const components = COMPONENTS.map((c) => {
    const current = evaluation?.components?.[c.id] || { status: STATUS.UNKNOWN, message: 'Waiting for first check' };
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      status: current.status,
      message: current.message,
      uptime: uptimeWindows(store, c.id, now),
      daily: store.dailySeries(c.id, 90, now),
    };
  });

  const services = (config.services || []).map((svc) => {
    const current = evaluation?.components?.[svc.id]
      || { status: STATUS.UNKNOWN, message: svc.url ? 'Waiting for first check' : 'No address set up yet' };
    const last = latest?.services?.find((r) => r.id === svc.id);
    const stats = store.serviceStats(svc.id, DAY_MS, now);
    return {
      id: svc.id,
      name: svc.name,
      description: svc.description,
      url: svc.url || null,
      host: svc.url ? new URL(svc.url).host : null,
      status: current.status,
      message: current.message,
      responseMs: last?.elapsedMs ?? null,
      httpStatus: last?.httpStatus ?? null,
      avgMs24h: stats.avgMs,
      p95Ms24h: stats.p95Ms,
      trend24h: stats.trend,
      uptime: uptimeWindows(store, svc.id, now),
      daily: store.dailySeries(svc.id, 90, now),
    };
  });

  const incidents = store.incidents
    .slice()
    .reverse()
    .slice(0, 25)
    .map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      currentStatus: i.currentStatus,
      startedAt: i.startedAt,
      endedAt: i.endedAt,
      durationMs: (i.endedAt ?? now) - i.startedAt,
      components: i.components.map((id) => ({ id, name: store.componentName(id) })),
      updates: i.updates.slice().reverse(),
    }));

  const statusPhp = latest?.web?.status || null;
  const overallStatus = evaluation?.overall || STATUS.UNKNOWN;

  const payload = {
    generatedAt: now,
    site: {
      title: config.siteTitle,
      description: config.siteDescription,
      timeZone: config.timeZone,
      productName: statusPhp?.productName || 'Nextcloud',
    },
    monitor: {
      demo: config.demo,
      pollIntervalMs: config.pollIntervalMs,
      lastCheckAt: latest?.checkedAt ?? null,
      nextCheckAt: monitor?.nextCheckAt ?? null,
      apiConfigured: Boolean(latest?.api?.configured),
      apiError: latest?.api?.ok === false && latest?.api?.configured ? latest.api.error : null,
      infoAt: latest?.infoAt ?? null,
      infoStale: Boolean(latest && latest.infoAt !== latest.checkedAt),
      showServerDetails: details,
      thresholds: {
        responseDegradedMs: config.thresholds.webSlowMs,
        cpuPercent: config.thresholds.cpuPercent,
        memoryPercent: config.thresholds.memoryPercent,
        diskWarnPercent: config.thresholds.diskWarnPercent,
        diskCriticalPercent: config.thresholds.diskCriticalPercent,
      },
    },
    overall: { status: overallStatus, message: evaluation?.message || OVERALL_MESSAGE[overallStatus] },
    availability: uptimeWindows(store, 'web', now),
    response: {
      currentMs: latest?.web?.elapsedMs ?? null,
      apiMs: latest?.api?.elapsedMs ?? null,
      last1h: store.responseStats(HOUR_MS, now),
      last24h: store.responseStats(DAY_MS, now),
    },
    components,
    services,
    incidents,
    metrics: info ? {
      cpu: info.cpu,
      memory: info.memory,
      swap: info.swap,
      disk: {
        freeBytes: info.disk.freeBytes,
        totalBytes: info.disk.totalBytes,
        usedBytes: info.disk.usedBytes,
        percent: info.disk.percent,
        dataVolumeIndex: info.disk.dataVolumeIndex,
        volumes: info.disk.volumes,
      },
      activeUsers: info.activeUsers,
      storage: info.storage,
      shares: info.shares,
      thermal: details ? info.thermal : [],
    } : null,
    details: null,
  };

  if (details) {
    payload.details = {
      version: statusPhp?.versionString || info?.version || null,
      versionFull: statusPhp?.version || info?.version || null,
      edition: statusPhp?.edition || null,
      aioVersion: info?.aioVersion || null,
      maintenance: statusPhp?.maintenance ?? null,
      needsDbUpgrade: statusPhp?.needsDbUpgrade ?? null,
      uptimeText: info?.uptimeText || null,
      server: info?.server || null,
      caching: info?.caching || null,
      fpm: info?.fpm || null,
      config: info?.config || null,
      apps: info?.apps || null,
      update: info?.update || null,
    };
  }
  return payload;
}

module.exports = { buildStatus };
