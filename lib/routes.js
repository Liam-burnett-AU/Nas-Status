'use strict';

// Runtime-agnostic API routing shared by server.js (Node) and src/worker.mjs (Workers).
const { RANGES } = require('./store');
const { buildStatus } = require('./api');

const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
});

const API_PATHS = ['/api/status', '/api/history', '/api/healthz', '/healthz'];

function isApiPath(pathname) {
  return pathname === '/healthz' || pathname.startsWith('/api/');
}

/**
 * @returns {{status: number, body: object}}
 */
function handleApi(pathname, searchParams, { config, store, monitor, now = Date.now() }) {
  if (pathname === '/api/status') {
    return { status: 200, body: buildStatus({ config, store, monitor, now }) };
  }
  if (pathname === '/api/history') {
    const range = searchParams.get('range') || '24h';
    if (!RANGES[range]) return { status: 400, body: { error: `range must be one of ${Object.keys(RANGES).join(', ')}` } };
    return { status: 200, body: store.history(range, now) };
  }
  if (pathname === '/healthz' || pathname === '/api/healthz') {
    const last = store.latest?.checkedAt ?? null;
    // Allow a little slack beyond three intervals for scheduler jitter.
    const fresh = last !== null && now - last < config.pollIntervalMs * 3 + 30_000;
    return { status: fresh ? 200 : 503, body: { ok: fresh, lastCheckAt: last, overall: store.latest?.evaluation?.overall ?? 'unknown' } };
  }
  return { status: 404, body: { error: 'Not found' } };
}

module.exports = { SECURITY_HEADERS, API_PATHS, isApiPath, handleApi };
