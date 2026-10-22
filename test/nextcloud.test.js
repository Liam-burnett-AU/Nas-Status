'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NextcloudClient } = require('../lib/nextcloud');
const { startMockNextcloud, TOKEN } = require('./helpers/mock-nextcloud');

test('client sends the NC-Token and OCS headers and unwraps the payload', async (t) => {
  const mock = await startMockNextcloud();
  t.after(() => mock.close());
  const client = new NextcloudClient({ baseUrl: mock.url, token: TOKEN }, { timeoutMs: 2000 });
  const { data, elapsedMs } = await client.getServerInfo();
  assert.equal(data.nextcloud.system.cpunum, 4);
  assert.ok(elapsedMs >= 0);
  const req = mock.state.requests.at(-1);
  assert.equal(req.headers['nc-token'], TOKEN);
  assert.equal(req.headers['ocs-apirequest'], 'true');
  assert.equal(req.headers.authorization, undefined);
  assert.match(req.url, /format=json/);
  assert.match(req.url, /skipApps=false/);
});

test('a wrong token is reported as an auth error that names the token', async (t) => {
  const mock = await startMockNextcloud();
  t.after(() => mock.close());
  const client = new NextcloudClient({ baseUrl: mock.url, token: 'wrong' }, { timeoutMs: 2000 });
  await assert.rejects(client.getServerInfo(), (err) => err.kind === 'auth' && err.mode === 'token' && /monitoring token \(NEXTCLOUD_TOKEN\)/.test(err.message));
});

test('a wrong app password is reported as such, naming the account', async (t) => {
  const mock = await startMockNextcloud();
  t.after(() => mock.close());
  const client = new NextcloudClient({ baseUrl: mock.url, user: 'admin', appPassword: 'nope' }, { timeoutMs: 2000 });
  await assert.rejects(client.getServerInfo(), (err) => err.mode === 'basic' && /app password for "admin"/.test(err.message) && /must be an admin/.test(err.message));
});

test('admin endpoints use basic auth', async (t) => {
  const mock = await startMockNextcloud();
  t.after(() => mock.close());
  const client = new NextcloudClient({ baseUrl: mock.url, token: TOKEN, user: 'admin', appPassword: 'app-pass' }, { timeoutMs: 2000 });
  assert.deepEqual(await client.getDiskData(), [[20.5, 79.5], [524.3, 500.0]]);
  assert.equal(mock.state.requests.at(-1).headers['nc-token'], undefined);
  const bad = new NextcloudClient({ baseUrl: mock.url, user: 'admin', appPassword: 'nope' }, { timeoutMs: 2000 });
  await assert.rejects(bad.getDiskData(), (err) => err.kind === 'auth');
});

test('HTML instead of JSON gives a helpful trusted_domains hint', async (t) => {
  const mock = await startMockNextcloud({ mode: 'html' });
  t.after(() => mock.close());
  const client = new NextcloudClient({ baseUrl: mock.url }, { timeoutMs: 2000 });
  await assert.rejects(client.getStatus(), (err) => err.kind === 'parse' && /trusted_domains/.test(err.message));
});

test('timeouts and dropped connections are classified', async (t) => {
  const mock = await startMockNextcloud({ delayMs: 500 });
  t.after(() => mock.close());
  const client = new NextcloudClient({ baseUrl: mock.url }, { timeoutMs: 100 });
  await assert.rejects(client.getStatus(), (err) => err.kind === 'timeout');
  mock.state.delayMs = 0;
  mock.state.mode = 'down';
  await assert.rejects(client.getStatus(), (err) => err.kind === 'network');
});

test('unreachable host is a network error', async () => {
  // Grab a free port, then close it so nothing is listening there.
  const net = require('node:net');
  const port = await new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  const client = new NextcloudClient({ baseUrl: `http://127.0.0.1:${port}` }, { timeoutMs: 2000 });
  await assert.rejects(client.getStatus(), (err) => err.kind === 'network' && /refused/i.test(err.message));
});
