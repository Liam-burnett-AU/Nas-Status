'use strict';

const http = require('node:http');

const TOKEN = 'test-token-123';

function serverInfoPayload(overrides = {}) {
  return {
    nextcloud: {
      system: {
        version: '30.0.4.1',
        'memcache.local': '\\OC\\Memcache\\APCu',
        'memcache.distributed': 'none',
        'memcache.locking': '\\OC\\Memcache\\Redis',
        'filelocking.enabled': 'yes',
        debug: 'no',
        enable_previews: 'yes',
        enable_avatars: 'yes',
        freespace: 500 * 1024 ** 3,
        cpuload: [1, 0.8, 0.5],
        cpunum: 4,
        mem_total: 8 * 1024 * 1024, // KiB
        mem_free: 2 * 1024 * 1024, // KiB
        swap_total: 1024 * 1024,
        swap_free: 1024 * 1024,
        apps: { num_installed: 50, num_updates_available: 0, app_updates: [] },
        update: { lastupdatedat: 1_760_000_000, available: true, available_version: '30.0.5' },
        ...overrides.system,
      },
      storage: { num_users: 4, num_files: 1000, num_storages: 5, num_storages_local: 1, num_storages_home: 4, num_storages_other: 0 },
      shares: { num_shares: 3, num_shares_user: 1, num_shares_groups: 0, num_shares_link: 2, num_shares_mail: 0, num_shares_room: 0, num_shares_link_no_password: 1, num_fed_shares_sent: 0, num_fed_shares_received: 0 },
    },
    server: {
      webserver: 'nginx/1.27',
      php: { version: '8.2.20', memory_limit: 536870912, max_execution_time: 3600, upload_max_filesize: 536870912, opcache: [], apcu: [], extensions: ['a', 'b'] },
      fpm: { pool: 'www', 'process-manager': 'dynamic', 'active-processes': 1, 'idle-processes': 3, 'total-processes': 4, 'max-children-reached': 0, 'slow-requests': 0, 'accepted-conn': 99, 'listen-queue': 0, procs: [{ 'request-uri': '/secret?token=abc', user: 'alice' }] },
      database: { type: 'mysql', version: '10.11.6', size: '123456789' },
    },
    activeUsers: { last5minutes: 1, last1hour: 2, last24hours: 3, last7days: 4, last1month: 4, last3months: 4, last6months: 4, lastyear: 4 },
  };
}

/**
 * Start a fake Nextcloud. `state` can be mutated by tests between requests:
 *  mode: 'ok' | 'down' | 'maintenance' | 'html' | 'slow' | 'error500'
 */
async function startMockNextcloud(state = {}) {
  const s = { mode: 'ok', delayMs: 0, requests: [], info: serverInfoPayload(), ...state };
  const server = http.createServer(async (req, res) => {
    s.requests.push({ url: req.url, headers: req.headers });
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
    if (s.mode === 'down') {
      req.socket.destroy();
      return;
    }
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const ocs = (code, data, statuscode = code) => json(code, { ocs: { meta: { status: code < 300 ? 'ok' : 'failure', statuscode, message: code < 300 ? 'OK' : 'Error' }, data } });
    const url = new URL(req.url, 'http://x');

    // Simulated layers in front of Nextcloud.
    if (s.mode === 'access') {
      res.writeHead(403, { 'Content-Type': 'text/html', 'cf-ray': '8d1f2a3b4c5d6e7f-BNE' });
      return res.end('<html><title>Forbidden</title>Cloudflare Access</html>');
    }
    if (s.mode === 'access-redirect') {
      res.writeHead(302, { Location: 'https://lbdev.cloudflareaccess.com/cdn-cgi/access/login/nas.lbdev.app' });
      return res.end();
    }
    if (s.mode === 'challenge') {
      res.writeHead(403, { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge', 'cf-ray': '8d1f2a3b4c5d6e7f-BNE' });
      return res.end('<html>Just a moment...</html>');
    }
    if (s.mode === 'proxy-basic') {
      res.writeHead(401, { 'Content-Type': 'text/html', 'WWW-Authenticate': 'Basic realm="NAS"' });
      return res.end('<html>401 Authorization Required</html>');
    }
    if (s.mode === 'plain401') {
      res.writeHead(401, { 'Content-Type': 'text/html' });
      return res.end('<html>Unauthorized</html>');
    }
    if (s.mode === 'tunnel-down') {
      res.writeHead(530, { 'Content-Type': 'text/html', 'cf-ray': '8d1f2a3b4c5d6e7f-BNE' });
      return res.end('<html>Error 1033 Argo Tunnel error</html>');
    }
    if (url.pathname === '/status.php') {
      if (s.mode === 'html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html>Access through untrusted domain</html>');
      }
      return json(200, { installed: true, maintenance: s.mode === 'maintenance', needsDbUpgrade: false, version: '30.0.4.1', versionstring: '30.0.4', edition: '', productname: 'Nextcloud', extendedSupport: false });
    }
    if (url.pathname.startsWith('/ocs/v2.php/apps/serverinfo/api/v1/')) {
      if (s.mode === 'maintenance') return json(503, { message: 'Service unavailable' });
      if (s.mode === 'error500') return json(500, { message: 'Internal Server Error' });
      const endpoint = url.pathname.split('/').pop();
      const auth = req.headers.authorization;
      const basicOk = auth === 'Basic ' + Buffer.from('admin:app-pass').toString('base64');
      if (endpoint === 'info') {
        if (req.headers['nc-token'] !== TOKEN && !basicOk) return ocs(401, { message: 'Unauthorized' });
        return ocs(200, s.info);
      }
      if (!basicOk) return ocs(401, [], 997);
      if (endpoint === 'diskdata') return ocs(200, [[20.5, 79.5], [524.3, 500.0]]);
      if (endpoint === 'basicdata') return ocs(200, { servertime: 'now', uptime: '3 days, 1 hours, 2 minutes, 3 seconds', thermalzones: [{ zone: 'z0', type: 'x86_pkg_temp', temp: 51.5 }] });
    }
    json(404, { message: 'not found' });
  });
  await new Promise((r) => server.listen(s.port || 0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    state: s,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

module.exports = { startMockNextcloud, serverInfoPayload, TOKEN };
