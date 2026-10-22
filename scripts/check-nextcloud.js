#!/usr/bin/env node
'use strict';

/**
 * Checks that NAS Status can talk to your Nextcloud, step by step.
 *
 *   npm run check                                   # uses .env / environment variables
 *   npm run check -- https://cloud.example.com TOKEN
 *
 * Run it from outside your home network (for example a laptop on a phone
 * hotspot) to see what Cloudflare sees.
 */

const path = require('node:path');
const { loadDotEnv } = require('../lib/dotenv');
const { buildConfig } = require('../lib/config');
const { NextcloudClient } = require('../lib/nextcloud');

const ok = (msg) => console.log(`  ✔ ${msg}`);
const bad = (msg) => console.log(`  ✘ ${msg}`);

async function main() {
  loadDotEnv(path.join(process.cwd(), '.env'));
  const [url, token] = process.argv.slice(2);
  if (url) process.env.NEXTCLOUD_URL = url;
  if (token) process.env.NEXTCLOUD_TOKEN = token;

  let config;
  try {
    config = buildConfig(process.env);
  } catch (err) {
    bad(`Configuration: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const nc = config.nextcloud;
  console.log(`Checking ${nc.baseUrl}\n`);
  let failed = false;

  const tokenOnly = new NextcloudClient({ ...nc, user: '', appPassword: '' }, { timeoutMs: config.requestTimeoutMs });
  try {
    const { data, elapsedMs } = await tokenOnly.getStatus();
    ok(`status.php answered in ${elapsedMs} ms (${data.productname || 'Nextcloud'} ${data.versionstring || ''}${data.maintenance ? ', maintenance mode ON' : ''})`);
  } catch (err) {
    bad(`status.php: ${err.message}`);
    console.log('\n  Nextcloud is not reachable at this address, so the other checks are skipped.');
    process.exitCode = 1;
    return;
  }

  if (nc.token) {
    console.log(`\n  Monitoring token: ${nc.token.length} characters`);
    try {
      const { data } = await tokenOnly.getServerInfo();
      ok(`Token accepted (serverinfo reports Nextcloud ${data?.nextcloud?.system?.version || 'unknown'})`);
    } catch (err) {
      failed = true;
      bad(`Token: ${err.message}.`);
      console.log('    Read it on the server with:  sudo -u www-data php occ config:app:get serverinfo token');
      console.log('    All-in-One:                  sudo docker exec --user www-data nextcloud-aio-nextcloud php occ config:app:get serverinfo token');
    }
  } else {
    console.log('\n  No NEXTCLOUD_TOKEN set: skipping the token check.');
  }

  if (nc.user && nc.appPassword) {
    const admin = new NextcloudClient({ ...nc, token: '' }, { timeoutMs: config.requestTimeoutMs });
    try {
      await admin.getDiskData();
      ok(`App password for "${nc.user}" accepted (admin endpoints work)`);
    } catch (err) {
      failed = true;
      bad(`App password: ${err.message}.`);
    }
  }

  console.log(failed ? '\nSome checks failed. Fix them, then update the secret and redeploy.' : '\nAll checks passed.');
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
