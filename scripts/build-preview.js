#!/usr/bin/env node
'use strict';

/**
 * Builds dist/preview.html: a single self-contained file with the page, its
 * CSS/JS and a frozen snapshot of demo data. Handy for sharing what the
 * status page looks like without running the server.
 *
 *   node scripts/build-preview.js [--tz Australia/Brisbane] [--out dist/preview.html]
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../lib/config');
const { HistoryStore, RANGES } = require('../lib/store');
const { Monitor } = require('../lib/monitor');
const { DemoClient, backfill } = require('../lib/demo');
const { buildStatus } = require('../lib/api');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const root = path.join(__dirname, '..');
  const timeZone = arg('tz', process.env.TIMEZONE || 'Australia/Brisbane');
  const out = path.resolve(root, arg('out', 'dist/preview.html'));
  const config = loadConfig({ DEMO_MODE: 'true', TIMEZONE: timeZone, SITE_TITLE: process.env.SITE_TITLE || 'NAS Status' }, { dotenvPath: null });

  const store = new HistoryStore({ timeZone, incidentThreshold: config.incidentThreshold, pollIntervalMs: config.pollIntervalMs });
  const client = new DemoClient({ timeZone });
  const monitor = new Monitor({ config, store, client });
  const now = Date.now();
  await backfill(monitor, client, { now });
  await monitor.runOnce(now);

  const snapshot = {
    status: buildStatus({ config, store, monitor, now }),
    history: Object.fromEntries(Object.keys(RANGES).map((r) => [r, store.history(r, now)])),
  };

  const pub = path.join(root, 'public');
  const read = (p) => fs.readFileSync(path.join(pub, p), 'utf8');
  // JSON inside <script> must not be able to close the tag.
  const json = JSON.stringify(snapshot)
    .replace(/</g, '\\u003c')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
  const favicon = `data:image/svg+xml;base64,${Buffer.from(read('favicon.svg')).toString('base64')}`;
  const inlineScript = (file) => `<script>\n${read(file).replace(/<\/script/gi, '<\\/script')}\n</script>`;

  let html = read('index.html');
  const replaceOnce = (needle, replacement) => {
    if (!html.includes(needle)) throw new Error(`build-preview: could not find ${needle} in index.html`);
    html = html.replace(needle, () => replacement);
  };
  replaceOnce('<link rel="icon" href="favicon.svg" type="image/svg+xml">', `<link rel="icon" href="${favicon}" type="image/svg+xml">`);
  replaceOnce('<link rel="stylesheet" href="css/styles.css">', `<style>\n${read('css/styles.css')}\n</style>`);
  replaceOnce('<script src="js/format.js" defer></script>', '');
  replaceOnce('<script src="js/charts.js" defer></script>', '');
  replaceOnce('<script src="js/app.js" defer></script>', '');
  replaceOnce('</body>', `<script>window.__NAS_STATUS_STATIC__ = ${json};</script>\n${inlineScript('js/format.js')}\n${inlineScript('js/charts.js')}\n${inlineScript('js/app.js')}\n</body>`);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`Wrote ${path.relative(process.cwd(), out)} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${timeZone})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
