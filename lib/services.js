'use strict';

// Runtime-agnostic HTTP checks for the other apps listed in SERVICES.
const { describeFrontDoor, describeNetworkError, USER_AGENT } = require('./nextcloud');

const MAX_SERVICES = 20; // keeps each check well inside the Workers Free limit of 50 subrequests
const STATUS = { OPERATIONAL: 'operational', DEGRADED: 'degraded', MAJOR: 'major_outage', UNKNOWN: 'unknown' };

function slug(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

/** Accepts "sharesafe.lbdev.app" or a full URL; host names are lower-cased. */
function normaliseServiceUrl(raw, name) {
  let text = String(raw || '').trim();
  if (!text) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`SERVICES: "${name}" has an invalid url "${raw}"`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`SERVICES: "${name}" url must start with http:// or https://`);
  if (url.username || url.password) throw new Error(`SERVICES: "${name}" url must not contain a user name or password`);
  url.hash = '';
  return url.toString();
}

/**
 * expectStatus accepts codes (405), classes ("4xx") and ranges ("200-299"),
 * alone or in a list. Stored as [low, high] pairs plus the original labels.
 */
function parseExpect(value, name) {
  if (value === undefined || value === null) return null;
  const items = Array.isArray(value) ? value : [value];
  const ranges = [];
  const labels = [];
  for (const item of items) {
    const text = String(item).trim().toLowerCase();
    let range = null;
    if (/^\d{3}$/.test(text)) range = [Number(text), Number(text)];
    else if (/^[1-5]xx$/.test(text)) range = [Number(text[0]) * 100, Number(text[0]) * 100 + 99];
    else if (/^\d{3}\s*-\s*\d{3}$/.test(text)) range = text.split('-').map((n) => Number(n.trim()));
    if (!range || range[0] < 100 || range[1] > 599 || range[0] > range[1]) {
      throw new Error(`SERVICES: "${name}" expectStatus must be status codes such as 200, "4xx" or "200-299" (got ${JSON.stringify(item)})`);
    }
    ranges.push(range);
    labels.push(text);
  }
  if (!ranges.length) throw new Error(`SERVICES: "${name}" expectStatus is empty`);
  return { ranges, labels };
}

function statusExpected(expect, code) {
  if (!expect) return code >= 200 && code < 400;
  return expect.ranges.some(([lo, hi]) => code >= lo && code <= hi);
}

/**
 * Parse the SERVICES setting: a JSON array (or, from wrangler.jsonc, an
 * already-parsed array) of { name, url, ... } objects.
 */
function parseServices(raw, { timeoutMs, slowMs, relayUrl = '' }) {
  if (raw === undefined || raw === null || raw === '') return [];
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch (err) {
      throw new Error(`SERVICES must be a JSON array of apps (${err.message})`);
    }
  }
  if (!Array.isArray(list)) throw new Error('SERVICES must be a JSON array of apps, for example [{"name":"Logbook","url":"https://logbook.example.com"}]');
  if (list.length > MAX_SERVICES) throw new Error(`SERVICES can list at most ${MAX_SERVICES} apps`);

  const seen = new Set();
  return list.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`SERVICES entry ${i + 1} must be an object with a name and a url`);
    const name = String(item.name || '').trim();
    if (!name) throw new Error(`SERVICES entry ${i + 1} needs a name`);
    let id = `svc-${slug(item.id || name)}`;
    while (seen.has(id)) id += '-2';
    seen.add(id);
    const method = String(item.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) throw new Error(`SERVICES: "${name}" method must be GET or HEAD`);
    const timeout = item.timeoutSeconds === undefined ? timeoutMs : Number(item.timeoutSeconds) * 1000;
    if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 120_000) throw new Error(`SERVICES: "${name}" timeoutSeconds must be between 1 and 120`);
    const slow = item.slowMs === undefined ? slowMs : Number(item.slowMs);
    if (!Number.isFinite(slow) || slow < 50) throw new Error(`SERVICES: "${name}" slowMs must be at least 50`);
    const keyword = item.keyword === undefined || item.keyword === null ? null : String(item.keyword);
    // relay: true checks the Mail Relay used for email alerts (ALERT_EMAIL_API_URL).
    // Its /api/send endpoint only accepts POST, so a 405 to this GET means it is up.
    const relay = item.relay === true;
    if (keyword !== null && method === 'HEAD') throw new Error(`SERVICES: "${name}" cannot check a keyword with HEAD`);
    return Object.freeze({
      id,
      name: name.slice(0, 60),
      description: item.description ? String(item.description).slice(0, 140) : '',
      url: relay && !item.url ? relayUrl : normaliseServiceUrl(item.url, name),
      method,
      expectStatus: parseExpect(item.expectStatus ?? (relay ? [405] : undefined), name),
      relay,
      keyword,
      timeoutMs: timeout,
      slowMs: slow,
      access: item.access === true,
    });
  });
}

function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function expectedText(svc) {
  return svc.expectStatus ? svc.expectStatus.labels.join(', ') : '200-399';
}

/**
 * Check one app. Never throws.
 * @returns {Promise<{status: string, message: string, elapsedMs: number|null, httpStatus: number|null}>}
 */
async function checkService(svc, { fetchImpl, accessHeaders = null } = {}) {
  if (!svc.url) {
    const message = svc.relay ? 'Set ALERT_EMAIL_API_URL to check the mail relay' : 'No address set up yet';
    return { status: STATUS.UNKNOWN, message, elapsedMs: null, httpStatus: null };
  }
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const clock = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
  const headers = { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' };
  const sentAccessToken = Boolean(svc.access && accessHeaders);
  if (sentAccessToken) Object.assign(headers, accessHeaders);

  const started = clock();
  let res;
  let body = '';
  try {
    res = await doFetch(svc.url, { method: svc.method, headers, redirect: 'manual', signal: AbortSignal.timeout(svc.timeoutMs) });
    if (svc.method !== 'HEAD') body = await res.text();
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: STATUS.MAJOR,
      message: timedOut ? `No response within ${Math.round(svc.timeoutMs / 1000)} s` : `Unreachable: ${describeNetworkError(err)}`,
      elapsedMs: null,
      httpStatus: null,
    };
  }
  const elapsedMs = Math.round(clock() - started);
  const code = res.status;
  const expected = statusExpected(svc.expectStatus, code);

  // Cloudflare-level answers come first: they say nothing about the app behind them.
  // Only failed responses are inspected for block pages, so a healthy page that happens
  // to mention "Cloudflare Access" is never mistaken for one.
  const frontDoor = describeFrontDoor(res, res.ok ? '' : body, { sentAccessToken, target: svc.name, includeBasicAuth: !expected });
  if (frontDoor) {
    return { status: frontDoor.down ? STATUS.MAJOR : STATUS.UNKNOWN, message: frontDoor.message, elapsedMs, httpStatus: code };
  }
  if (!expected) {
    if (code >= 520 && code <= 530) {
      return { status: STATUS.MAJOR, message: `Cloudflare could not reach the server (HTTP ${code})`, elapsedMs, httpStatus: code };
    }
    return { status: STATUS.MAJOR, message: `Answered HTTP ${code} (expected ${expectedText(svc)})`, elapsedMs, httpStatus: code };
  }
  if (svc.keyword !== null && !body.includes(svc.keyword)) {
    return { status: STATUS.MAJOR, message: `Answered HTTP ${code}, but "${svc.keyword}" was not on the page`, elapsedMs, httpStatus: code };
  }
  if (elapsedMs > svc.slowMs) {
    return { status: STATUS.DEGRADED, message: `Responding slowly (${formatMs(elapsedMs)})`, elapsedMs, httpStatus: code };
  }
  return { status: STATUS.OPERATIONAL, message: `Responding in ${formatMs(elapsedMs)}`, elapsedMs, httpStatus: code };
}

module.exports = { parseServices, checkService, normaliseServiceUrl, MAX_SERVICES };
