'use strict';

// Email alerts through the Mail Relay Worker's POST /api/send endpoint.
// Runtime-agnostic: uses only fetch, so it runs on Node.js and Cloudflare Workers.

const { STATUS } = require('./evaluate');

const MAX_RECIPIENTS = 10; // the relay's MAX_SEND_EMAIL_RECIPIENTS default
const MAX_SENDS_PER_HOUR = 20; // protects the Gmail account behind the relay
const MAX_ATTEMPTS = 6;
const MAX_QUEUE_AGE_MS = 24 * 3_600_000;
const SENDS_PER_FLUSH = 3;

const DOWN = new Set([STATUS.PARTIAL, STATUS.MAJOR]);
const UP = new Set([STATUS.OPERATIONAL, STATUS.DEGRADED]);

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Parse the alert settings. Returns { enabled: false } pieces when not configured. */
function parseAlertConfig(env, str) {
  const rawUrl = str(env, 'ALERT_EMAIL_API_URL').trim();
  let url = '';
  if (rawUrl) {
    let parsed;
    try {
      parsed = new URL(/^[a-z]+:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    } catch {
      throw new Error(`ALERT_EMAIL_API_URL is not a valid URL: "${rawUrl}"`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('ALERT_EMAIL_API_URL must start with https://');
    // Accept the relay's base address as well as the full /api/send endpoint.
    if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = '/api/send';
    parsed.hash = '';
    url = parsed.toString();
  }
  const to = str(env, 'ALERT_EMAIL_TO')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const address of to) {
    if (!EMAIL_RE.test(address)) throw new Error(`ALERT_EMAIL_TO contains an invalid address: "${address}"`);
  }
  if (to.length > MAX_RECIPIENTS) throw new Error(`ALERT_EMAIL_TO can list at most ${MAX_RECIPIENTS} addresses`);
  const apiKey = str(env, 'ALERT_EMAIL_API_KEY').trim();
  const onRecovery = !/^(0|false|no|off)$/i.test(str(env, 'ALERT_ON_RECOVERY', 'true').trim());
  const statusPageUrl = str(env, 'STATUS_PAGE_URL').trim().replace(/\/+$/, '');
  return Object.freeze({
    url,
    apiKey,
    to: Object.freeze(to),
    fromName: str(env, 'ALERT_FROM_NAME', 'NAS Status').replace(/[\r\n]+/g, ' ').trim().slice(0, 60) || 'NAS Status',
    onRecovery,
    statusPageUrl,
  });
}

/** Sends one message through the relay. Throws a readable Error on failure. */
class MailRelaySender {
  constructor({ url, apiKey, fetchImpl, timeoutMs = 15_000 }) {
    this.url = url || 'https://mail-relay/api/send'; // host is ignored when a Service Binding is used
    this.apiKey = apiKey;
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.timeoutMs = timeoutMs;
  }

  async send({ to, subject, text, html, fromName }) {
    let res;
    try {
      res = await this.fetch(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        // A single recipient is sent as a plain address, several as a list.
        body: JSON.stringify({ to: to.length === 1 ? to[0] : to, subject, text, html, fromName }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new Error(timedOut ? 'The mail relay did not answer in time' : `Could not reach the mail relay (${err?.cause?.code || err?.message || 'network error'})`);
    }
    if (res.ok) return;
    let detail = '';
    try {
      const body = await res.text();
      const json = JSON.parse(body);
      detail = json.error || json.message || '';
    } catch { /* not JSON */ }
    const meaning = {
      400: 'the relay rejected the message (check ALERT_EMAIL_TO)',
      401: 'the relay rejected the API key (check ALERT_EMAIL_API_KEY)',
      404: 'no /api/send endpoint at that address (check ALERT_EMAIL_API_URL)',
      405: 'the relay refused the method (check ALERT_EMAIL_API_URL points at /api/send)',
      502: 'the relay could not deliver through Gmail',
    }[res.status] || 'unexpected response';
    throw new Error(`Mail relay answered HTTP ${res.status}: ${meaning}${detail ? ` (${String(detail).slice(0, 160)})` : ''}`);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDuration(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/**
 * Watches every component (Nextcloud's and each app's) and emails when one
 * goes down or comes back. A component must fail `threshold` checks in a row
 * before a "down" email, and pass `threshold` in a row before "back up".
 */
class AlertManager {
  /**
   * @param {{alerts: object, threshold: number, timeZone: string, siteTitle: string,
   *          nameOf: (id: string) => string, sender: MailRelaySender|null, log?: Function, enabled: boolean}} opts
   */
  constructor({ alerts, threshold, timeZone, siteTitle, nameOf, sender, log = () => {}, enabled }) {
    this.alerts = alerts;
    this.threshold = threshold;
    this.siteTitle = siteTitle;
    this.nameOf = nameOf;
    this.sender = sender;
    this.log = log;
    this.enabled = Boolean(enabled && sender);
    this.timeFormat = new Intl.DateTimeFormat('en-AU', {
      weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: timeZone || 'UTC', timeZoneName: 'short',
    });
    this.reset();
  }

  reset() {
    this.components = {}; // id -> { down, bad, good, since, recoveredAt }
    this.queue = [];
    this.sentAt = [];
    this.lastSentAt = null;
    this.lastError = null;
  }

  exportState() {
    return { components: this.components, queue: this.queue, sentAt: this.sentAt, lastSentAt: this.lastSentAt, lastError: this.lastError };
  }

  importState(data) {
    if (!data || typeof data !== 'object') return;
    this.components = data.components && typeof data.components === 'object' ? data.components : {};
    this.queue = Array.isArray(data.queue) ? data.queue : [];
    this.sentAt = Array.isArray(data.sentAt) ? data.sentAt.filter(Number.isFinite) : [];
    this.lastSentAt = Number.isFinite(data.lastSentAt) ? data.lastSentAt : null;
    this.lastError = typeof data.lastError === 'string' ? data.lastError : null;
  }

  /** Public summary for the status API (no addresses or keys). */
  summary() {
    return { enabled: this.enabled, lastSentAt: this.lastSentAt, lastError: this.enabled ? this.lastError : null, queued: this.queue.length };
  }

  /** Update per-component state and return the transitions this check caused. */
  observe(now, evaluation) {
    const downs = [];
    const ups = [];
    const ids = Object.keys(evaluation.components);
    for (const id of Object.keys(this.components)) {
      if (!ids.includes(id)) delete this.components[id]; // removed from the config
    }
    for (const id of ids) {
      const { status, message } = evaluation.components[id];
      const c = this.components[id] || (this.components[id] = { down: false, bad: 0, good: 0, since: null, recoveredAt: null });
      if (DOWN.has(status)) {
        // "since" marks the first failure of this outage and survives a brief recovery.
        if (!c.down && c.bad === 0) c.since = now;
        c.bad += 1;
        c.good = 0;
        if (!c.down && c.bad >= this.threshold) {
          c.down = true;
          downs.push({ id, name: this.nameOf(id), since: c.since, message });
        }
      } else if (UP.has(status)) {
        c.bad = 0;
        if (!c.down) {
          c.since = null;
        } else {
          if (c.good === 0) c.recoveredAt = now;
          c.good += 1;
          if (c.good >= this.threshold) {
            ups.push({ id, name: this.nameOf(id), since: c.since, recoveredAt: c.recoveredAt });
            Object.assign(c, { down: false, good: 0, since: null, recoveredAt: null });
          }
        }
      }
      // Unknown ("No data") and maintenance hold the current state: they say nothing either way.
    }
    return { downs, ups };
  }

  compose(kind, items) {
    const t = (ms) => this.timeFormat.format(new Date(ms));
    const names = items.map((i) => i.name);
    const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
    const subject = kind === 'down'
      ? `[${this.siteTitle}] ${items.length === 1 ? `${names[0]} is down` : `${items.length} services are down: ${list}`}`
      : `[${this.siteTitle}] ${items.length === 1 ? `${names[0]} is back up` : `${items.length} services are back up: ${list}`}`;

    const rows = items.map((i) => (kind === 'down'
      ? { name: i.name, line: `Down since ${t(i.since)}`, detail: i.message }
      : { name: i.name, line: `Back up at ${t(i.recoveredAt)}`, detail: `Down for ${formatDuration(i.recoveredAt - i.since)}` }));
    const link = this.alerts.statusPageUrl;
    const text = [
      kind === 'down' ? 'The status monitor found a problem.' : 'Good news: the problem is resolved.',
      '',
      ...rows.flatMap((r) => [`• ${r.name}`, `  ${r.line}`, `  ${r.detail}`, '']),
      link ? `Status page: ${link}` : '',
      '',
      `Sent by ${this.siteTitle}.`,
    ].join('\n').replace(/\n{3,}/g, '\n\n');

    const colour = kind === 'down' ? '#d03b3b' : '#0ca30c';
    const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#07071a;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#f2f2f8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#13132b;border:1px solid #2a2a4e;border-radius:14px">
<tr><td style="padding:22px 24px 8px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8d90ad">${escapeHtml(this.siteTitle)}</div>
<div style="margin-top:6px;font-size:22px;font-weight:700"><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${colour};margin-right:8px"></span>${kind === 'down' ? (items.length === 1 ? 'Service down' : `${items.length} services down`) : (items.length === 1 ? 'Service back up' : `${items.length} services back up`)}</div></td></tr>
${rows.map((r) => `<tr><td style="padding:10px 24px"><div style="background:#1a1a38;border-radius:10px;padding:12px 14px"><div style="font-weight:650;font-size:15px">${escapeHtml(r.name)}</div><div style="color:#c3c5da;font-size:13px;margin-top:2px">${escapeHtml(r.line)}</div><div style="color:#8d90ad;font-size:13px;margin-top:2px">${escapeHtml(r.detail)}</div></div></td></tr>`).join('')}
${link ? `<tr><td style="padding:12px 24px 4px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#3d5c93;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:9px;font-weight:600;font-size:14px">Open the status page</a></td></tr>` : ''}
<tr><td style="padding:16px 24px 22px;color:#8d90ad;font-size:12px">${kind === 'down' ? `Sent automatically after ${this.threshold} failed checks in a row.` : `Sent automatically after ${this.threshold} successful checks in a row.`}</td></tr>
</table></body></html>`;
    return { subject, text, html };
  }

  /** Observe one check, queue any emails, and try to send what is queued. Never throws. */
  async process(now, evaluation) {
    const { downs, ups } = this.observe(now, evaluation);
    if (!this.enabled) return { downs, ups, sent: 0 };
    if (downs.length) this.queue.push({ ...this.compose('down', downs), createdAt: now, attempts: 0 });
    if (ups.length && this.alerts.onRecovery) this.queue.push({ ...this.compose('up', ups), createdAt: now, attempts: 0 });
    const sent = await this.flush(now);
    return { downs, ups, sent };
  }

  async flush(now) {
    this.sentAt = this.sentAt.filter((t) => now - t < 3_600_000);
    this.queue = this.queue.filter((m) => {
      const keep = now - m.createdAt < MAX_QUEUE_AGE_MS && m.attempts < MAX_ATTEMPTS;
      if (!keep) this.log('warn', `Gave up on alert email "${m.subject}" after ${m.attempts} attempts.`);
      return keep;
    });
    let sent = 0;
    for (const message of [...this.queue].slice(0, SENDS_PER_FLUSH)) {
      if (this.sentAt.length >= MAX_SENDS_PER_HOUR) {
        this.lastError = `Paused: ${MAX_SENDS_PER_HOUR} alert emails were sent in the last hour`;
        this.log('warn', this.lastError);
        break;
      }
      try {
        await this.sender.send({ to: this.alerts.to, subject: message.subject, text: message.text, html: message.html, fromName: this.alerts.fromName });
        this.queue.splice(this.queue.indexOf(message), 1);
        this.sentAt.push(now);
        this.lastSentAt = now;
        this.lastError = null;
        sent += 1;
        this.log('info', `Alert email sent: ${message.subject}`);
      } catch (err) {
        message.attempts += 1;
        this.lastError = err.message;
        this.log('warn', `Alert email failed (attempt ${message.attempts} of ${MAX_ATTEMPTS}): ${err.message}`);
        break; // the relay is struggling; try again on the next check
      }
    }
    return sent;
  }
}

module.exports = { AlertManager, MailRelaySender, parseAlertConfig, MAX_SENDS_PER_HOUR };
