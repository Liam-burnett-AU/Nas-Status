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
  constructor(message, { kind, status } = {}) {
    super(message);
    this.name = 'NextcloudError';
    this.kind = kind;
    this.status = status;
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

class NextcloudClient {
  /**
   * @param {{baseUrl: string, token?: string, user?: string, appPassword?: string}} options
   * @param {{timeoutMs: number, fetchImpl?: typeof fetch}} runtime
   */
  constructor({ baseUrl, token, user, appPassword, accessClientId, accessClientSecret }, { timeoutMs, fetchImpl }) {
    this.baseUrl = baseUrl;
    this.token = token || '';
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
    if ((auth === 'token' || auth === 'any') && this.token) {
      headers['NC-Token'] = this.token;
    } else if ((auth === 'basic' || auth === 'any') && this.basicAuth) {
      headers.Authorization = this.basicAuth;
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

    if (res.status === 401 || res.status === 403) {
      throw new NextcloudError('Authentication rejected (check NEXTCLOUD_TOKEN or the app password)', { kind: 'auth', status: res.status });
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
    return { json, elapsedMs, status: res.status };
  }

  static unwrapOcs(json) {
    const meta = json?.ocs?.meta;
    if (!meta || !('data' in json.ocs)) {
      throw new NextcloudError('Response is not an OCS envelope - is the serverinfo app enabled?', { kind: 'parse' });
    }
    const code = Number(meta.statuscode);
    if (code === 401 || code === 997) {
      throw new NextcloudError('Authentication rejected (check NEXTCLOUD_TOKEN or the app password)', { kind: 'auth', status: 401 });
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
    const { json, elapsedMs } = await this.request(
      '/ocs/v2.php/apps/serverinfo/api/v1/info?format=json&skipApps=false&skipUpdate=false',
      { auth: 'any' },
    );
    return { data: NextcloudClient.unwrapOcs(json), elapsedMs };
  }

  async getDiskData() {
    const { json } = await this.request('/ocs/v2.php/apps/serverinfo/api/v1/diskdata?format=json', { auth: 'basic' });
    return NextcloudClient.unwrapOcs(json);
  }

  async getBasicData() {
    const { json } = await this.request('/ocs/v2.php/apps/serverinfo/api/v1/basicdata?format=json', { auth: 'basic' });
    return NextcloudClient.unwrapOcs(json);
  }
}

module.exports = { NextcloudClient, NextcloudError };
