#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./lib/config');
const { NextcloudClient } = require('./lib/nextcloud');
const { HistoryStore, RANGES } = require('./lib/store');
const { Monitor } = require('./lib/monitor');
const { DemoClient, backfill } = require('./lib/demo');
const { buildStatus } = require('./lib/api');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
function log(level, message) {
  if ((LEVELS[level] ?? 20) < LOG_LEVEL) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

function sendJson(req, res, status, body, extraHeaders = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(json),
    ...extraHeaders,
  });
  res.end(req.method === 'HEAD' ? undefined : json);
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(req, res, 400, { error: 'Bad request' });
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const filePath = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize('/' + rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(req, res, 404, { error: 'Not found' });
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(req, res, 404, { error: 'Not found' });
    const ext = path.extname(filePath).toLowerCase();
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
  });
}

function createServer({ config, store, monitor }) {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(req, res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
    }
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(req, res, 400, { error: 'Bad request' });
    }
    const { pathname } = url;

    try {
      if (pathname === '/api/status') {
        return sendJson(req, res, 200, buildStatus({ config, store, monitor }));
      }
      if (pathname === '/api/history') {
        const range = url.searchParams.get('range') || '24h';
        if (!RANGES[range]) return sendJson(req, res, 400, { error: `range must be one of ${Object.keys(RANGES).join(', ')}` });
        return sendJson(req, res, 200, store.history(range));
      }
      if (pathname === '/healthz' || pathname === '/api/healthz') {
        const last = store.latest?.checkedAt ?? null;
        const fresh = last !== null && Date.now() - last < config.pollIntervalMs * 3;
        return sendJson(req, res, fresh ? 200 : 503, { ok: fresh, lastCheckAt: last, overall: store.latest?.evaluation?.overall ?? 'unknown' });
      }
      if (pathname.startsWith('/api/')) return sendJson(req, res, 404, { error: 'Not found' });
      return serveStatic(req, res, pathname);
    } catch (err) {
      log('error', `Request ${pathname} failed: ${err.stack || err}`);
      return sendJson(req, res, 500, { error: 'Internal server error' });
    }
  });
}

async function main() {
  if (process.argv.includes('--demo')) process.env.DEMO_MODE = 'true';
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log('error', `Configuration error: ${err.message}`);
    process.exit(1);
  }

  const store = new HistoryStore({
    file: config.demo ? null : path.join(config.dataDir, 'history.json'),
    timeZone: config.timeZone,
    incidentThreshold: config.incidentThreshold,
    pollIntervalMs: config.pollIntervalMs,
    log,
  });

  let client;
  if (config.demo) {
    client = new DemoClient({ timeZone: config.timeZone });
  } else {
    client = new NextcloudClient(config.nextcloud, { timeoutMs: config.requestTimeoutMs });
    if (store.load()) log('info', `Loaded ${store.samples.length} samples and ${store.daily.size} days of history.`);
    if (!client.canReadServerInfo) {
      log('warn', 'No NEXTCLOUD_TOKEN or NEXTCLOUD_USER/NEXTCLOUD_APP_PASSWORD set: only reachability will be monitored.');
    }
  }

  const monitor = new Monitor({ config, store, client, log });

  if (config.demo) {
    log('info', 'DEMO_MODE is on: generating 90 days of sample history...');
    const started = Date.now();
    await backfill(monitor, client, { now: started - config.pollIntervalMs });
    log('info', `Demo history ready (${store.samples.length} samples) in ${Date.now() - started} ms.`);
  }

  monitor.start();
  const server = createServer({ config, store, monitor });
  server.listen(config.port, config.host, () => {
    const addr = server.address();
    log('info', `Status page listening on http://${addr.address === '0.0.0.0' ? 'localhost' : addr.address}:${addr.port}`);
    if (!config.demo) log('info', `Monitoring ${config.nextcloud.baseUrl} every ${config.pollIntervalMs / 1000} s`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `${signal} received, saving history and shutting down.`);
    monitor.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    log('error', err.stack || String(err));
    process.exit(1);
  });
}

module.exports = { createServer };
