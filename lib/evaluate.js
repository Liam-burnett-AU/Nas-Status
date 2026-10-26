'use strict';

/**
 * Status vocabulary (mirrors the conventions of public status pages).
 * Severity is used to find the "worst" status; maintenance and unknown are
 * handled separately because they are not points on the same scale.
 */
const STATUS = Object.freeze({
  OPERATIONAL: 'operational',
  DEGRADED: 'degraded',
  PARTIAL: 'partial_outage',
  MAJOR: 'major_outage',
  MAINTENANCE: 'maintenance',
  UNKNOWN: 'unknown',
});

const SEVERITY = Object.freeze({
  [STATUS.UNKNOWN]: -1,
  [STATUS.OPERATIONAL]: 0,
  [STATUS.DEGRADED]: 1,
  [STATUS.MAINTENANCE]: 2,
  [STATUS.PARTIAL]: 3,
  [STATUS.MAJOR]: 4,
});

/** Compact single-character codes used in persisted history. */
const CODE = Object.freeze({
  [STATUS.OPERATIONAL]: 'o',
  [STATUS.DEGRADED]: 'd',
  [STATUS.PARTIAL]: 'p',
  [STATUS.MAJOR]: 'm',
  [STATUS.MAINTENANCE]: 'x',
  [STATUS.UNKNOWN]: 'u',
});
const FROM_CODE = Object.freeze(Object.fromEntries(Object.entries(CODE).map(([k, v]) => [v, k])));

const COMPONENTS = Object.freeze([
  { id: 'web', name: 'Web interface & file sync', description: 'Reachability and response time of the public endpoint (status.php).' },
  { id: 'api', name: 'Server API & database', description: 'The serverinfo monitoring API, which reads live data from the database.' },
  { id: 'storage', name: 'Storage', description: 'Free space on the Nextcloud data volume.' },
  { id: 'resources', name: 'CPU & memory', description: 'Processor load and memory pressure on the host.' },
]);

const OVERALL_MESSAGE = Object.freeze({
  [STATUS.OPERATIONAL]: 'All systems operational',
  [STATUS.DEGRADED]: 'Degraded performance',
  [STATUS.PARTIAL]: 'Partial outage',
  [STATUS.MAJOR]: 'Major outage',
  [STATUS.MAINTENANCE]: 'Under maintenance',
  [STATUS.UNKNOWN]: 'Waiting for first check',
});

const BLOCKED_MESSAGE = 'The monitor is blocked before it reaches Nextcloud';

function worst(statuses) {
  let result = STATUS.UNKNOWN;
  for (const s of statuses) {
    if (SEVERITY[s] > SEVERITY[result]) result = s;
  }
  return result;
}

function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** Binary units labelled GB/TB, matching Nextcloud's own UI and the page. */
function formatGiB(bytes) {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1024) return `${(gib / 1024).toFixed(2)} TB`;
  return `${gib.toFixed(gib >= 100 ? 0 : 1)} GB`;
}

/**
 * @param {object} probe result of one monitoring round:
 *   { web: {ok, elapsedMs, error, status}, api: {configured, ok, elapsedMs, error, errorKind, info} }
 * @param {object} t thresholds from config
 */
function evaluate(probe, t) {
  const components = {};

  // --- Web ---------------------------------------------------------------
  const web = probe.web;
  // A block in front of Nextcloud (Access, firewall, proxy) says nothing about whether
  // Nextcloud is up, so it is recorded as "no data" rather than as downtime.
  const blocked = !web.ok && web.errorKind === 'blocked';
  if (blocked) {
    components.web = { status: STATUS.UNKNOWN, message: web.error };
  } else if (!web.ok) {
    components.web = { status: STATUS.MAJOR, message: `Unreachable: ${web.error}` };
  } else if (web.status.maintenance) {
    components.web = { status: STATUS.MAINTENANCE, message: 'Nextcloud is in maintenance mode' };
  } else if (web.status.installed === false) {
    components.web = { status: STATUS.MAJOR, message: 'Nextcloud reports it is not installed' };
  } else if (web.elapsedMs > t.webSlowMs) {
    components.web = { status: STATUS.DEGRADED, message: `Responding slowly (${formatMs(web.elapsedMs)})` };
  } else {
    components.web = { status: STATUS.OPERATIONAL, message: `Responding in ${formatMs(web.elapsedMs)}` };
  }

  // --- API & database ----------------------------------------------------
  const api = probe.api;
  const webDown = components.web.status === STATUS.MAJOR;
  const maintenance = components.web.status === STATUS.MAINTENANCE;
  if (!api.configured) {
    components.api = { status: STATUS.UNKNOWN, message: 'Monitoring credentials not configured' };
  } else if (blocked || (!api.ok && api.errorKind === 'blocked')) {
    components.api = { status: STATUS.UNKNOWN, message: blocked ? 'Waiting until the monitor can reach Nextcloud' : api.error };
  } else if (maintenance) {
    components.api = { status: STATUS.MAINTENANCE, message: 'Paused during maintenance' };
  } else if (webDown) {
    components.api = { status: STATUS.MAJOR, message: 'Unavailable while the server is unreachable' };
  } else if (!api.ok && api.errorKind === 'auth') {
    // A rejected token is a configuration fault on the monitor, not an outage.
    components.api = { status: STATUS.UNKNOWN, message: api.error };
  } else if (!api.ok) {
    components.api = { status: STATUS.PARTIAL, message: `Not responding: ${api.error}` };
  } else if (web.status.needsDbUpgrade) {
    components.api = { status: STATUS.DEGRADED, message: 'Database upgrade pending' };
  } else if (api.elapsedMs > t.apiSlowMs) {
    components.api = { status: STATUS.DEGRADED, message: `Responding slowly (${formatMs(api.elapsedMs)})` };
  } else {
    components.api = { status: STATUS.OPERATIONAL, message: `Responding in ${formatMs(api.elapsedMs)}` };
  }

  // --- Storage & resources need a fresh serverinfo payload ----------------
  const info = api.ok ? api.info : null;
  if (!info) {
    const why = maintenance ? 'Paused during maintenance' : 'No data from the monitoring API';
    const s = maintenance ? STATUS.MAINTENANCE : STATUS.UNKNOWN;
    components.storage = { status: s, message: why };
    components.resources = { status: s, message: why };
  } else {
    const disk = info.disk;
    if (disk.percent !== null) {
      const msg = `${disk.percent.toFixed(1)}% used, ${formatGiB(disk.freeBytes)} free`;
      if (disk.percent >= t.diskCriticalPercent) components.storage = { status: STATUS.PARTIAL, message: `Critically low space: ${msg}` };
      else if (disk.percent >= t.diskWarnPercent) components.storage = { status: STATUS.DEGRADED, message: `Running low: ${msg}` };
      else components.storage = { status: STATUS.OPERATIONAL, message: msg };
    } else if (disk.freeBytes !== null) {
      const msg = `${formatGiB(disk.freeBytes)} free`;
      if (disk.freeBytes <= t.diskCriticalFreeBytes) components.storage = { status: STATUS.PARTIAL, message: `Critically low space: ${msg}` };
      else if (disk.freeBytes <= t.diskWarnFreeBytes) components.storage = { status: STATUS.DEGRADED, message: `Running low: ${msg}` };
      else components.storage = { status: STATUS.OPERATIONAL, message: msg };
    } else {
      components.storage = { status: STATUS.UNKNOWN, message: 'Free space not reported (external or unlimited storage)' };
    }

    const issues = [];
    const cpu = info.cpu.percent;
    const mem = info.memory.percent;
    if (cpu !== null && cpu >= t.cpuPercent) issues.push(`high CPU load (${Math.round(cpu)}%)`);
    if (mem !== null && mem >= t.memoryPercent) issues.push(`high memory use (${Math.round(mem)}%)`);
    if (issues.length) {
      const m = issues.join(' and ');
      components.resources = { status: STATUS.DEGRADED, message: m.charAt(0).toUpperCase() + m.slice(1) };
    } else if (cpu === null && mem === null) {
      components.resources = { status: STATUS.UNKNOWN, message: 'CPU and memory not reported by this host' };
    } else {
      const parts = [];
      if (cpu !== null) parts.push(`CPU ${Math.round(cpu)}%`);
      if (mem !== null) parts.push(`memory ${Math.round(mem)}%`);
      components.resources = { status: STATUS.OPERATIONAL, message: parts.join(', ') };
    }
  }

  // Other apps (SERVICES) count towards the overall status like any component.
  for (const svc of probe.services || []) {
    components[svc.id] = { status: svc.status, message: svc.message };
  }

  // Maintenance sits between degraded and partial outage, so it shows unless something is worse.
  const overall = worst(Object.values(components).map((c) => c.status));
  const message = blocked && overall === STATUS.UNKNOWN ? BLOCKED_MESSAGE : OVERALL_MESSAGE[overall];
  return { overall, message, components };
}

module.exports = { STATUS, SEVERITY, CODE, FROM_CODE, COMPONENTS, OVERALL_MESSAGE, evaluate, worst };
