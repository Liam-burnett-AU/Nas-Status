'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseServices, checkService } = require('../lib/services');
const { buildConfig } = require('../lib/config');
const { evaluate, STATUS } = require('../lib/evaluate');
const { HistoryStore } = require('../lib/store');

const DEFAULTS = { timeoutMs: 2000, slowMs: 1500 };

async function startApp(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, headers: req.headers });
    const send = (code, body = '', headers = {}) => { res.writeHead(code, { 'Content-Type': 'text/html', ...headers }); res.end(body); };
    switch (req.url) {
      case '/ok': return send(200, '<h1>Pit Wall</h1>');
      case '/redirect': return send(302, '', { Location: '/login' });
      case '/missing': return send(404, 'nope');
      case '/slow': return setTimeout(() => send(200, 'late'), 250);
      case '/hang': return; // never answers
      case '/access': return send(403, '<title>Cloudflare Access</title>', { 'cf-ray': 'abc123-SYD' });
      case '/access-redirect': return send(302, '', { Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/app' });
      case '/tunnel': return send(530, 'error code: 1033');
      case '/cf522': return send(522, 'Connection timed out');
      case '/mentions-access': return send(200, 'Docs: how we use Cloudflare Access');
      case '/basic': return send(401, 'auth', { 'WWW-Authenticate': 'Basic realm="x"' });
      case '/login': return send(405, JSON.stringify({ error: 'Method not allowed' }), { 'Content-Type': 'application/json' });
      case '/api/send': return send(405, JSON.stringify({ error: 'Method not allowed' }), { 'Content-Type': 'application/json' });
      default: return send(500, 'boom');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

const svc = (base, path, extra = {}) => parseServices([{ name: 'App', url: base + path, ...extra }], DEFAULTS)[0];

test('parses the SERVICES list from JSON text or an array', () => {
  const list = parseServices('[{"name":"Logbook","url":"Logbook.lbdev.app","access":true},{"name":"Login API","url":""},{"name":"Logbook","url":"x.example"}]', DEFAULTS);
  assert.deepEqual(list.map((s) => s.id), ['svc-logbook', 'svc-login-api', 'svc-logbook-2']);
  assert.equal(list[0].url, 'https://logbook.lbdev.app/');
  assert.equal(list[0].access, true);
  assert.equal(list[1].url, '');
  assert.deepEqual(parseServices([{ name: 'A', url: 'https://a.example', expectStatus: 401 }], DEFAULTS)[0].expectStatus.ranges, [[401, 401]]);
  assert.deepEqual(parseServices([{ name: 'A', url: 'https://a.example', expectStatus: ['2xx', '300-308', 405] }], DEFAULTS)[0].expectStatus.ranges, [[200, 299], [300, 308], [405, 405]]);
  assert.throws(() => parseServices([{ name: 'A', url: 'https://a.example', expectStatus: '6xx' }], DEFAULTS), /expectStatus/);
  assert.throws(() => parseServices([{ name: 'A', url: 'https://a.example', expectStatus: '299-200' }], DEFAULTS), /expectStatus/);
  assert.deepEqual(parseServices(undefined, DEFAULTS), []);
  assert.throws(() => parseServices('{bad', DEFAULTS), /JSON array/);
  assert.throws(() => parseServices([{ url: 'a.example' }], DEFAULTS), /needs a name/);
  assert.throws(() => parseServices([{ name: 'A', url: 'ftp://a.example' }], DEFAULTS), /http/);
  assert.throws(() => parseServices([{ name: 'A', url: 'https://u:p@a.example' }], DEFAULTS), /user name or password/);
  assert.throws(() => parseServices([{ name: 'A', url: 'https://a.example', expectStatus: 'yes' }], DEFAULTS), /expectStatus/);
  assert.throws(() => parseServices([{ name: 'A', url: 'https://a.example', method: 'HEAD', keyword: 'x' }], DEFAULTS), /keyword/);
  assert.throws(() => parseServices(new Array(21).fill({ name: 'A', url: 'a.example' }), DEFAULTS), /at most 20/);
  const c = buildConfig({ NEXTCLOUD_URL: 'https://nas.example', SERVICES: [{ name: 'Logbook', url: 'https://logbook.example' }] });
  assert.equal(c.services[0].timeoutMs, 10_000);
});

test('classifies every kind of answer', async (t) => {
  const { base } = await startApp(t);
  const cases = [
    ['/ok', {}, STATUS.OPERATIONAL, /Responding in/],
    ['/redirect', {}, STATUS.OPERATIONAL, /Responding in/],
    ['/missing', {}, STATUS.MAJOR, /HTTP 404 \(expected 200-399\)/],
    ['/missing', { expectStatus: [404] }, STATUS.OPERATIONAL, /Responding/],
    ['/slow', { slowMs: 100 }, STATUS.DEGRADED, /slowly/],
    ['/hang', { timeoutSeconds: 1 }, STATUS.MAJOR, /No response within 1 s/],
    ['/ok', { keyword: 'Pit Wall' }, STATUS.OPERATIONAL, /Responding/],
    ['/ok', { keyword: 'Logbook' }, STATUS.MAJOR, /"Logbook" was not on the page/],
    ['/access', {}, STATUS.UNKNOWN, /Cloudflare Access is protecting App.*Ray ID abc123/],
    ['/access-redirect', {}, STATUS.UNKNOWN, /Cloudflare Access/],
    ['/tunnel', {}, STATUS.MAJOR, /Tunnel for App is not connected/],
    ['/cf522', {}, STATUS.MAJOR, /Cloudflare could not reach the server \(HTTP 522\)/],
    ['/mentions-access', {}, STATUS.OPERATIONAL, /Responding/],
    ['/basic', {}, STATUS.UNKNOWN, /password prompt/],
    ['/basic', { expectStatus: [401] }, STATUS.OPERATIONAL, /Responding/],
    ['/boom', {}, STATUS.MAJOR, /HTTP 500/],
  ];
  for (const [path, extra, status, pattern] of cases) {
    const r = await checkService(svc(base, path, extra));
    assert.equal(r.status, status, `${path} ${JSON.stringify(extra)}: ${r.message}`);
    assert.match(r.message, pattern, path);
  }
  const down = await checkService(svc('http://127.0.0.1:9', '/'));
  assert.equal(down.status, STATUS.MAJOR);
  assert.match(down.message, /Unreachable/);
  const none = await checkService(parseServices([{ name: 'Login API', url: '' }], DEFAULTS)[0]);
  assert.equal(none.status, STATUS.UNKNOWN);
});

test('the Access service token is only sent to apps marked access: true', async (t) => {
  const { base, seen } = await startApp(t);
  const accessHeaders = { 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': 'cfast_x' };
  await checkService(svc(base, '/ok', { access: true }), { accessHeaders });
  assert.equal(seen.at(-1).headers['cf-access-client-id'], 'id.access');
  await checkService(svc(base, '/ok'), { accessHeaders });
  assert.equal(seen.at(-1).headers['cf-access-client-id'], undefined);
  const refused = await checkService(svc(base, '/access', { access: true }), { accessHeaders });
  assert.match(refused.message, /refused the monitor's service token/);
});

test('apps feed the overall status, incidents and history', () => {
  const T = buildConfig({ NEXTCLOUD_URL: 'https://nas.example' }).thresholds;
  const web = { ok: true, elapsedMs: 100, status: { installed: true, maintenance: false } };
  const api = { configured: false, ok: false };
  const down = evaluate({ web, api, services: [{ id: 'svc-pit-wall', status: STATUS.MAJOR, message: 'HTTP 502' }] }, T);
  assert.equal(down.overall, STATUS.MAJOR);
  const notSetUp = evaluate({ web, api, services: [{ id: 'svc-login-api', status: STATUS.UNKNOWN, message: 'No address set up yet' }] }, T);
  assert.equal(notSetUp.overall, STATUS.OPERATIONAL, 'an app without an address does not affect the overall status');

  const store = new HistoryStore({ timeZone: 'UTC', incidentThreshold: 2, pollIntervalMs: 60_000 });
  store.setNames({ 'svc-pit-wall': 'Pit Wall' });
  const t0 = Date.UTC(2026, 9, 20, 0, 0);
  store.record(t0, down, { serviceMs: { 'svc-pit-wall': 80 } });
  store.record(t0 + 60_000, down, { serviceMs: { 'svc-pit-wall': 90 } });
  assert.equal(store.incidents[0].title, 'Major outage: Pit Wall');
  assert.equal(store.uptime('svc-pit-wall', 86_400_000, t0 + 120_000), 0);
  const day = store.dailySeries('svc-pit-wall', 1, t0 + 120_000)[0];
  assert.equal(day.status, STATUS.MAJOR);
  assert.equal(day.avgResponseMs, 85);
  const stats = store.serviceStats('svc-pit-wall', 86_400_000, t0 + 120_000);
  assert.equal(stats.avgMs, 85);
  assert.equal(stats.trend.length, 24);
});

test('a login API that refuses a GET is still up; a 404 or 5xx is down', async (t) => {
  const { base } = await startApp(t);
  const loginRules = { expectStatus: ['2xx', '3xx', 400, 401, 403, 405] };
  assert.equal((await checkService(svc(base, '/login', loginRules))).status, STATUS.OPERATIONAL);
  const missing = await checkService(svc(base, '/missing', loginRules));
  assert.equal(missing.status, STATUS.MAJOR);
  assert.match(missing.message, /HTTP 404 \(expected 2xx, 3xx, 400, 401, 403, 405\)/);
  assert.equal((await checkService(svc(base, '/boom', loginRules))).status, STATUS.MAJOR);
});

test('relay: true checks the alert mail relay, where a 405 means up', async (t) => {
  const { base } = await startApp(t);
  const c = buildConfig({
    NEXTCLOUD_URL: 'https://nas.example',
    ALERT_EMAIL_API_URL: base,
    SERVICES: [{ name: 'Emailing API', relay: true }],
  });
  const relay = c.services[0];
  assert.equal(relay.url, `${base}/api/send`);
  assert.equal(relay.relay, true);
  const r = await checkService(relay);
  assert.equal(r.status, STATUS.OPERATIONAL, r.message);

  const notSet = buildConfig({ NEXTCLOUD_URL: 'https://nas.example', SERVICES: [{ name: 'Emailing API', relay: true }] }).services[0];
  assert.equal(notSet.url, '');
  const pending = await checkService(notSet);
  assert.equal(pending.status, STATUS.UNKNOWN);
  assert.match(pending.message, /ALERT_EMAIL_API_URL/);
});
