'use strict';

// Runtime-agnostic: uses only web-standard APIs (fetch, AbortSignal, TextEncoder, btoa),
// so the same client runs on Node.js 18+ and on Cloudflare Workers.

const now = () => (globalThis.performance && typeof globalThis.performance.now === 'function' ? globalThis.performance.now() : Date.now());

/** UTF-8 safe base64 (btoa alone rejects non-Latin-1 characters in passwords). */
function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const USER_AGENT = 'nas-status/1.0 (+https://github.com/Liam-burnett-AU/Nas-Status)';

class NextcloudError extends Error {
  /**
   * @param {string} message human readable message (safe to show publicly)
   * @param {{kind: 'timeout'|'network'|'auth'|'http'|'parse'|'ocs', status?: number}} info
   */
  constructor(message, { kind, status, mode } = {}) {
    super(message);
    this.name = 'NextcloudError';
    this.kind = kind;
    this.status = status;
    this.mode = mode;
  }
}

function describeNetworkError(err) {
  const code = err?.cause?.code || err?.code;
  switch (code) {
    case 'ECONNREFUSED': return 'Connection refused';
    case 'ENOTFOUND': return 'Host name could not be resolved';
    case 'EAI_AGAIN': return 'DNS lookup failed';
    case 'ECONNRESET': return 'Connection reset by server';
    case 'UND_ERR_SOCKET': return 'Connection closed unexpectedly';
    case 'UND_ERR_CONNECT_TIMEOUT': return 'Connection timed out';
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT': return 'Server stopped responding mid-request';
    case 'ETIMEDOUT': return 'Connection timed out';
    case 'EHOSTUNREACH': return 'Host unreachable';
    case 'ENETUNREACH': return 'Network unreachable';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'TLS certificate not trusted (see NODE_EXTRA_CA_CERTS in the README)';
    case 'CERT_HAS_EXPIRED': return 'TLS certificate has expired';
    case 'ERR_TLS_CERT_ALTNAME_INVALID': return 'TLS certificate does not match the host name';
    default: {
      const detail = code || err?.cause?.message || err?.message;
      return detail && detail !== 'fetch failed' ? `Network error (${detail})` : 'Network error';
    }
  }
}

/**
 * Recognise responses produced by something in front of Nextcloud (Cloudflare
 * Access, Cloudflare's firewall or bot protection, a Tunnel that is down, or a
 * password-protected reverse proxy) rather than by Nextcloud itself.
 * @returns {string|null}
 */
function describeFrontDoor(res, body, { sentAccessToken = false } = {}) {
  const h = (name) => res.headers.get(name) || '';
  const ray = h('cf-ray').split('-')[0];
  const rayText = ray ? ` (Cloudflare Ray ID ${ray})` : '';
  const text = body.slice(0, 20_000);
  if (/cloudflareaccess\.com/i.test(h('location')) || /cloudflareaccess\.com|cloudflare access/i.test(text) || h('cf-access-domain')) {
    // Say whether a service token was sent, so "not set up" and "set up but refused" look different.
    return sentAccessToken
      ? `Cloudflare Access refused the monitor's service token${rayText}. Check that the Nextcloud application has a policy with the action Service Auth that includes this token, and that CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET match it`
      : `Cloudflare Access is protecting Nextcloud and blocked the monitor${rayText}. The Worker has no service token yet: add one to the app's policy and set it as CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET`;
  }
  if (h('cf-mitigated') === 'challenge') {
    return `Cloudflare's bot protection challenged the monitor${rayText}. Turn off Bot Fight Mode for this domain (Security > Bots), or skip the WAF rule that challenged it`;
  }
  if (/error code:?\s*1033|error 1033/i.test(text)) {
    return `The Cloudflare Tunnel for this host is not connected (error 1033)${rayText}. Check that cloudflared is running on the NAS`;
  }
  if (/error code:?\s*10(0[5-9]|1\d|20)|sorry, you have been blocked|attention required/i.test(text)) {
    return `Cloudflare's firewall blocked the monitor${rayText}. Look the request up under Security > Events and add a skip rule for it`;
  }
  if (/^basic/i.test(h('www-authenticate'))) {
    return 'A password prompt (HTTP basic auth) on a reverse proxy in front of Nextcloud blocked the monitor. Exclude /status.php and /ocs/ from it';
  }
  return null;
}

/** True when the body is a reply from Nextcloud itself (OCS or its JSON error format). */
function isNextcloudReply(body) {
  try {
    const json = JSON.parse(body);
    return Boolean(json && typeof json === 'object' && (json.ocs?.meta || 'message' in json));
  } catch {
    return false;
  }
}

/** Plain-English explanation of a rejected credential, naming which one was sent. */
function authMessage(mode, user) {
  if (mode === 'token') {
    return 'Nextcloud rejected the monitoring token (NEXTCLOUD_TOKEN). It must match the output of "occ config:app:get serverinfo token" exactly';
  }
  if (mode === 'basic') {
    return `Nextcloud rejected the app password for "${user}" (NEXTCLOUD_USER / NEXTCLOUD_APP_PASSWORD). The account must be an admin, and the app password must not have been revoked`;
  }
  return 'Nextcloud requires authentication for this endpoint';
}

class NextcloudClient {
  /**
   * @param {{baseUrl: string, token?: string, user?: string, appPassword?: string}} options
   * @param {{timeoutMs: number, fetchImpl?: typeof fetch}} runtime
   */
  constructor({ baseUrl, token, user, appPassword, accessClientId, accessClientSecret }, { timeoutMs, fetchImpl }) {
    this.baseUrl = baseUrl;
    this.token = token || '';
    this.user = user || '';
    this.basicAuth = user && appPassword ? 'Basic ' + base64Utf8(`${user}:${appPassword}`) : '';
    this.accessHeaders = accessClientId && accessClientSecret
      ? { 'CF-Access-Client-Id': accessClientId, 'CF-Access-Client-Secret': accessClientSecret }
      : null;
    this.timeoutMs = timeoutMs;
    // Bind to globalThis: Workers throw "Illegal invocation" if fetch is called as a method.
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  }

  get canReadServerInfo() {
    return Boolean(this.token || this.basicAuth);
  }

  /** diskdata and basicdata are admin-only (no NC-Token support upstream). */
  get canReadAdminEndpoints() {
    return Boolean(this.basicAuth);
  }

  async request(pathAndQuery, { auth = 'none' } = {}) {
    const headers = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...this.accessHeaders,
    };
    if (auth !== 'none') headers['OCS-APIRequest'] = 'true';
    // 'any' prefers the monitoring token and only falls back to admin
    // credentials, so a wrong password never rides along with a good token.
    let mode = 'none';
    if ((auth === 'token' || auth === 'any') && this.token) {
      headers['NC-Token'] = this.token;
      mode = 'token';
    } else if ((auth === 'basic' || auth === 'any') && this.basicAuth) {
      headers.Authorization = this.basicAuth;
      mode = 'basic';
    }

    const started = now();
    let res;
    try {
      res = await this.fetch(this.baseUrl + pathAndQuery, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new NextcloudError(`No response within ${Math.round(this.timeoutMs / 1000)} s`, { kind: 'timeout' });
      }
      throw new NextcloudError(describeNetworkError(err), { kind: 'network' });
    }

    let body;
    try {
      body = await res.text();
    } catch (err) {
      throw new NextcloudError(describeNetworkError(err), { kind: 'network' });
    }
    const elapsedMs = Math.round(now() - started);

    const frontDoor = res.ok ? null : describeFrontDoor(res, body, { sentAccessToken: Boolean(this.accessHeaders) });
    if (frontDoor) {
      throw new NextcloudError(frontDoor, { kind: 'blocked', status: res.status });
    }
    if (res.status === 401 || res.status === 403) {
      // Only blame the credentials when Nextcloud itself said no. status.php never needs a login.
      if (mode !== 'none' && isNextcloudReply(body)) {
        throw new NextcloudError(authMessage(mode, this.user), { kind: 'auth', status: res.status, mode });
      }
      throw new NextcloudError(
        `Something in front of Nextcloud refused the request (HTTP ${res.status}), so it never reached Nextcloud. Check Cloudflare Access, Security > Events and any reverse proxy for this host`,
        { kind: 'blocked', status: res.status },
      );
    }
    if (res.status >= 300 && res.status < 400) {
      throw new NextcloudError(`Unexpected redirect (HTTP ${res.status}) - check NEXTCLOUD_URL, including http vs https and any sub-path`, { kind: 'http', status: res.status });
    }
    if (res.status === 503) {
      // Nextcloud answers 503 during maintenance; the caller decides what that means.
      throw new NextcloudError('Service unavailable (HTTP 503)', { kind: 'http', status: 503 });
    }
    if (!res.ok) {
      const hint = /trusted.domain/i.test(body) ? ' - this host is not in Nextcloud\'s trusted_domains' : '';
      throw new NextcloudError(`HTTP ${res.status}${hint}`, { kind: 'http', status: res.status });
    }

    let json;
    try {
      json = JSON.parse(body);
    } catch {
      const hint = /trusted.domain/i.test(body) ? ' - this host is not in Nextcloud\'s trusted_domains' : ' - check NEXTCLOUD_URL';
      throw new NextcloudError(`Response was not JSON${hint}`, { kind: 'parse', status: res.status });
    }
    return { json, elapsedMs, status: res.status, mode };
  }

  unwrapOcs(json, mode) {
    const meta = json?.ocs?.meta;
    if (!meta || !('data' in json.ocs)) {
      throw new NextcloudError('Response is not an OCS envelope - is the serverinfo app enabled?', { kind: 'parse' });
    }
    const code = Number(meta.statuscode);
    if (code === 401 || code === 997) {
      throw new NextcloudError(authMessage(mode, this.user), { kind: 'auth', status: 401, mode });
    }
    if (meta.status !== 'ok' && !(code >= 100 && code < 300)) {
      throw new NextcloudError(`OCS error ${code}: ${meta.message || 'unknown'}`, { kind: 'ocs', status: code });
    }
    return json.ocs.data;
  }

  /** Public endpoint: reachability, maintenance flag and version. */
  async getStatus() {
    const { json, elapsedMs } = await this.request('/status.php');
    if (typeof json !== 'object' || json === null || !('installed' in json)) {
      throw new NextcloudError('status.php returned an unexpected payload', { kind: 'parse' });
    }
    return { data: json, elapsedMs };
  }

  /** The external monitoring endpoint (NC-Token or admin credentials). */
  async getServerInfo() {
    const { json, elapsedMs, mode } = await this.request(
      '/ocs/v2.php/apps/serverinfo/api/v1/info?format=json&skipApps=false&skipUpdate=false',
      { auth: 'any' },
    );
    return { data: this.unwrapOcs(json, mode), elapsedMs };
  }

  async getDiskData() {
    const { json, mode } = await this.request('/ocs/v2.php/apps/serverinfo/api/v1/diskdata?format=json', { auth: 'basic' });
    return this.unwrapOcs(json, mode);
  }

  async getBasicData() {
    const { json, mode } = await this.request('/ocs/v2.php/apps/serverinfo/api/v1/basicdata?format=json', { auth: 'basic' });
    return this.unwrapOcs(json, mode);
  }
}

module.exports = { NextcloudClient, NextcloudError };
