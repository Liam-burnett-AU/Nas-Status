'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { startMockNextcloud, TOKEN } = require('./helpers/mock-nextcloud');

const script = path.join(__dirname, '..', 'scripts', 'check-nextcloud.js');

function run(args, env = {}) {
  return new Promise((resolve) => {
    // Run from a temp dir so a developer's own .env is never picked up.
    execFile(process.execPath, [script, ...args], { cwd: os.tmpdir(), env: { PATH: process.env.PATH, ...env } }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, out: stdout });
    });
  });
}

test('check script passes with a good token and explains a bad one', async (t) => {
  const mock = await startMockNextcloud();
  t.after(() => mock.close());
  const good = await run([mock.url, TOKEN]);
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /Token accepted/);
  const badRun = await run([mock.url, 'not-the-token']);
  assert.equal(badRun.code, 1);
  assert.match(badRun.out, /rejected the monitoring token/);
  assert.match(badRun.out, /occ config:app:get serverinfo token/);
});

test('check script reports an unreachable server', async () => {
  const res = await run(['http://localhost:9', TOKEN]);
  assert.equal(res.code, 1);
  assert.match(res.out, /status\.php/);
});
