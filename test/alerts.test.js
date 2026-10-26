'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AlertManager, MailRelaySender, parseAlertConfig, MAX_SENDS_PER_HOUR } = require('../lib/alerts');
const { buildConfig } = require('../lib/config');
const { STATUS } = require('../lib/evaluate');
const { HistoryStore } = require('../lib/store');
const { Monitor } = require('../lib/monitor');
const { NextcloudClient } = require('../lib/nextcloud');
const { startMockRelay } = require('./helpers/mock-relay');
const { startMockNextcloud, TOKEN } = require('./helpers/mock-nextcloud');

const MIN = 60_000;
const str = (env, key, fallback = '') => (env[key] === undefined || env[key] === '' ? fallback : String(env[key]));
const ev = (statuses) => ({
  overall: STATUS.OPERATIONAL,
  components: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status, message: status === STATUS.MAJOR ? 'Answered HTTP 502' : 'ok' }])),
});
const names = { web: 'Web interface & file sync', 'svc-pit-wall': 'Pit Wall', 'svc-logbook': 'Logbook' };

function manager(relayUrl, extra = {}) {
  const alerts = parseAlertConfig({ ALERT_EMAIL_API_URL: relayUrl, ALERT_EMAIL_API_KEY: 'relay-key', ALERT_EMAIL_TO: 'me@example.com', STATUS_PAGE_URL: 'https://status.example.com', ...extra.env }, str);
  return new AlertManager({
    alerts,
    threshold: 2,
    timeZone: 'Australia/Brisbane',
    siteTitle: 'NAS Status',
    nameOf: (id) => names[id] || id,
    sender: new MailRelaySender({ url: alerts.url, apiKey: alerts.apiKey }),
    enabled: true,
    ...extra.opts,
  });
}

test('alert settings: base URL gets /api/send, lists and validation', () => {
  const a = parseAlertConfig({ ALERT_EMAIL_API_URL: 'mail.lbdev.app', ALERT_EMAIL_TO: 'a@example.com, b@example.com', ALERT_EMAIL_API_KEY: 'k' }, str);
  assert.equal(a.url, 'https://mail.lbdev.app/api/send');
  assert.deepEqual(a.to, ['a@example.com', 'b@example.com']);
  assert.equal(a.onRecovery, true);
  assert.equal(parseAlertConfig({ ALERT_EMAIL_API_URL: 'https://mail.example.com/api/send' }, str).url, 'https://mail.example.com/api/send');
  assert.equal(parseAlertConfig({ ALERT_ON_RECOVERY: 'false' }, str).onRecovery, false);
  assert.throws(() => parseAlertConfig({ ALERT_EMAIL_TO: 'not-an-email' }, str), /invalid address/);
  assert.throws(() => parseAlertConfig({ ALERT_EMAIL_TO: new Array(11).fill('a@example.com').join(',') }, str), /at most 10/);
  assert.throws(() => parseAlertConfig({ ALERT_EMAIL_API_URL: 'ftp://x.example' }, str), /https/);
  assert.equal(buildConfig({ NEXTCLOUD_URL: 'https://nas.example' }).alerts.to.length, 0);
});

test('one email when something goes down, one when it is back, none for blips', async (t) => {
  const relay = await startMockRelay();
  t.after(() => relay.close());
  const m = manager(`${relay.url}/api/send`);
  const t0 = Date.UTC(2026, 9, 26, 0, 0);
  const up = { web: STATUS.OPERATIONAL, 'svc-pit-wall': STATUS.OPERATIONAL };
  const down = { web: STATUS.OPERATIONAL, 'svc-pit-wall': STATUS.MAJOR };

  await m.process(t0, ev(up));
  await m.process(t0 + MIN, ev(down)); // a single failed check: a blip
  await m.process(t0 + 2 * MIN, ev(up));
  assert.equal(relay.state.received.length, 0, 'a single failed check never emails');

  await m.process(t0 + 3 * MIN, ev(down));
  await m.process(t0 + 4 * MIN, ev(down));
  assert.equal(relay.state.received.length, 1);
  const email = relay.state.received[0];
  assert.equal(email.subject, '[NAS Status] Pit Wall is down');
  assert.equal(email.to, 'me@example.com', 'a single recipient is sent as a plain address');
  assert.equal(email.fromName, 'NAS Status');
  assert.equal(email.headers.authorization, 'Bearer relay-key');
  assert.match(email.text, /Answered HTTP 502/);
  assert.match(email.text, /Down since .*1(0|1):03/); // 00:03 UTC is 10:03 am in Brisbane
  assert.match(email.html, /https:\/\/status\.example\.com/);

  await m.process(t0 + 5 * MIN, ev(down));
  await m.process(t0 + 6 * MIN, ev(up)); // one good check is not a recovery yet...
  await m.process(t0 + 7 * MIN, ev(down)); // ...and the outage start time survives it
  await m.process(t0 + 8 * MIN, ev(up));
  await m.process(t0 + 9 * MIN, ev(up));
  assert.equal(relay.state.received.length, 2);
  assert.equal(relay.state.received[1].subject, '[NAS Status] Pit Wall is back up');
  assert.match(relay.state.received[1].text, /Down for 5 min/); // 00:03 to 00:08
});

test('several things going down together arrive in one email', async (t) => {
  const relay = await startMockRelay();
  t.after(() => relay.close());
  const m = manager(relay.url, { env: { ALERT_EMAIL_TO: 'me@example.com,you@example.com' } });
  const both = { web: STATUS.MAJOR, 'svc-pit-wall': STATUS.MAJOR, 'svc-logbook': STATUS.OPERATIONAL };
  await m.process(0, ev(both));
  await m.process(MIN, ev(both));
  assert.equal(relay.state.received.length, 1);
  assert.match(relay.state.received[0].subject, /2 services are down: Web interface & file sync, Pit Wall/);
  assert.deepEqual(relay.state.received[0].to, ['me@example.com', 'you@example.com']);
});

test('"No data" (Access blocks) and maintenance never cause emails', async (t) => {
  const relay = await startMockRelay();
  t.after(() => relay.close());
  const m = manager(relay.url);
  for (let i = 0; i < 5; i += 1) await m.process(i * MIN, ev({ web: STATUS.UNKNOWN, 'svc-pit-wall': STATUS.MAINTENANCE }));
  assert.equal(relay.state.received.length, 0);
});

test('failed sends are retried on later checks, then given up', async (t) => {
  const relay = await startMockRelay({ mode: 'fail' });
  t.after(() => relay.close());
  const m = manager(relay.url);
  const down = { 'svc-pit-wall': STATUS.MAJOR };
  await m.process(0, ev(down));
  await m.process(MIN, ev(down));
  assert.equal(m.queue.length, 1);
  assert.match(m.summary().lastError, /HTTP 502: the relay could not deliver through Gmail/);
  relay.state.mode = 'ok';
  await m.process(2 * MIN, ev(down));
  assert.equal(relay.state.received.length, 1, 'the queued email goes out once the relay recovers');
  assert.equal(m.queue.length, 0);
  assert.equal(m.summary().lastError, null);

  relay.state.mode = 'fail';
  const m2 = manager(relay.url);
  await m2.process(0, ev(down));
  for (let i = 1; i <= 8; i += 1) await m2.process(i * MIN, ev(down));
  assert.equal(m2.queue.length, 0, 'dropped after the maximum number of attempts');
});

test('a wrong API key is explained', async (t) => {
  const relay = await startMockRelay({ key: 'other-key' });
  t.after(() => relay.close());
  const sender = new MailRelaySender({ url: `${relay.url}/api/send`, apiKey: 'relay-key' });
  await assert.rejects(sender.send({ to: ['me@example.com'], subject: 's', text: 't' }), /HTTP 401: the relay rejected the API key/);
  const wrongPath = new MailRelaySender({ url: `${relay.url}/nope`, apiKey: 'relay-key' });
  await assert.rejects(wrongPath.send({ to: ['me@example.com'], subject: 's', text: 't' }), /HTTP 404/);
});

test('no more than the hourly cap is sent', async (t) => {
  const relay = await startMockRelay();
  t.after(() => relay.close());
  const m = manager(relay.url);
  for (let i = 0; i < MAX_SENDS_PER_HOUR + 5; i += 1) m.queue.push({ subject: `s${i}`, text: 't', html: 'h', createdAt: 0, attempts: 0 });
  for (let i = 0; i < 20; i += 1) await m.flush(i * 1000);
  assert.equal(relay.state.received.length, MAX_SENDS_PER_HOUR);
  assert.match(m.summary().lastError, /Paused/);
});

test('end to end: the monitor emails when an app goes down and remembers it across a restart', async (t) => {
  const relay = await startMockRelay();
  const nc = await startMockNextcloud();
  t.after(async () => { await relay.close(); await nc.close(); });
  const env = {
    NEXTCLOUD_URL: nc.url,
    NEXTCLOUD_TOKEN: TOKEN,
    TIMEZONE: 'Australia/Brisbane',
    ALERT_EMAIL_API_URL: relay.url,
    ALERT_EMAIL_API_KEY: 'relay-key',
    ALERT_EMAIL_TO: 'me@example.com',
    SERVICES: JSON.stringify([{ name: 'Pit Wall', url: `${nc.url}/missing-page` }]),
  };
  const make = (store) => {
    const config = buildConfig(env);
    const alerts = new AlertManager({
      alerts: config.alerts, threshold: config.incidentThreshold, timeZone: config.timeZone, siteTitle: config.siteTitle,
      nameOf: (id) => store.componentName(id), sender: new MailRelaySender({ url: config.alerts.url, apiKey: config.alerts.apiKey }), enabled: true,
    });
    return new Monitor({ config, store, client: new NextcloudClient(config.nextcloud, { timeoutMs: 2000 }), alerts });
  };
  const store = new HistoryStore({ timeZone: 'Australia/Brisbane', incidentThreshold: 2, pollIntervalMs: MIN });
  const monitor = make(store);
  const now = Date.now();
  await monitor.runOnce(now);
  await monitor.runOnce(now + MIN);
  assert.equal(relay.state.received.length, 1);
  assert.equal(relay.state.received[0].subject, '[NAS Status] Pit Wall is down');

  // Restart: the "already down" state is restored, so no duplicate email.
  const saved = monitor.exportState();
  const restarted = make(store);
  restarted.importState(saved);
  await restarted.runOnce(now + 2 * MIN);
  assert.equal(relay.state.received.length, 1);
});
