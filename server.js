#!/usr/bin/env node
'use strict';

/*
 * Node.js host: serves public/ and the JSON API, and runs checks on a timer.
 * For Cloudflare Workers, see src/worker.mjs instead.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildConfig } = require('./lib/config');
const { loadDotEnv } = require('./lib/dotenv');
const { NextcloudClient } = require('./lib/nextcloud');
const { HistoryStore } = require('./lib/store');
const { Monitor } = require('./lib/monitor');
const { FilePersistence } = require('./lib/persist-file');
const { DemoClient, backfill } = require('./lib/demo');
const { SECURITY_HEADERS, API_MARKER, isApiPath, handleApi } = require('./lib/routes');

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
    ...API_MARKER,
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
  // Files starting with "_" (such as the Workers _headers file) are config, not content.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) || path.basename(filePath).startsWith('_')) {
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
    try {
      if (isApiPath(url.pathname)) {
        const { status, body } = handleApi(url.pathname, url.searchParams, { config, store, monitor });
        return sendJson(req, res, status, body);
      }
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      log('error', `Request ${url.pathname} failed: ${err.stack || err}`);
      return sendJson(req, res, 500, { error: 'Internal server error' });
    }
  });
}

/** Timer loop: one check at a time, saving history periodically. */
function startLoop({ config, monitor, persist }) {
  let timer = null;
  let running = true;
  const tick = async () => {
    await monitor.runOnce().catch((err) => log('error', `Check failed unexpectedly: ${err.stack || err}`));
    if (!running) return;
    monitor.nextCheckAt = Date.now() + config.pollIntervalMs;
    timer = setTimeout(tick, config.pollIntervalMs);
  };
  const saveTimer = setInterval(persist, 5 * 60_000);
  saveTimer.unref?.();
  tick();
  return () => {
    running = false;
    clearTimeout(timer);
    clearInterval(saveTimer);
    persist();
  };
}

async function main() {
  if (process.argv.includes('--demo')) process.env.DEMO_MODE = 'true';
  loadDotEnv(path.join(process.cwd(), '.env'));
  let config;
  try {
    config = buildConfig(process.env);
  } catch (err) {
    log('error', `Configuration error: ${err.message}`);
    process.exit(1);
  }

  if (config.baseUrlAdjustedFrom) {
    log('warn', `NEXTCLOUD_URL should be the base address. Using ${config.nextcloud.baseUrl} instead of ${config.baseUrlAdjustedFrom}.`);
  }

  const store = new HistoryStore({
    timeZone: config.timeZone,
    incidentThreshold: config.incidentThreshold,
    pollIntervalMs: config.pollIntervalMs,
  });

  let client;
  let persistence = null;
  if (config.demo) {
    client = new DemoClient({ timeZone: config.timeZone });
    client.setServices(config.services);
  } else {
    client = new NextcloudClient(config.nextcloud, { timeoutMs: config.requestTimeoutMs });
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
  } else {
    persistence = new FilePersistence(path.join(path.resolve(config.dataDir), 'history.json'), { log });
    if (persistence.load(store, monitor)) log('info', `Loaded ${store.samples.length} samples and ${store.daily.size} days of history.`);
  }

  const persist = () => {
    if (!persistence) return;
    try {
      persistence.save(store, monitor);
    } catch (err) {
      log('error', `Could not save history: ${err.message}`);
    }
  };

  const stopLoop = startLoop({ config, monitor, persist });
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
    stopLoop();
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
