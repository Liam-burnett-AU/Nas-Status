#!/usr/bin/env node
'use strict';

/**
 * Sends one test email through the Mail Relay, using the same settings the
 * status page uses (from .env or the environment).
 *
 *   npm run alert:test
 */

const path = require('node:path');
const { loadDotEnv } = require('../lib/dotenv');
const { parseAlertConfig, MailRelaySender } = require('../lib/alerts');

function str(env, key, fallback = '') {
  const v = env[key];
  return v === undefined || v === '' ? fallback : String(v);
}

async function main() {
  loadDotEnv(path.join(process.cwd(), '.env'));
  let a;
  try {
    a = parseAlertConfig(process.env, str);
  } catch (err) {
    console.log(`✘ ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const missing = [!a.url && 'ALERT_EMAIL_API_URL', !a.apiKey && 'ALERT_EMAIL_API_KEY', !a.to.length && 'ALERT_EMAIL_TO'].filter(Boolean);
  if (missing.length) {
    console.log(`✘ Set ${missing.join(', ')} in .env first.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Sending a test email to ${a.to.join(', ')} through ${a.url} ...`);
  try {
    await new MailRelaySender({ url: a.url, apiKey: a.apiKey }).send({
      to: a.to,
      fromName: a.fromName,
      subject: `[${process.env.SITE_TITLE || 'NAS Status'}] Test alert`,
      text: 'This is a test from your status page. If you can read this, down and recovery alerts will reach you.',
      html: '<p>This is a test from your status page.</p><p>If you can read this, down and recovery alerts will reach you.</p>',
    });
    console.log('✔ Sent. Check your inbox (and spam folder).');
  } catch (err) {
    console.log(`✘ ${err.message}`);
    process.exitCode = 1;
  }
}

main();
