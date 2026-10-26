'use strict';

const http = require('node:http');

/** A stand-in for the Mail Relay's POST /api/send, following its documented behaviour. */
async function startMockRelay({ key = 'relay-key', mode = 'ok' } = {}) {
  const state = { key, mode, received: [] };
  const server = http.createServer((req, res) => {
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url !== '/api/send') return json(404, { error: 'Not found' });
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    if (req.headers.authorization !== `Bearer ${state.key}`) return json(401, { error: 'Unauthorized' });
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { return json(400, { error: 'Invalid JSON' }); }
      const to = Array.isArray(body.to) ? body.to : [body.to];
      if (!body.to || to.length > 10 || !body.subject || !(body.text || body.html)) return json(400, { error: 'Missing or invalid field' });
      if (state.mode === 'fail') return json(502, { error: 'SMTP step failed' });
      state.received.push({ ...body, headers: req.headers });
      return json(200, { ok: true });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

module.exports = { startMockRelay };
