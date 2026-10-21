'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, STATUS } = require('../lib/evaluate');
const { normaliseServerInfo, normaliseStatusPhp } = require('../lib/normalise');
const { serverInfoPayload } = require('./helpers/mock-nextcloud');
const { loadConfig } = require('../lib/config');

const T = loadConfig({ NEXTCLOUD_URL: 'https://cloud.example.com' }, { dotenvPath: null }).thresholds;
const okWeb = (extra = {}) => ({ ok: true, elapsedMs: 120, error: null, status: normaliseStatusPhp({ installed: true, maintenance: false, ...extra }) });
const okApi = (info = serverInfoPayload(), diskData = null) => ({ configured: true, ok: true, elapsedMs: 300, info: normaliseServerInfo(info, { diskData }) });

test('all healthy is operational', () => {
  const e = evaluate({ web: okWeb(), api: okApi() }, T);
  assert.equal(e.overall, STATUS.OPERATIONAL);
  for (const c of Object.values(e.components)) assert.equal(c.status, STATUS.OPERATIONAL);
});

test('unreachable server is a major outage across web and API', () => {
  const e = evaluate({ web: { ok: false, error: 'Connection refused' }, api: { configured: true, ok: false, error: 'x', errorKind: 'network' } }, T);
  assert.equal(e.overall, STATUS.MAJOR);
  assert.equal(e.components.web.status, STATUS.MAJOR);
  assert.equal(e.components.api.status, STATUS.MAJOR);
  assert.equal(e.components.storage.status, STATUS.UNKNOWN);
});

test('maintenance mode wins over everything', () => {
  const e = evaluate({ web: okWeb({ maintenance: true }), api: { configured: true, ok: false, error: 'HTTP 503', errorKind: 'http' } }, T);
  assert.equal(e.overall, STATUS.MAINTENANCE);
  assert.equal(e.components.api.status, STATUS.MAINTENANCE);
});

test('slow responses are degraded', () => {
  const web = okWeb();
  web.elapsedMs = T.webSlowMs + 1;
  const e = evaluate({ web, api: okApi() }, T);
  assert.equal(e.components.web.status, STATUS.DEGRADED);
  assert.equal(e.overall, STATUS.DEGRADED);
});

test('API failure while web works is a partial outage', () => {
  const e = evaluate({ web: okWeb(), api: { configured: true, ok: false, error: 'HTTP 500', errorKind: 'http' } }, T);
  assert.equal(e.components.api.status, STATUS.PARTIAL);
  assert.equal(e.overall, STATUS.PARTIAL);
});

test('a rejected token is a monitor configuration problem, not an outage', () => {
  const e = evaluate({ web: okWeb(), api: { configured: true, ok: false, error: 'Authentication rejected', errorKind: 'auth' } }, T);
  assert.equal(e.components.api.status, STATUS.UNKNOWN);
  assert.equal(e.overall, STATUS.OPERATIONAL);
});

test('low disk space by percent and by absolute free space', () => {
  const byPct = evaluate({ web: okWeb(), api: okApi(serverInfoPayload({ system: { freespace: 30 * 1024 ** 3 } }), [[970, 30]]) }, T);
  assert.equal(byPct.components.storage.status, STATUS.PARTIAL); // 97% used >= 95
  const warnPct = evaluate({ web: okWeb(), api: okApi(serverInfoPayload({ system: { freespace: 100 * 1024 ** 3 } }), [[900, 100]]) }, T);
  assert.equal(warnPct.components.storage.status, STATUS.DEGRADED); // 90% used
  const byFree = evaluate({ web: okWeb(), api: okApi(serverInfoPayload({ system: { freespace: 20 * 1024 ** 3 } })) }, T);
  assert.equal(byFree.components.storage.status, STATUS.DEGRADED); // 20 GB <= 50 GB warn
});

test('high CPU or memory degrades the resources component', () => {
  const e = evaluate({ web: okWeb(), api: okApi(serverInfoPayload({ system: { cpuload: [3.9, 2, 1], mem_free: 100 } })) }, T);
  assert.equal(e.components.resources.status, STATUS.DEGRADED);
  assert.match(e.components.resources.message, /CPU/);
  assert.match(e.components.resources.message, /memory/);
});

test('without credentials the API is unknown and the page still works', () => {
  const e = evaluate({ web: okWeb(), api: { configured: false, ok: false, error: 'Not configured' } }, T);
  assert.equal(e.components.api.status, STATUS.UNKNOWN);
  assert.equal(e.overall, STATUS.OPERATIONAL);
});
