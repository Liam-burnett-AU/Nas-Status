'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConfig } = require('../lib/config');
const { NextcloudClient } = require('../lib/nextcloud');
const { HistoryStore } = require('../lib/store');
const { Monitor } = require('../lib/monitor');
const { createServer } = require('../server');
const { startMockNextcloud, TOKEN } = require('./helpers/mock-nextcloud');

async function setup(t, env = {}, mockState = {}) {
  const mock = await startMockNextcloud(mockState);
  const config = buildConfig({ NEXTCLOUD_URL: mock.url, NEXTCLOUD_TOKEN: TOKEN, TIMEZONE: 'Australia/Brisbane', ...env });
  const store = new HistoryStore({ timeZone: config.timeZone, incidentThreshold: config.incidentThreshold, pollIntervalMs: config.pollIntervalMs });
  const client = new NextcloudClient(config.nextcloud, { timeoutMs: 2000 });
  const logs = [];
  const monitor = new Monitor({ config, store, client, log: (level, msg) => logs.push(`${level}: ${msg}`) });
  const server = createServer({ config, store, monitor });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await mock.close();
  });
  return { mock, config, store, monitor, base, logs };
}

test('end to end: status API reflects a healthy server', async (t) => {
  const { monitor, base } = await setup(t, { NEXTCLOUD_USER: 'admin', NEXTCLOUD_APP_PASSWORD: 'app-pass' });
  await monitor.runOnce();
  const res = await fetch(`${base}/api/status`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-nas-status'), 'api', 'API replies are marked so the page can spot proxy/WAF responses');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self' https:\/\/static\.cloudflareinsights\.com/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  const body = await res.json();
  assert.equal(body.overall.status, 'operational');
  assert.equal(body.components.length, 4);
  assert.equal(body.metrics.memory.percent, 75);
  assert.equal(body.metrics.disk.dataVolumeIndex, 1);
  assert.equal(body.metrics.thermal[0].temp, 51.5);
  assert.equal(body.details.version, '30.0.4');
  assert.equal(body.details.uptimeText, '3 days, 1 hours, 2 minutes, 3 seconds');
  assert.equal(body.availability['24h'], 100);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes(TOKEN), 'token must never be exposed');
  assert.ok(!raw.includes('app-pass'), 'password must never be exposed');
  assert.ok(!raw.includes('secret'), 'FPM request URIs must never be exposed');
});

test('SHOW_SERVER_DETAILS=false hides versions and server internals', async (t) => {
  const { monitor, base } = await setup(t, { SHOW_SERVER_DETAILS: 'false' });
  await monitor.runOnce();
  const body = await (await fetch(`${base}/api/status`)).json();
  assert.equal(body.details, null);
  assert.deepEqual(body.metrics.thermal, []);
  assert.ok(!JSON.stringify(body).includes('30.0.4'));
});

test('outage, maintenance and recovery flow through to incidents', async (t) => {
  const { monitor, mock, base } = await setup(t);
  const t0 = Date.now() - 10 * 60_000;
  await monitor.runOnce(t0);
  mock.state.mode = 'down';
  await monitor.runOnce(t0 + 60_000);
  await monitor.runOnce(t0 + 120_000);
  let body = await (await fetch(`${base}/api/status`)).json();
  assert.equal(body.overall.status, 'major_outage');
  assert.equal(body.incidents.length, 1);
  assert.equal(body.incidents[0].endedAt, null);
  // Last good serverinfo data is kept and flagged as stale.
  assert.equal(body.monitor.infoStale, true);
  assert.equal(body.metrics.memory.percent, 75);

  mock.state.mode = 'maintenance';
  await monitor.runOnce(t0 + 180_000);
  body = await (await fetch(`${base}/api/status`)).json();
  assert.equal(body.overall.status, 'maintenance');

  mock.state.mode = 'ok';
  await monitor.runOnce(t0 + 240_000);
  await monitor.runOnce(t0 + 300_000);
  body = await (await fetch(`${base}/api/status`)).json();
  assert.equal(body.overall.status, 'operational');
  assert.equal(body.incidents[0].endedAt, t0 + 240_000);
  assert.equal(body.incidents[0].status, 'major_outage');
  assert.ok(body.availability['24h'] < 100);
});

test('a rejected token backs off instead of hammering Nextcloud', async (t) => {
  const { monitor, mock, logs } = await setup(t, { NEXTCLOUD_TOKEN: 'wrong-token' });
  const now = Date.now();
  await monitor.runOnce(now);
  const infoCalls = () => mock.state.requests.filter((r) => r.url.includes('/info')).length;
  assert.equal(infoCalls(), 1);
  await monitor.runOnce(now + 60_000); // still inside back-off
  assert.equal(infoCalls(), 1);
  assert.equal(mock.state.requests.filter((r) => r.url === '/status.php').length, 2, 'reachability keeps being checked');
  await monitor.runOnce(now + 121_000); // back-off expired
  assert.equal(infoCalls(), 2);
  assert.ok(logs.some((l) => /brute-force/.test(l)));
  assert.equal(monitor.store.latest.evaluation.overall, 'operational');
  assert.equal(monitor.store.latest.evaluation.components.api.status, 'unknown');
});

test('a corrected token is retried at once, not after the old back-off', async (t) => {
  const { monitor, mock, store, config } = await setup(t, { NEXTCLOUD_TOKEN: 'wrong-token' });
  const now = Date.now();
  await monitor.runOnce(now);
  assert.ok(monitor.infoGate.isBlocked(now + 1000));
  assert.match(store.latest.api.error, /monitoring token/);
  const saved = monitor.exportState();

  // Same credentials after a restart: back-off is kept.
  const same = new Monitor({ config, store, client: monitor.client });
  same.importState(saved);
  assert.ok(same.infoGate.isBlocked(now + 1000));

  // New token after a restart: back-off is dropped and the token is tried straight away.
  const fixed = buildConfig({ NEXTCLOUD_URL: mock.url, NEXTCLOUD_TOKEN: TOKEN, TIMEZONE: 'Australia/Brisbane' });
  const client = new NextcloudClient(fixed.nextcloud, { timeoutMs: 2000 });
  const restarted = new Monitor({ config: fixed, store, client });
  restarted.importState(saved);
  assert.equal(restarted.infoGate.isBlocked(now + 1000), false);
  await restarted.runOnce(now + 1000);
  assert.equal(store.latest.api.ok, true);
});

test('while backing off, the error says when the next attempt is', async (t) => {
  const { monitor, store } = await setup(t, { NEXTCLOUD_TOKEN: 'wrong-token' });
  const now = Date.now();
  await monitor.runOnce(now);
  await monitor.runOnce(now + 60_000);
  assert.match(store.latest.api.error, /next attempt is at \d{1,2}:\d{2}\s?(am|pm)/);
});

test('history endpoint validates the range', async (t) => {
  const { monitor, base } = await setup(t);
  await monitor.runOnce();
  const ok = await fetch(`${base}/api/history?range=6h`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.points.length, 180);
  assert.equal((await fetch(`${base}/api/history?range=99y`)).status, 400);
});

test('static files, traversal protection, methods and health', async (t) => {
  const { monitor, base } = await setup(t);
  assert.equal((await fetch(`${base}/healthz`)).status, 503, 'unhealthy before first check');
  await monitor.runOnce();
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(await index.text(), /<title>NAS Status<\/title>/);
  const css = await fetch(`${base}/css/styles.css`);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const etag = css.headers.get('etag');
  assert.equal((await fetch(`${base}/css/styles.css`, { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/status`, { method: 'POST' })).status, 405);
});
