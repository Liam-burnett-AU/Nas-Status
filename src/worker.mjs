// Cloudflare Workers host for NAS Status.
//
//  • Static assets (public/) are served by Workers Static Assets.
//  • /api/* and /healthz are answered by a single Durable Object (StatusMonitor),
//    which owns the history and runs a check on every alarm.
//  • A cron trigger acts as a watchdog that (re)arms the alarm, so monitoring
//    starts on deploy and keeps going without anyone visiting the page.

import { DurableObject } from 'cloudflare:workers';
import { buildConfig } from '../lib/config.js';
import { NextcloudClient } from '../lib/nextcloud.js';
import { HistoryStore } from '../lib/store.js';
import { Monitor } from '../lib/monitor.js';
import { DemoClient, backfill } from '../lib/demo.js';
import { SECURITY_HEADERS, isApiPath, handleApi } from '../lib/routes.js';
import { DurablePersistence } from './durable-storage.mjs';

const OBJECT_NAME = 'primary';
const EDGE_CACHE_MS = 5_000;
const VALID_LOCATION_HINTS = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me']);

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function log(level, message) {
  (level === 'error' || level === 'warn' ? console.error : console.log)(`[${level}] ${message}`);
}

/** Worker fetch() can only reach host names, never raw IP addresses. */
function isIpLiteral(hostname) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[');
}

function monitorStub(env) {
  const hint = String(env.DO_LOCATION_HINT || '').trim();
  const id = env.MONITOR.idFromName(OBJECT_NAME);
  return VALID_LOCATION_HINTS.has(hint) ? env.MONITOR.get(id, { locationHint: hint }) : env.MONITOR.get(id);
}

export class StatusMonitor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.configError = null;
    this.statusMemo = null;
    this.scheduleChecked = false;
    ctx.blockConcurrencyWhile(() => this.init());
  }

  async init() {
    try {
      this.config = buildConfig(this.env);
      if (!this.config.demo && isIpLiteral(new URL(this.config.nextcloud.baseUrl).hostname)) {
        throw new Error('NEXTCLOUD_URL must use a host name. Cloudflare Workers cannot fetch IP addresses directly; add a DNS record (or a Cloudflare Tunnel) and use that name.');
      }
    } catch (err) {
      this.configError = err.message;
      log('error', `Configuration error: ${err.message}`);
      return;
    }

    const c = this.config;
    this.store = new HistoryStore({ timeZone: c.timeZone, incidentThreshold: c.incidentThreshold, pollIntervalMs: c.pollIntervalMs });
    this.client = c.demo ? new DemoClient({ timeZone: c.timeZone }) : new NextcloudClient(c.nextcloud, { timeoutMs: c.requestTimeoutMs });
    this.monitor = new Monitor({ config: c, store: this.store, client: this.client, log });
    this.persistence = new DurablePersistence(this.ctx.storage);

    const loaded = await this.persistence.load(this.store, this.monitor);
    if (!loaded && c.demo) {
      const now = Date.now();
      await backfill(this.monitor, this.client, { now: now - c.pollIntervalMs });
      await this.persistence.save(this.store, this.monitor, { full: true });
      log('info', `Demo history generated (${this.store.samples.length} samples).`);
    }
    this.monitor.nextCheckAt = await this.ctx.storage.getAlarm();
  }

  /** Arm the alarm if it is missing or further away than one interval. Called by the cron watchdog. */
  async ensureScheduled() {
    if (this.configError) return { ok: false, error: this.configError };
    const interval = this.config.pollIntervalMs;
    const current = await this.ctx.storage.getAlarm();
    const now = Date.now();
    if (current === null || current > now + interval * 2) {
      const at = now + 1_000;
      await this.ctx.storage.setAlarm(at);
      this.monitor.nextCheckAt = at;
      log('info', current === null ? 'Monitoring started.' : 'Alarm re-armed after an interval change.');
    } else {
      this.monitor.nextCheckAt = current;
    }
    this.scheduleChecked = true;
    return { ok: true, nextCheckAt: this.monitor.nextCheckAt };
  }

  async alarm() {
    if (this.configError) return;
    // Schedule the next run first, so a failure below can never stop monitoring.
    const next = Date.now() + this.config.pollIntervalMs;
    await this.ctx.storage.setAlarm(next);
    this.monitor.nextCheckAt = next;
    try {
      await this.monitor.runOnce();
      await this.persistence.save(this.store, this.monitor);
    } catch (err) {
      log('error', `Check failed unexpectedly: ${err.stack || err}`);
    } finally {
      this.statusMemo = null;
    }
  }

  async fetch(request) {
    if (this.configError) {
      return json(500, { error: `Configuration error: ${this.configError}` });
    }
    if (!this.scheduleChecked) await this.ensureScheduled();

    const url = new URL(request.url);
    try {
      // /api/status is the heaviest response; build it once per check, not per viewer.
      if (url.pathname === '/api/status') {
        const checkedAt = this.store.latest?.checkedAt ?? null;
        if (!this.statusMemo || this.statusMemo.checkedAt !== checkedAt || Date.now() - this.statusMemo.builtAt > 60_000) {
          const { body } = handleApi(url.pathname, url.searchParams, { config: this.config, store: this.store, monitor: this.monitor });
          this.statusMemo = { checkedAt, builtAt: Date.now(), text: JSON.stringify(body) };
        }
        return new Response(this.statusMemo.text, {
          headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      const { status, body } = handleApi(url.pathname, url.searchParams, { config: this.config, store: this.store, monitor: this.monitor });
      return json(status, body);
    } catch (err) {
      log('error', `Request ${url.pathname} failed: ${err.stack || err}`);
      return json(500, { error: 'Internal server error' });
    }
  }
}

// A tiny per-isolate cache so many viewers in one Cloudflare location share a
// single Durable Object request. Free plan: 100,000 Durable Object requests a day.
const responseCache = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!isApiPath(url.pathname)) return env.ASSETS.fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
    }

    const key = url.pathname + url.search;
    const cacheable = url.pathname === '/api/status' || url.pathname === '/api/history';
    const now = Date.now();
    let cached = cacheable ? responseCache.get(key) : null;
    if (!cached || cached.expires <= now) {
      const res = await monitorStub(env).fetch(new Request(`https://monitor.internal${key}`));
      cached = { status: res.status, headers: [...res.headers], body: await res.text(), expires: now + EDGE_CACHE_MS };
      if (cacheable && res.status === 200) {
        responseCache.set(key, cached);
        if (responseCache.size > 20) responseCache.delete(responseCache.keys().next().value);
      }
    }
    return new Response(request.method === 'HEAD' ? null : cached.body, { status: cached.status, headers: cached.headers });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      monitorStub(env).ensureScheduled().then((r) => {
        if (!r.ok) log('error', `Watchdog: ${r.error}`);
      }),
    );
  },
};
