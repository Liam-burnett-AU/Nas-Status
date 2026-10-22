'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConfig } = require('../lib/config');

const load = (env) => buildConfig(env);

test('requires NEXTCLOUD_URL unless in demo mode', () => {
  assert.throws(() => load({}), /NEXTCLOUD_URL is required/);
  assert.equal(load({ DEMO_MODE: 'true' }).demo, true);
});

test('strips trailing slashes and validates the URL', () => {
  assert.equal(load({ NEXTCLOUD_URL: 'https://cloud.example.com/' }).nextcloud.baseUrl, 'https://cloud.example.com');
  assert.equal(load({ NEXTCLOUD_URL: 'https://example.com/nextcloud//' }).nextcloud.baseUrl, 'https://example.com/nextcloud');
  assert.throws(() => load({ NEXTCLOUD_URL: 'ftp://x' }), /http/);
  assert.throws(() => load({ NEXTCLOUD_URL: 'not a url' }), /valid URL/);
});

test('cleans up pasted secrets and rejects inner whitespace', () => {
  const base = { NEXTCLOUD_URL: 'https://c.example' };
  assert.equal(load({ ...base, NEXTCLOUD_TOKEN: '  abc123\n' }).nextcloud.token, 'abc123');
  assert.equal(load({ ...base, NEXTCLOUD_TOKEN: '"abc123"' }).nextcloud.token, 'abc123');
  assert.equal(load({ ...base, NEXTCLOUD_TOKEN: "'abc123'" }).nextcloud.token, 'abc123');
  assert.throws(() => load({ ...base, NEXTCLOUD_TOKEN: 'abc 123' }), /space or line break/);
  const c = load({ ...base, NEXTCLOUD_USER: ' admin ', NEXTCLOUD_APP_PASSWORD: ' aBcDe-FgHiJ-kLmNo-PqRsT-uVwXy\n' });
  assert.equal(c.nextcloud.user, 'admin');
  assert.equal(c.nextcloud.appPassword, 'aBcDe-FgHiJ-kLmNo-PqRsT-uVwXy');
});

test('validates numbers, booleans, time zones and pairs', () => {
  const base = { NEXTCLOUD_URL: 'https://c.example' };
  assert.throws(() => load({ ...base, POLL_INTERVAL_SECONDS: '5' }), /between 15/);
  assert.throws(() => load({ ...base, POLL_INTERVAL_SECONDS: 'abc' }), /number/);
  assert.throws(() => load({ ...base, SHOW_SERVER_DETAILS: 'maybe' }), /true or false/);
  assert.throws(() => load({ ...base, TIMEZONE: 'Mars/Olympus' }), /time zone/);
  assert.throws(() => load({ ...base, NEXTCLOUD_USER: 'admin' }), /together/);
  assert.throws(() => load({ ...base, CF_ACCESS_CLIENT_ID: 'id.access' }), /together/);
  assert.throws(() => load({ ...base, DISK_WARN_PERCENT: '96', DISK_CRITICAL_PERCENT: '90' }), /DISK_CRITICAL_PERCENT/);
  const c = load({ ...base, POLL_INTERVAL_SECONDS: '30', TIMEZONE: 'Australia/Brisbane', SHOW_SERVER_DETAILS: 'no' });
  assert.equal(c.pollIntervalMs, 30_000);
  assert.equal(c.timeZone, 'Australia/Brisbane');
  assert.equal(c.showServerDetails, false);
});
