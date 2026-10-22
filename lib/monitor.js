'use strict';

const { normaliseServerInfo, normaliseStatusPhp } = require('./normalise');
const { evaluate } = require('./evaluate');

const MAX_AUTH_BACKOFF_MS = 30 * 60_000;

/**
 * Short, non-reversible fingerprint (FNV-1a) of the configured credentials.
 * Used only to notice that they changed, so a corrected token is tried at once
 * instead of waiting out a back-off earned by the old one.
 */
function credentialFingerprint(nc = {}) {
  const text = [nc.token, nc.user, nc.appPassword].map((v) => v || '').join('\u0000');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Exponential back-off gate for an authenticated endpoint. Nextcloud's
 * brute-force protection throttles an IP that keeps presenting bad
 * credentials, so a rejected token must not be retried every minute.
 */
class AuthGate {
  constructor(name, baseMs) {
    this.name = name;
    this.baseMs = baseMs;
    this.failures = 0;
    this.blockedUntil = 0;
    this.lastError = null;
  }

  isBlocked(now) {
    return now < this.blockedUntil;
  }

  fail(now, message) {
    this.failures += 1;
    const backoff = Math.min(this.baseMs * 2 ** this.failures, MAX_AUTH_BACKOFF_MS);
    this.blockedUntil = now + backoff;
    this.lastError = message;
    return backoff;
  }

  succeed() {
    this.failures = 0;
    this.blockedUntil = 0;
    this.lastError = null;
  }

  toJSON() {
    return { failures: this.failures, blockedUntil: this.blockedUntil, lastError: this.lastError };
  }

  restore(data) {
    if (!data || typeof data !== 'object') return;
    this.failures = Number.isFinite(data.failures) ? data.failures : 0;
    this.blockedUntil = Number.isFinite(data.blockedUntil) ? data.blockedUntil : 0;
    this.lastError = typeof data.lastError === 'string' ? data.lastError : null;
  }
}

/**
 * Runs one monitoring round at a time. Scheduling is the host's job:
 * a timer loop in server.js (Node) or a Durable Object alarm (Workers).
 */
class Monitor {
  /**
   * @param {{config: object, store: import('./store').HistoryStore, client: object, log?: Function}} deps
   */
  constructor({ config, store, client, log = () => {} }) {
    this.config = config;
    this.store = store;
    this.client = client;
    this.log = log;
    this.infoGate = new AuthGate('serverinfo', config.pollIntervalMs);
    this.adminGate = new AuthGate('admin endpoints', config.pollIntervalMs);
    this.credentials = credentialFingerprint(config.nextcloud);
    this.timeFormat = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: config.timeZone || 'UTC' });
    this.lastCheckAt = store.latest?.checkedAt ?? null;
    /** When the host expects to run the next check (shown on the page). */
    this.nextCheckAt = null;
  }

  /** Back-off state must survive restarts, or a bad token gets retried every minute. */
  exportState() {
    return { credentials: this.credentials, infoGate: this.infoGate.toJSON(), adminGate: this.adminGate.toJSON() };
  }

  importState(data) {
    if (!data || typeof data !== 'object') return;
    this.lastCheckAt = this.store.latest?.checkedAt ?? this.lastCheckAt;
    if (data.credentials !== this.credentials) {
      // New token or password since the back-off was earned: try straight away.
      if (data.infoGate?.failures || data.adminGate?.failures) this.log('info', 'Credentials changed since the last rejection; retrying now.');
      return;
    }
    this.infoGate.restore(data.infoGate);
    this.adminGate.restore(data.adminGate);
  }

  handleAuth(gate, result, now, consequence) {
    if (!result || result.status !== 'rejected') {
      if (result && result.status === 'fulfilled' && result.value) gate.succeed();
      return;
    }
    if (result.reason?.kind !== 'auth') return;
    const backoff = gate.fail(now, result.reason.message);
    // The length (never the value) helps spot a truncated or doubled paste.
    const hint = result.reason.mode === 'token'
      ? ` The configured token is ${(this.config.nextcloud?.token || '').length} characters long (one made with "openssl rand -hex 32" is 64).`
      : '';
    this.log('warn', `${gate.name}: ${result.reason.message}.${hint} ${consequence} for ${Math.round(backoff / 60_000)} min to avoid Nextcloud brute-force throttling.`);
  }

  async probe(now) {
    const client = this.client;
    const apiConfigured = client.canReadServerInfo;
    const infoBlocked = this.infoGate.isBlocked(now);
    const adminAllowed = client.canReadAdminEndpoints && !this.adminGate.isBlocked(now);

    const [statusRes, infoRes, diskRes, basicRes] = await Promise.allSettled([
      client.getStatus(now),
      apiConfigured && !infoBlocked ? client.getServerInfo(now) : Promise.resolve(null),
      adminAllowed ? client.getDiskData(now) : Promise.resolve(null),
      adminAllowed ? client.getBasicData(now) : Promise.resolve(null),
    ]);

    const web = statusRes.status === 'fulfilled'
      ? { ok: true, elapsedMs: statusRes.value.elapsedMs, error: null, status: normaliseStatusPhp(statusRes.value.data) }
      : { ok: false, elapsedMs: null, error: statusRes.reason?.message || 'Unknown error', status: null };

    let api = { configured: apiConfigured, ok: false, elapsedMs: null, error: null, errorKind: null, info: null };
    if (!apiConfigured) {
      api.error = 'Monitoring credentials not configured';
    } else if (infoBlocked) {
      api = {
        ...api,
        error: `${this.infoGate.lastError}. To avoid a Nextcloud lockout, the next attempt is at ${this.timeFormat.format(new Date(this.infoGate.blockedUntil))}`,
        errorKind: 'auth',
      };
    } else if (infoRes.status === 'fulfilled' && infoRes.value) {
      const diskData = diskRes.status === 'fulfilled' ? diskRes.value : null;
      const basicData = basicRes.status === 'fulfilled' ? basicRes.value : null;
      api = { ...api, ok: true, elapsedMs: infoRes.value.elapsedMs, info: normaliseServerInfo(infoRes.value.data, { diskData, basicData }) };
    } else {
      const err = infoRes.reason;
      api = { ...api, error: err?.message || 'Unknown error', errorKind: err?.kind || 'unknown' };
    }

    if (apiConfigured && !infoBlocked) {
      this.handleAuth(this.infoGate, infoRes, now, 'Pausing serverinfo checks');
    }
    if (adminAllowed) {
      const adminAuthFail = [diskRes, basicRes].find((r) => r.status === 'rejected' && r.reason?.kind === 'auth');
      this.handleAuth(this.adminGate, adminAuthFail || diskRes, now, 'Pausing disk and uptime details');
      for (const [name, r] of [['diskdata', diskRes], ['basicdata', basicRes]]) {
        if (r.status === 'rejected' && r.reason?.kind !== 'auth') this.log('debug', `${name} unavailable: ${r.reason?.message}`);
      }
    }

    return { web, api };
  }

  async runOnce(now = Date.now(), { intervalMs } = {}) {
    const probe = await this.probe(now);
    const evaluation = evaluate(probe, this.config.thresholds);
    const info = probe.api.info;

    this.store.record(now, evaluation, {
      responseMs: probe.web.elapsedMs,
      apiMs: probe.api.ok ? probe.api.elapsedMs : null,
      cpuPercent: info?.cpu.percent ?? null,
      memoryPercent: info?.memory.percent ?? null,
      swapPercent: info?.swap.percent ?? null,
      freeBytes: info?.disk.freeBytes ?? null,
      activeUsers5m: info?.activeUsers.last5minutes ?? null,
    }, { intervalMs });

    const previous = this.store.latest;
    this.store.latest = {
      checkedAt: now,
      evaluation,
      web: probe.web,
      api: { configured: probe.api.configured, ok: probe.api.ok, elapsedMs: probe.api.elapsedMs, error: probe.api.error, errorKind: probe.api.errorKind },
      info: info || previous?.info || null,
      infoAt: info ? now : previous?.infoAt ?? null,
    };
    this.lastCheckAt = now;

    if (previous?.evaluation?.overall !== evaluation.overall) {
      this.log('info', `Overall status: ${evaluation.overall} - ${evaluation.message}`);
    }
    return this.store.latest;
  }
}

module.exports = { Monitor, AuthGate };
