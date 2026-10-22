'use strict';

// Runtime-agnostic: no Node.js built-ins, so this runs on Node and on Cloudflare Workers.

function str(env, key, fallback = '') {
  const v = env[key];
  return v === undefined || v === '' ? fallback : String(v);
}

function num(env, key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number (got "${raw}")`);
  if (n < min || n > max) throw new Error(`${key} must be between ${min} and ${max} (got ${n})`);
  return n;
}

function bool(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`${key} must be true or false (got "${raw}")`);
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the runtime configuration from an environment object
 * (process.env on Node, the Worker `env` on Cloudflare).
 * Throws a descriptive Error when something is misconfigured.
 */
function buildConfig(env) {
  const demo = bool(env, 'DEMO_MODE', false);
  let baseUrl = str(env, 'NEXTCLOUD_URL').replace(/\/+$/, '');

  if (!demo) {
    if (!baseUrl) {
      throw new Error('NEXTCLOUD_URL is required (for example https://cloud.example.com). Set DEMO_MODE=true to preview with sample data.');
    }
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(`NEXTCLOUD_URL is not a valid URL: "${baseUrl}"`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('NEXTCLOUD_URL must start with http:// or https://');
    }
  }

  const token = str(env, 'NEXTCLOUD_TOKEN');
  const user = str(env, 'NEXTCLOUD_USER');
  const appPassword = str(env, 'NEXTCLOUD_APP_PASSWORD');
  if ((user && !appPassword) || (!user && appPassword)) {
    throw new Error('NEXTCLOUD_USER and NEXTCLOUD_APP_PASSWORD must be set together.');
  }
  // Optional Cloudflare Access service token, for a Nextcloud protected by Access.
  const accessClientId = str(env, 'CF_ACCESS_CLIENT_ID');
  const accessClientSecret = str(env, 'CF_ACCESS_CLIENT_SECRET');
  if ((accessClientId && !accessClientSecret) || (!accessClientId && accessClientSecret)) {
    throw new Error('CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set together.');
  }

  const timeZone = str(env, 'TIMEZONE', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  if (!validTimeZone(timeZone)) throw new Error(`TIMEZONE is not a valid IANA time zone: "${timeZone}"`);

  const diskWarnPercent = num(env, 'DISK_WARN_PERCENT', 85, { min: 1, max: 100 });
  const diskCriticalPercent = num(env, 'DISK_CRITICAL_PERCENT', 95, { min: 1, max: 100 });
  if (diskCriticalPercent < diskWarnPercent) throw new Error('DISK_CRITICAL_PERCENT must be greater than or equal to DISK_WARN_PERCENT.');
  const diskWarnFreeGb = num(env, 'DISK_WARN_FREE_GB', 50, { min: 0 });
  const diskCriticalFreeGb = num(env, 'DISK_CRITICAL_FREE_GB', 10, { min: 0 });
  if (diskCriticalFreeGb > diskWarnFreeGb) throw new Error('DISK_CRITICAL_FREE_GB must be less than or equal to DISK_WARN_FREE_GB.');

  return Object.freeze({
    demo,
    nextcloud: Object.freeze({ baseUrl, token, user, appPassword, accessClientId, accessClientSecret }),
    pollIntervalMs: num(env, 'POLL_INTERVAL_SECONDS', 60, { min: 15, max: 3600 }) * 1000,
    requestTimeoutMs: num(env, 'REQUEST_TIMEOUT_SECONDS', 10, { min: 1, max: 120 }) * 1000,
    host: str(env, 'HOST', '0.0.0.0'),
    port: num(env, 'PORT', 8080, { min: 0, max: 65535 }),
    dataDir: str(env, 'DATA_DIR', 'data'), // resolved against the working directory by server.js
    siteTitle: str(env, 'SITE_TITLE', 'NAS Status'),
    siteDescription: str(env, 'SITE_DESCRIPTION', 'Live health, performance and uptime for our Nextcloud server.'),
    timeZone,
    showServerDetails: bool(env, 'SHOW_SERVER_DETAILS', true),
    incidentThreshold: num(env, 'INCIDENT_THRESHOLD', 2, { min: 1, max: 60 }),
    thresholds: Object.freeze({
      webSlowMs: num(env, 'RESPONSE_DEGRADED_MS', 1500, { min: 50 }),
      apiSlowMs: num(env, 'API_DEGRADED_MS', 5000, { min: 50 }),
      cpuPercent: num(env, 'CPU_DEGRADED_PERCENT', 90, { min: 1, max: 1000 }),
      memoryPercent: num(env, 'MEMORY_DEGRADED_PERCENT', 90, { min: 1, max: 100 }),
      diskWarnPercent,
      diskCriticalPercent,
      diskWarnFreeBytes: diskWarnFreeGb * 1024 ** 3,
      diskCriticalFreeBytes: diskCriticalFreeGb * 1024 ** 3,
    }),
  });
}

module.exports = { buildConfig };
