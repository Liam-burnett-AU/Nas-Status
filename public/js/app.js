/* NAS Status — page controller. */
(function () {
  'use strict';

  const F = window.NasFormat;
  const C = window.NasCharts;
  const esc = C.escapeHtml;

  /** When present (static preview build), data comes from here instead of the API. */
  const STATIC = window.__NAS_STATUS_STATIC__ || null;
  // Refresh just after the monitor's next check lands, within these bounds.
  const REFRESH_MIN_MS = 10_000;
  const REFRESH_MAX_MS = 60_000;
  const REFRESH_FALLBACK_MS = 15_000;
  const AFTER_CHECK_MS = 3_000;
  const GIB = 1024 ** 3;
  const RANGES = ['1h', '6h', '24h', '7d'];
  const RANGE_LABEL = { '1h': 'last hour', '6h': 'last 6 hours', '24h': 'last 24 hours', '7d': 'last 7 days' };

  const STATUS_META = {
    operational: { label: 'Operational', icon: 'check', color: 'var(--good)' },
    degraded: { label: 'Degraded performance', icon: 'alert', color: 'var(--warning)' },
    partial_outage: { label: 'Partial outage', icon: 'alert', color: 'var(--serious)' },
    major_outage: { label: 'Major outage', icon: 'x', color: 'var(--critical)' },
    maintenance: { label: 'Maintenance', icon: 'wrench', color: 'var(--maint)' },
    unknown: { label: 'No data', icon: 'help', color: 'var(--muted)' },
  };
  const meta = (s) => STATUS_META[s] || STATUS_META.unknown;
  window.NasStatusLabel = (s) => meta(s).label;

  const SERIES = {
    1: C.cssVar('--series-1', '#3987e5'),
    2: C.cssVar('--series-2', '#d95926'),
    3: C.cssVar('--series-3', '#199e70'),
    4: C.cssVar('--series-4', '#c98500'),
    5: C.cssVar('--series-5', '#d55181'),
    6: C.cssVar('--series-6', '#008300'),
  };
  const STATUS_COLOR = {
    good: C.cssVar('--good', '#0ca30c'),
    warning: C.cssVar('--warning', '#fab219'),
    critical: C.cssVar('--critical', '#d03b3b'),
    muted: C.cssVar('--muted', '#8d90ad'),
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const bind = (name) => document.querySelector(`[data-bind="${name}"]`);
  const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const pill = (status) => `<span class="pill s-${esc(status)}">${icon(meta(status).icon)}${esc(meta(status).label)}</span>`;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  function loadRange() {
    try {
      const r = localStorage.getItem('nas-status.range');
      if (RANGES.includes(r)) return r;
    } catch { /* storage unavailable */ }
    return '24h';
  }
  function saveRange(r) {
    try { localStorage.setItem('nas-status.range', r); } catch { /* ignore */ }
  }

  const state = {
    status: null,
    history: null,
    trend: null,
    range: loadRange(),
    error: null,
    lastFetchOk: null,
    timer: null,
    nextRefreshAt: 0,
    refreshDelay: REFRESH_FALLBACK_MS,
    historyFor: null, // lastCheckAt the loaded history belongs to
    tableView: {},
    charts: {},
    sparks: {},
    tilesBuilt: false,
    chartsBuilt: false,
    tzSet: false,
    showAllIncidents: false,
  };

  // ------------------------------------------------------------------ data
  async function getJson(url) {
    if (STATIC) {
      if (url.startsWith('api/status')) return STATIC.status;
      const range = new URL(url, 'http://x/').searchParams.get('range');
      return STATIC.history[range];
    }
    const res = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
    const ours = res.headers.get('x-nas-status') === 'api';
    if (res.ok && ours) return res.json();
    throw await explainFailure(res, ours);
  }

  /** An error the banner can show as a title plus a plain-English explanation. */
  class ApiError extends Error {
    constructor(title, detail) {
      super(`${title} ${detail}`.trim());
      this.title = title;
      this.detail = detail;
    }
  }

  /**
   * Work out who produced a failed response. NAS Status marks its own replies with
   * X-NAS-Status, so anything without it came from Cloudflare security, Access,
   * a proxy or a network filter in front of the Worker.
   */
  async function explainFailure(res, ours) {
    const ray = (res.headers.get('cf-ray') || '').split('-')[0];
    const rayText = ray ? ` Ray ID: ${ray}.` : '';
    if (ours) {
      let message = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && typeof body.error === 'string') message = body.error;
      } catch { /* not JSON */ }
      return new ApiError('The status server reported a problem.', message);
    }
    if (res.headers.get('cf-mitigated') === 'challenge') {
      return new ApiError(
        'Cloudflare security challenged the data request.',
        `Bot Fight Mode, "I'm Under Attack" mode or a WAF rule is challenging requests to /api/. Turn Bot Fight Mode off, or add a WAF custom rule that skips security for /api/ on this host.${rayText}`,
      );
    }
    if (res.status === 429) {
      return new ApiError(
        'Cloudflare is limiting requests to this site (HTTP 429).',
        `The Workers Free plan allows 100,000 requests a day and resets at 00:00 UTC. A rate limiting rule can also cause this.${rayText}`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      return new ApiError(
        `Something in front of the status page blocked the data request (HTTP ${res.status}).`,
        `The status page never sends this itself. Check Security → Events in the Cloudflare dashboard, and Cloudflare Access if it protects this site. A school or work web filter can also do this.${rayText}`,
      );
    }
    if (res.ok) {
      return new ApiError(
        'The data request returned a web page instead of status data.',
        `A login page, proxy or filter is answering for /api/.${rayText}`,
      );
    }
    return new ApiError(`The data request failed (HTTP ${res.status}).`, `It did not come from the status page itself.${rayText}`);
  }

  async function refresh() {
    clearTimeout(state.timer);
    setSpinning(true);
    try {
      const status = await getJson('api/status');
      // Chart history only changes when a new check has run, so skip it otherwise.
      const checkedAt = status.monitor.lastCheckAt;
      if (!state.history || state.historyFor !== checkedAt) {
        const [history, trend] = await Promise.all([
          getJson(`api/history?range=${state.range}`),
          state.range === '24h' ? Promise.resolve(null) : getJson('api/history?range=24h'),
        ]);
        state.history = history;
        state.trend = trend || history;
        state.historyFor = checkedAt;
      }
      state.status = status;
      state.error = null;
      state.lastFetchOk = Date.now();
      render();
    } catch (err) {
      state.error = err;
      renderBanners();
      renderLive();
    } finally {
      setSpinning(false);
      schedule();
    }
  }

  async function changeRange(range) {
    if (range === state.range || !RANGES.includes(range)) return;
    state.range = range;
    saveRange(range);
    renderRange();
    try {
      state.history = await getJson(`api/history?range=${range}`);
      renderCharts();
    } catch (err) {
      state.error = err;
      renderBanners();
    }
  }

  function schedule() {
    clearTimeout(state.timer);
    if (STATIC || document.hidden) return;
    const next = state.status?.monitor?.nextCheckAt;
    let delay = REFRESH_FALLBACK_MS;
    if (!state.error && Number.isFinite(next)) {
      delay = Math.min(REFRESH_MAX_MS, Math.max(REFRESH_MIN_MS, next + AFTER_CHECK_MS - Date.now()));
    }
    state.refreshDelay = delay;
    state.nextRefreshAt = Date.now() + delay;
    state.timer = setTimeout(refresh, delay);
  }

  function setSpinning(on) {
    $('[data-action="refresh"]').classList.toggle('is-spinning', on);
  }

  // ---------------------------------------------------------------- render
  function render() {
    const s = state.status;
    if (!state.tzSet) {
      F.setTimeZone(s.site.timeZone);
      state.tzSet = true;
    }
    document.title = `${s.site.title} · ${s.overall.message}`;
    bind('site-title').textContent = s.site.title;
    bind('product').textContent = s.details?.version ? `${s.site.productName} ${s.details.version}` : s.site.productName;
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', s.site.description);

    renderLive();
    renderBanners();
    renderHero();
    renderKpis();
    renderComponents();
    renderCharts();
    renderGauges();
    renderSystem();
    renderUsage();
    renderShares();
    renderActiveUsers();
    renderCaching();
    renderApps();
    renderVolumes();
    renderIncidents();
    renderFooter();
  }

  function renderLive() {
    const el = bind('live');
    const text = $('.live-text', el);
    const s = state.status;
    el.classList.remove('is-live', 'is-error');
    if (STATIC) {
      text.textContent = 'Demo snapshot';
      return;
    }
    if (state.error) {
      el.classList.add('is-error');
      text.textContent = 'Offline · retrying';
      return;
    }
    if (!s) return;
    el.classList.add('is-live');
    text.textContent = s.monitor.lastCheckAt ? `Live · checked ${F.relative(s.monitor.lastCheckAt)}` : 'Live · waiting for first check';
    el.title = s.monitor.lastCheckAt ? `Last check: ${F.fullDateTime(s.monitor.lastCheckAt)}` : '';
  }

  function banner(kind, iconName, html) {
    return `<div class="banner banner-${kind} fade-in" role="${kind === 'critical' ? 'alert' : 'status'}">${icon(iconName)}<div>${html}</div></div>`;
  }

  function renderBanners() {
    const s = state.status;
    const out = [];
    if (state.error) {
      const since = state.lastFetchOk ? ` Showing data from ${esc(F.time(state.lastFetchOk))}.` : '';
      // ApiError explains who failed; anything else (a TypeError from fetch) means the network failed.
      const err = state.error;
      const title = err.title || "Can't reach the status server.";
      const sentence = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);
      const detail = err.title && err.detail ? ` ${esc(sentence(err.detail))}` : '';
      out.push(banner('critical', 'x', `<strong>${esc(title)}</strong>${detail}${since} Retrying automatically.`));
    }
    if (s) {
      if (STATIC || s.monitor.demo) {
        out.push(banner('info', 'help', '<strong>Demo mode.</strong> You are looking at generated sample data. Set <code>NEXTCLOUD_URL</code> and <code>NEXTCLOUD_TOKEN</code> to monitor a real server.'));
      }
      if (!s.monitor.apiConfigured && !s.monitor.demo && s.monitor.lastCheckAt) {
        out.push(banner('warning', 'alert', '<strong>Only reachability is monitored.</strong> Add a serverinfo token (<code>NEXTCLOUD_TOKEN</code>) to unlock resource, storage and usage data.'));
      } else if (s.monitor.apiError && s.components.find((c) => c.id === 'web')?.message !== s.monitor.apiError) {
        // (Skipped when the hero already shows the same explanation, such as a Cloudflare Access block.)
        const stale = s.monitor.infoAt ? ` Figures below are from the last successful report at ${esc(F.dateTime(s.monitor.infoAt))}.` : '';
        out.push(banner('warning', 'alert', `<strong>Monitoring API:</strong> ${esc(s.monitor.apiError)}.${stale}`));
      }
      const last = s.monitor.lastCheckAt;
      if (!STATIC && last && Date.now() - last > s.monitor.pollIntervalMs * 3) {
        out.push(banner('warning', 'clock', `<strong>The monitor looks stalled.</strong> No check has completed since ${esc(F.dateTime(last))}.`));
      }
    }
    const html = out.join('');
    const el = bind('banners');
    if (el.dataset.html !== html) {
      el.innerHTML = html;
      el.dataset.html = html;
    }
  }

  function renderHero() {
    const s = state.status;
    const st = s.overall.status;
    const m = meta(st);
    const orb = bind('orb');
    orb.dataset.status = st;
    orb.style.setProperty('--c', m.color);
    $('.orb-core', orb).innerHTML = icon(m.icon);
    bind('hero').style.setProperty('--hero-glow', `color-mix(in srgb, ${m.color} 40%, transparent)`);
    bind('overall-message').textContent = s.overall.message;

    let sub;
    const affected = s.components.filter((c) => c.status !== 'operational' && c.status !== 'unknown');
    if (!s.monitor.lastCheckAt) {
      sub = 'The monitor is starting up. The first check usually completes within a few seconds.';
    } else if (st === 'operational') {
      const healthy = s.components.filter((c) => c.status === 'operational').length;
      sub = `${healthy} of ${s.components.length} components healthy. Last checked at ${F.time(s.monitor.lastCheckAt)}.`;
    } else if (affected.length) {
      sub = affected.map((c) => `${c.name}: ${c.message}`).join(' · ');
    } else if (st === 'unknown') {
      // Nothing is known to be down, but the monitor could not see Nextcloud: say why.
      const why = s.components.find((c) => c.id === 'web' && c.status === 'unknown')?.message;
      sub = why ? `${why}. Last checked at ${F.time(s.monitor.lastCheckAt)}.` : `Last checked at ${F.time(s.monitor.lastCheckAt)}.`;
    } else {
      sub = `Last checked at ${F.time(s.monitor.lastCheckAt)}.`;
    }
    bind('overall-sub').textContent = sub;

    const av = s.availability;
    bind('availability-30d').textContent = F.uptime(av['30d']);
    bind('availability-mini').innerHTML = [['24 h', av['24h']], ['7 d', av['7d']], ['90 d', av['90d']]]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(F.uptime(v))}</dd></div>`).join('');
  }

  /** "127 ms" -> 127<small>ms</small>, "26%" -> 26<small>%</small> */
  function valueHtml(text) {
    if (text === '—') return text;
    const pct = /^(.*?)(%)$/.exec(text);
    if (pct) return `${esc(pct[1])}<small>%</small>`;
    const i = text.lastIndexOf(' ');
    return i > 0 ? `${esc(text.slice(0, i))}<small>${esc(text.slice(i + 1))}</small>` : esc(text);
  }

  const TILES = [
    { id: 'response', icon: 'pulse', label: 'Response time', spark: (p) => p.responseMs },
    { id: 'cpu', icon: 'cpu', label: 'CPU load', spark: (p) => p.cpuPercent },
    { id: 'memory', icon: 'memory', label: 'Memory used', spark: (p) => p.memoryPercent },
    { id: 'storage', icon: 'disk', label: 'Free storage', spark: (p) => p.freeBytes, zeroBased: false },
    { id: 'users', icon: 'users', label: 'Active users', spark: (p) => p.activeUsers },
    { id: 'files', icon: 'files', label: 'Files', spark: null },
  ];

  function renderKpis() {
    const root = bind('kpis');
    if (!state.tilesBuilt) {
      root.innerHTML = TILES.map((t) => `
        <article class="card kpi" data-tile="${t.id}">
          <div class="kpi-head">${icon(t.icon)}<span>${esc(t.label)}</span></div>
          <div class="kpi-value">—</div>
          <div class="kpi-sub">&nbsp;</div>
          <div class="kpi-spark"${t.spark ? ' title="Last 24 hours"' : ''}></div>
        </article>`).join('');
      for (const t of TILES) {
        if (t.spark) state.sparks[t.id] = new C.Sparkline($(`[data-tile="${t.id}"] .kpi-spark`, root), { color: SERIES[1], zeroBased: t.zeroBased !== false });
      }
      state.tilesBuilt = true;
    }

    const s = state.status;
    const mx = s.metrics;
    const set = (id, value, sub) => {
      const tile = $(`[data-tile="${id}"]`, root);
      $('.kpi-value', tile).innerHTML = valueHtml(value);
      $('.kpi-sub', tile).textContent = sub;
      $('.kpi-sub', tile).title = sub;
    };

    const r24 = s.response.last24h;
    set('response', F.ms(s.response.currentMs), r24 ? `p95 ${F.ms(r24.p95)} over 24 h` : 'Collecting data');

    if (mx) {
      const cpu = mx.cpu;
      set('cpu', F.percent(cpu.percent), cpu.load1 !== null ? `Load ${cpu.load1.toFixed(2)} on ${cpu.cores ?? '?'} threads` : 'Not reported');
      set('memory', F.percent(mx.memory.percent), mx.memory.totalBytes ? `${F.bytes(mx.memory.usedBytes)} of ${F.bytes(mx.memory.totalBytes)}` : 'Not reported');
      const d = mx.disk;
      set('storage', F.bytes(d.freeBytes), d.percent !== null ? `${F.percent(d.percent, 1)} of ${F.bytes(d.totalBytes)} used` : d.freeBytes !== null ? 'Data directory' : 'Not reported');
      const au = mx.activeUsers;
      set('users', F.number(au.last5minutes), `Last 5 min · ${F.number(au.last24hours)} in 24 h`);
      set('files', F.compact(mx.storage.files), `${F.number(mx.storage.users)} users · ${F.number(mx.shares.total)} shares`);
    } else {
      for (const id of ['cpu', 'memory', 'storage', 'users', 'files']) set(id, '—', 'Waiting for the monitoring API');
    }

    // Serverinfo figures kept from an earlier report are dimmed so they never pass as live.
    const stale = Boolean(mx && s.monitor.infoStale);
    for (const id of ['cpu', 'memory', 'storage', 'users', 'files']) {
      const tile = $(`[data-tile="${id}"]`, root);
      tile.classList.toggle('is-stale', stale);
      tile.title = stale && s.monitor.infoAt ? `From the last successful report at ${F.dateTime(s.monitor.infoAt)}` : '';
    }

    const points = state.trend?.points || [];
    for (const t of TILES) {
      if (t.spark) state.sparks[t.id].update(points.map(t.spark));
    }
    const filesTile = $('[data-tile="files"] .kpi-spark', root);
    filesTile.innerHTML = mx && isNum(mx.storage.appdataBytes)
      ? `<p class="kpi-sub">App data ${esc(F.bytes(mx.storage.appdataBytes))}</p><p class="kpi-sub">${esc(F.number(mx.storage.storages))} storages</p>`
      : '';
  }

  // ------------------------------------------------------------- components
  function dayTooltip(day) {
    const title = `<div class="tt-title">${esc(F.dateKey(day.date))}</div>`;
    if (!day.status || !day.counts) return `${title}<div class="tt-muted">No data recorded</div>`;
    const c = day.counts;
    const parts = [
      ['operational', c.operational], ['degraded', c.degraded], ['partial_outage', c.partial_outage],
      ['major_outage', c.major_outage], ['maintenance', c.maintenance], ['unknown', c.unknown],
    ].filter(([, n]) => n > 0);
    const bar = `<div class="tt-bar">${parts.map(([st, n]) => `<span class="s-${st}" style="flex:${n}"></span>`).join('')}</div>`;
    const rows = parts.filter(([st]) => st !== 'operational').map(([st, n]) => {
      const mins = day.intervalSeconds ? `≈ ${F.duration(n * day.intervalSeconds * 1000)}` : `${n} checks`;
      return `<div class="tt-row"><span class="tt-key s-${st}"></span><span class="tt-label">${esc(meta(st).label)}</span><span class="tt-value">${esc(mins)}</span></div>`;
    }).join('');
    const uptime = `<div class="tt-row"><span class="tt-label">Uptime</span><span class="tt-value">${esc(F.uptime(day.uptime))}</span></div>`;
    const resp = isNum(day.avgResponseMs) ? `<div class="tt-row"><span class="tt-label">Avg response</span><span class="tt-value">${esc(F.ms(day.avgResponseMs))}</span></div>` : '';
    const summary = parts.length === 1 && parts[0][0] === 'operational' ? '<div class="tt-row tt-muted">No issues recorded</div>' : rows;
    return `${title}<div class="tt-status tt-status-${esc(day.status)}">${esc(meta(day.status).label)}</div>${bar}${uptime}${resp}${summary}<div class="tt-row tt-muted">${esc(F.number(day.checks))} checks</div>`;
  }

  function renderComponents() {
    const legend = bind('status-legend');
    if (!legend.childElementCount) {
      legend.innerHTML = ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance']
        .map((st) => `<li><span class="swatch s-${st}"></span>${esc(meta(st).label)}</li>`).join('')
        + '<li><span class="swatch" style="--c:var(--nodata)"></span>No data</li>';
    }
    const root = bind('components');
    root.innerHTML = state.status.components.map((c) => `
      <div class="component" data-component="${esc(c.id)}">
        <div class="component-head">
          <div>
            <div class="component-name"><h3>${esc(c.name)}</h3>${pill(c.status)}</div>
            <p class="component-msg">${esc(c.message)}</p>
          </div>
          <div class="component-uptime">
            <span class="only-wide"><strong>${esc(F.uptime(c.uptime['90d']))}</strong> uptime · 90 d</span>
            <span class="only-narrow"><strong>${esc(F.uptime(c.uptime['30d']))}</strong> uptime · 30 d</span>
          </div>
        </div>
        <div class="ubars" aria-label="${esc(c.name)} daily status, use arrow keys to explore"></div>
        <div class="ubar-foot"><span><span class="only-wide">90 days ago</span><span class="only-narrow">30 days ago</span></span><span class="rule"></span><span>Today</span></div>
      </div>`).join('');
    for (const c of state.status.components) {
      C.renderUptimeBars($(`[data-component="${c.id}"] .ubars`, root), c.daily, {
        tooltip: dayTooltip,
        statusClass: (d) => (d.status ? `u-${d.status}` : 'u-nodata'),
      });
    }
  }

  // ----------------------------------------------------------------- charts
  function msTick(v) {
    return v >= 1000 ? `${+(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
  }
  function gbTick(v, step) {
    const digits = step >= 1 ? 0 : Math.min(2, Math.ceil(-Math.log10(step)));
    if (v >= 1024 && step >= 10) return `${(v / 1024).toFixed(step >= 102.4 ? 1 : 2)} TB`;
    return `${v.toLocaleString('en-AU', { minimumFractionDigits: digits, maximumFractionDigits: digits })} GB`;
  }

  /** Free space needs GB precision: a day's change is tiny next to a multi-TB volume. */
  function gbPrecise(v) {
    return `${v.toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
  }

  const CHARTS = {
    response: {
      title: 'Response time',
      sub: 'Round trip to status.php. Shaded areas mark degraded periods or outages.',
      series: [{ key: 'responseMs', label: 'Response time', color: SERIES[1] }],
      format: F.ms, tickFormat: msTick, statusBands: true, height: 240,
    },
    resources: {
      title: 'CPU & memory',
      sub: 'Percent of capacity. CPU is the 1-minute load average per thread.',
      series: [
        { key: 'cpuPercent', label: 'CPU load', color: SERIES[1] },
        { key: 'memoryPercent', label: 'Memory', color: SERIES[2] },
        { key: 'swapPercent', label: 'Swap', color: SERIES[3] },
      ],
      format: (v) => F.percent(v, 1), tickFormat: (v) => `${Math.round(v)}%`, yMaxFloor: 100, area: false,
    },
    storage: {
      title: 'Free storage',
      sub: 'Free space on the Nextcloud data directory.',
      series: [{ key: 'freeGiB', label: 'Free space', color: SERIES[1] }],
      format: gbPrecise, tickFormat: gbTick, zeroBased: false, area: false,
    },
    users: {
      title: 'Active users',
      sub: 'Users active within 5 minutes (peak per interval).',
      series: [{ key: 'activeUsers', label: 'Active users', color: SERIES[1] }],
      format: F.number, tickFormat: (v) => (Number.isInteger(v) ? F.number(v) : ''), step: true,
    },
    api: {
      title: 'Monitoring API latency',
      sub: 'Time for the serverinfo endpoint to build its report.',
      series: [{ key: 'apiMs', label: 'API latency', color: SERIES[1] }],
      format: F.ms, tickFormat: msTick,
    },
  };

  function buildCharts() {
    for (const [id, def] of Object.entries(CHARTS)) {
      const card = document.querySelector(`[data-chart="${id}"]`);
      const legend = def.series.length > 1
        ? `<ul class="legend legend-line" data-legend>${def.series.map((s) => `<li><span class="swatch" style="--c:${s.color}"></span><span>${esc(s.label)}</span> <strong data-legend-value="${s.key}">—</strong></li>`).join('')}</ul>`
        : '';
      card.innerHTML = `
        <div class="chart-head">
          <div><h3>${esc(def.title)}</h3><p class="section-sub">${esc(def.sub)}</p></div>
          <div class="chart-tools">
            <button type="button" class="view-toggle" data-toggle="${id}" aria-pressed="false">${icon('table')}<span>Table</span></button>
          </div>
        </div>
        ${legend}
        <dl class="chart-stats" data-stats></dl>
        <div class="chart-body" data-body></div>
        <div class="chart-table-wrap" data-table hidden></div>`;
      state.charts[id] = new C.TimeSeriesChart($('[data-body]', card), {
        ...def,
        ariaLabel: `${def.title} chart. Focus and use the arrow keys to read values.`,
      });
      $(`[data-toggle="${id}"]`, card).addEventListener('click', (e) => {
        state.tableView[id] = !state.tableView[id];
        e.currentTarget.setAttribute('aria-pressed', String(state.tableView[id]));
        $('span', e.currentTarget).textContent = state.tableView[id] ? 'Chart' : 'Table';
        $('use', e.currentTarget).setAttribute('href', state.tableView[id] ? '#i-chart' : '#i-table');
        renderChart(id);
      });
    }
    state.chartsBuilt = true;
  }

  function seriesStats(points, key) {
    const withValue = points.filter((p) => isNum(p[key]));
    if (!withValue.length) return null;
    const vals = withValue.map((p) => p[key]);
    // Weight each interval by its number of checks so the average matches the raw data.
    const weight = withValue.reduce((a, p) => a + (p.n || 1), 0);
    return {
      now: vals[vals.length - 1],
      avg: withValue.reduce((a, p) => a + p[key] * (p.n || 1), 0) / weight,
      min: Math.min(...vals),
      max: Math.max(...vals),
    };
  }

  function renderChart(id) {
    const def = CHARTS[id];
    const card = document.querySelector(`[data-chart="${id}"]`);
    const h = state.history;
    const points = h.points.map((p) => ({ ...p, freeGiB: isNum(p.freeBytes) ? p.freeBytes / GIB : null }));
    const data = { ...h, points };

    // Stats strip
    const statsEl = $('[data-stats]', card);
    let stats = [];
    if (id === 'response') {
      const r = state.status.response;
      const st = seriesStats(points, 'responseMs');
      stats = [
        ['Now', F.ms(r.currentMs)],
        ['Average', st ? F.ms(st.avg) : '—'],
        ['p95 · 24 h', F.ms(r.last24h?.p95 ?? null)],
        ['Slowest · 24 h', F.ms(r.last24h?.max ?? null)],
      ];
    } else if (def.series.length === 1) {
      const st = seriesStats(points, def.series[0].key);
      if (id === 'storage') {
        const change = st ? st.now - (points.find((p) => isNum(p.freeGiB))?.freeGiB ?? st.now) : null;
        stats = [
          ['Now', st ? def.format(st.now) : '—'],
          ['Change', change === null ? '—' : `${change > 0 ? '+' : change < 0 ? '−' : ''}${gbPrecise(Math.abs(change))}`],
          ['Lowest', st ? def.format(st.min) : '—'],
        ];
      } else {
        stats = [
          ['Now', st ? def.format(st.now) : '—'],
          ['Average', st ? def.format(id === 'users' ? Math.round(st.avg * 10) / 10 : st.avg) : '—'],
          ['Peak', st ? def.format(st.max) : '—'],
        ];
      }
    }
    statsEl.innerHTML = stats.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    statsEl.hidden = stats.length === 0;

    // Legend values (multi-series)
    for (const s of def.series) {
      const el = $(`[data-legend-value="${s.key}"]`, card);
      if (el) {
        const st = seriesStats(points, s.key);
        el.textContent = st ? def.format(st.now) : '—';
      }
    }

    const tableMode = Boolean(state.tableView[id]);
    const body = $('[data-body]', card);
    const tableWrap = $('[data-table]', card);
    body.hidden = tableMode;
    tableWrap.hidden = !tableMode;
    if (tableMode) {
      const rows = points.filter((p) => def.series.some((s) => isNum(p[s.key]))).reverse();
      tableWrap.innerHTML = rows.length
        ? `<table class="data-table"><caption class="sr-only">${esc(def.title)}</caption><thead><tr><th scope="col">Time</th>${def.series.map((s) => `<th scope="col">${esc(s.label)}</th>`).join('')}</tr></thead><tbody>${rows.map((p) => `<tr><td>${esc(F.dateTime(p.t))}</td>${def.series.map((s) => `<td>${isNum(p[s.key]) ? esc(def.format(p[s.key])) : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table>`
        : '<p class="placeholder" style="padding:12px">No data for this period yet.</p>';
    } else {
      state.charts[id].update(data);
    }
  }

  function renderCharts() {
    if (!state.history) return;
    if (!state.chartsBuilt) buildCharts();
    renderRange();
    for (const id of Object.keys(CHARTS)) renderChart(id);
    const bucket = state.history.bucketMs;
    bind('perf-sub').textContent = `${bucket > 60_000 ? `Averaged per ${F.duration(bucket)}` : 'One point per check'} · ${RANGE_LABEL[state.range]}`;
  }

  function renderRange() {
    for (const b of bind('range').querySelectorAll('button')) {
      const on = b.dataset.range === state.range;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }

  // ----------------------------------------------------------------- gauges
  function severity(value, warn, high) {
    if (!isNum(value)) return { label: 'No data', color: STATUS_COLOR.muted, fill: SERIES[1] };
    if (value >= high) return { label: 'High', color: STATUS_COLOR.critical, fill: STATUS_COLOR.critical };
    if (value >= warn) return { label: 'Elevated', color: STATUS_COLOR.warning, fill: STATUS_COLOR.warning };
    return { label: 'Normal', color: STATUS_COLOR.good, fill: SERIES[1] };
  }

  function renderGauges() {
    const s = state.status;
    const mx = s.metrics;
    const t = s.monitor.thresholds;
    const root = bind('gauges');
    if (!mx) {
      root.innerHTML = '<p class="placeholder">Resource data appears once the monitoring API responds.</p>';
      bind('thermal').innerHTML = '';
      return;
    }
    const d = mx.disk;
    const gauges = [
      { id: 'cpu', label: 'CPU load', value: mx.cpu.percent, sub: mx.cpu.load1 !== null ? `Load ${mx.cpu.load1.toFixed(2)} / ${mx.cpu.load5?.toFixed(2) ?? '—'} / ${mx.cpu.load15?.toFixed(2) ?? '—'}` : 'Not reported', sev: severity(mx.cpu.percent, t.cpuPercent * 0.75, t.cpuPercent) },
      { id: 'memory', label: 'Memory', value: mx.memory.percent, sub: mx.memory.totalBytes ? `${F.bytes(mx.memory.usedBytes)} of ${F.bytes(mx.memory.totalBytes)}` : 'Not reported', sev: severity(mx.memory.percent, t.memoryPercent * 0.75, t.memoryPercent) },
      { id: 'swap', label: 'Swap', value: mx.swap.percent, sub: mx.swap.totalBytes ? `${F.bytes(mx.swap.usedBytes)} of ${F.bytes(mx.swap.totalBytes)}` : mx.swap.totalBytes === 0 ? 'No swap configured' : 'Not reported', sev: severity(mx.swap.percent, 50, 80) },
      { id: 'disk', label: 'Storage', value: d.percent, sub: d.percent !== null ? `${F.bytes(d.usedBytes)} of ${F.bytes(d.totalBytes)}` : d.freeBytes !== null ? `${F.bytes(d.freeBytes)} free · size unknown` : 'Not reported', sev: severity(d.percent, t.diskWarnPercent, t.diskCriticalPercent) },
    ];
    if (!root.querySelector('.gauge')) {
      root.innerHTML = gauges.map((g) => `
        <div class="gauge" data-gauge="${g.id}">
          <div class="gauge-dial"><div data-dial></div><div class="gauge-center"><span class="gauge-value"></span><span class="gauge-state"></span></div></div>
          <div class="gauge-label">${esc(g.label)}</div>
          <div class="gauge-sub"></div>
        </div>`).join('');
    }
    for (const g of gauges) {
      const el = $(`[data-gauge="${g.id}"]`, root);
      const pct = isNum(g.value) ? Math.round(g.value) : null;
      const prev = el.dataset.value;
      $('.gauge-value', el).innerHTML = pct === null ? '—' : `${pct}<small>%</small>`;
      const stateEl = $('.gauge-state', el);
      stateEl.textContent = g.sev.label;
      stateEl.style.setProperty('--c', g.sev.color);
      $('.gauge-sub', el).textContent = g.sub;
      const key = `${pct}|${g.sev.fill}`;
      if (prev !== key) {
        C.renderGauge($('[data-dial]', el), { percent: pct, color: g.sev.fill });
        el.dataset.value = key;
      }
      el.setAttribute('aria-label', `${g.label}: ${pct === null ? 'no data' : `${pct}%`}, ${g.sev.label}. ${g.sub}`);
      el.setAttribute('role', 'img');
    }
    bind('resources-sub').textContent = s.monitor.infoAt ? `From the serverinfo report at ${F.time(s.monitor.infoAt)}.` : 'From the latest serverinfo report.';

    const names = { x86_pkg_temp: 'CPU package', acpitz: 'Motherboard (ACPI)', 'cpu-thermal': 'CPU', cpu_thermal: 'CPU', 'soc-thermal': 'SoC', 'gpu-thermal': 'GPU', nvme: 'NVMe' };
    bind('thermal').innerHTML = (mx.thermal || []).map((z) => `<span class="chip">${icon('thermo')}${esc(names[z.type] || z.type || z.zone)} <strong>${esc(z.temp.toFixed(1))} °C</strong></span>`).join('');
  }

  // ----------------------------------------------------------------- tables
  function kv(rows) {
    const body = rows.filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v, raw]) => `<tr><th scope="row">${esc(k)}</th><td>${raw ? v : esc(v)}</td></tr>`).join('');
    return body ? `<table class="kv"><tbody>${body}</tbody></table>` : '<p class="placeholder">Nothing reported yet.</p>';
  }

  function meter(percent, label, color = 'var(--series-1)') {
    if (!isNum(percent)) return null;
    const p = Math.max(0, Math.min(100, percent));
    return `<span class="meter" style="--c:${color}"><span class="meter-track"><span class="meter-fill" style="width:${p.toFixed(1)}%"></span></span><span class="meter-value">${esc(label ?? F.percent(percent, 1))}</span></span>`;
  }

  function flag(on, { goodWhen = true, yes = 'Enabled', no = 'Disabled' } = {}) {
    if (on === null || on === undefined) return null;
    const good = on === goodWhen;
    return `<span class="flag ${good ? 'flag-good' : 'flag-warn'}">${icon(good ? 'check' : 'alert')}${esc(on ? yes : no)}</span>`;
  }

  const DB_NAMES = { mysql: 'MySQL / MariaDB', pgsql: 'PostgreSQL', sqlite3: 'SQLite', sqlite: 'SQLite', oci: 'Oracle' };

  function setCardHidden(name, hidden) {
    const el = bind(name);
    if (el) el.hidden = hidden;
  }

  function renderSystem() {
    const s = state.status;
    const d = s.details;
    setCardHidden('system-card', !d);
    if (!d) return;
    const srv = d.server || {};
    const mx = s.metrics;
    const db = srv.dbType ? `${DB_NAMES[srv.dbType] || srv.dbType}${srv.dbVersion ? ` ${srv.dbVersion}` : ''}` : null;
    bind('system').innerHTML = kv([
      ['Nextcloud', d.version ? `${d.version}${d.edition ? ` (${d.edition})` : ''}` : null],
      ['All-in-One', d.aioVersion],
      ['Web server', srv.webserver],
      ['PHP', srv.phpVersion],
      ['Database', db],
      ['Database size', isNum(srv.dbSizeBytes) ? F.bytes(srv.dbSizeBytes) : null],
      ['Server uptime', d.uptimeText],
      ['CPU threads', mx?.cpu.cores ? F.number(mx.cpu.cores) : null],
      ['Memory', mx?.memory.totalBytes ? F.bytes(mx.memory.totalBytes) : null],
      ['Swap', mx?.swap.totalBytes ? F.bytes(mx.swap.totalBytes) : mx?.swap.totalBytes === 0 ? 'None' : null],
      ['Debug mode', d.config ? flag(d.config.debug, { goodWhen: false, yes: 'On', no: 'Off' }) : null, true],
      ['Maintenance mode', flag(d.maintenance, { goodWhen: false, yes: 'On', no: 'Off' }), true],
    ]);
  }

  function renderUsage() {
    const mx = state.status.metrics;
    if (!mx) {
      bind('usage').innerHTML = '<p class="placeholder">Usage data appears once the monitoring API responds.</p>';
      return;
    }
    const st = mx.storage;
    const d = mx.disk;
    const breakdown = [
      isNum(st.storagesHome) ? `${F.number(st.storagesHome)} home` : null,
      isNum(st.storagesLocal) ? `${F.number(st.storagesLocal)} local` : null,
      isNum(st.storagesOther) ? `${F.number(st.storagesOther)} other` : null,
    ].filter(Boolean).join(' · ');
    bind('usage').innerHTML = kv([
      ['Accounts', F.number(st.users)],
      ['Disabled accounts', isNum(st.disabledUsers) ? F.number(st.disabledUsers) : null],
      ['Files', F.number(st.files)],
      ['Storages', isNum(st.storages) ? `${F.number(st.storages)}${breakdown ? ` <span class="muted">(${esc(breakdown)})</span>` : ''}` : null, true],
      ['App data', isNum(st.appdataBytes) && st.appdataBytes > 0 ? `${F.bytes(st.appdataBytes)}${isNum(st.appdataFiles) ? ` · ${F.compact(st.appdataFiles)} files` : ''}` : null],
      ['Free space', d.freeBytes !== null ? F.bytes(d.freeBytes) : null],
      ['Data volume', d.percent !== null ? meter(d.percent, `${F.percent(d.percent, 1)} of ${F.bytes(d.totalBytes)}`, severity(d.percent, state.status.monitor.thresholds.diskWarnPercent, state.status.monitor.thresholds.diskCriticalPercent).fill) : null, true],
    ]);
  }

  function renderShares() {
    const mx = state.status.metrics;
    const root = bind('shares');
    if (!mx) {
      root.innerHTML = '<p class="placeholder">Share data appears once the monitoring API responds.</p>';
      return;
    }
    const sh = mx.shares;
    const segs = [
      { key: 'user', label: 'User', value: sh.user, color: SERIES[1] },
      { key: 'group', label: 'Group', value: sh.group, color: SERIES[2] },
      { key: 'link', label: 'Public link', value: sh.link, color: SERIES[3] },
      { key: 'email', label: 'Email', value: sh.email, color: SERIES[4] },
      { key: 'room', label: 'Talk room', value: sh.room, color: SERIES[5] },
      { key: 'fed', label: 'Federated', value: sh.federatedSent, color: SERIES[6] },
    ].map((x) => ({ ...x, value: isNum(x.value) ? x.value : 0 }));
    const sum = segs.reduce((a, b) => a + b.value, 0);
    const total = isNum(sh.total) ? Math.max(sh.total, sum) : sum;
    if (total > sum) segs.push({ key: 'other', label: 'Other', value: total - sum, color: STATUS_COLOR.muted });
    if (total === 0) {
      root.innerHTML = '<p class="placeholder">No shares yet.</p>';
      return;
    }
    const rows = segs.filter((x) => x.value > 0).map((x) => [
      `<span class="swatch" style="--c:${x.color}"></span>${esc(x.label)}`,
      `${F.number(x.value)} <span class="muted">${((x.value / total) * 100).toFixed(0)}%</span>`,
    ]);
    const notes = [];
    if (isNum(sh.linkNoPassword) && sh.linkNoPassword > 0) {
      notes.push(`<p class="note warn">${icon('alert')}<span>${F.number(sh.linkNoPassword)} public ${sh.linkNoPassword === 1 ? 'link has' : 'links have'} no password.</span></p>`);
    }
    if (isNum(sh.federatedReceived) && sh.federatedReceived > 0) {
      notes.push(`<p class="note">${icon('link')}<span>${F.number(sh.federatedReceived)} federated ${sh.federatedReceived === 1 ? 'share' : 'shares'} received from other servers.</span></p>`);
    }
    root.innerHTML = `
      <div class="shares-wrap">
        <div class="donut"><div data-donut></div><div class="donut-center"><strong>${esc(F.compact(total))}</strong><span>shares</span></div></div>
        <div class="shares-table"><table class="kv"><tbody>${rows.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join('')}</tbody></table></div>
      </div>${notes.join('')}`;
    C.renderDonut($('[data-donut]', root), segs.filter((x) => x.value > 0));
  }

  function renderActiveUsers() {
    const mx = state.status.metrics;
    const root = bind('active-users');
    if (!mx) {
      root.innerHTML = '<p class="placeholder">Activity data appears once the monitoring API responds.</p>';
      return;
    }
    const au = mx.activeUsers;
    const accounts = mx.storage.users;
    const rows = [
      ['Last 5 minutes', au.last5minutes], ['Last hour', au.last1hour], ['Last 24 hours', au.last24hours],
      ['Last 7 days', au.last7days], ['Last 30 days', au.last1month], ['Last 3 months', au.last3months],
      ['Last 6 months', au.last6months], ['Last year', au.lastyear],
    ];
    const max = Math.max(accounts || 0, ...rows.map(([, v]) => v || 0)) || 1;
    root.innerHTML = kv(rows.map(([k, v]) => [k, isNum(v) ? meter((v / max) * 100, F.number(v)) : null, true]))
      + (isNum(accounts) ? `<p class="note">${icon('users')}<span>Bars are relative to ${F.number(accounts)} ${accounts === 1 ? 'account' : 'accounts'} that have logged in at least once.</span></p>` : '');
  }

  function renderCaching() {
    const d = state.status.details;
    setCardHidden('caching-card', !d);
    if (!d) return;
    const c = d.caching || {};
    const srv = d.server || {};
    const op = c.opcache;
    const ap = c.apcu;
    const fpm = d.fpm;
    bind('caching').innerHTML = kv([
      ['Local cache', c.local || 'None'],
      ['Distributed cache', c.distributed || 'None'],
      ['Locking cache', c.locking || 'None'],
      ['File locking', flag(c.fileLocking), true],
      ['OPcache hit rate', op ? meter(op.hitRate, F.percent(op.hitRate, 2)) : null, true],
      ['OPcache memory', op ? meter(op.memoryPercent) : null, true],
      ['APCu hit rate', ap ? meter(ap.hitRate, F.percent(ap.hitRate, 2)) : null, true],
      ['APCu memory', ap ? meter(ap.memoryPercent) : null, true],
      ['PHP memory limit', isNum(srv.phpMemoryLimitBytes) ? (srv.phpMemoryLimitBytes < 0 ? 'Unlimited' : F.bytes(srv.phpMemoryLimitBytes)) : null],
      ['Upload limit', isNum(srv.phpUploadMaxBytes) ? F.bytes(srv.phpUploadMaxBytes) : null],
      ['Max execution time', isNum(srv.phpMaxExecutionTime) ? F.seconds(srv.phpMaxExecutionTime) : null],
      ['PHP extensions', isNum(srv.phpExtensions) ? `${F.number(srv.phpExtensions)} loaded` : null],
      ['PHP-FPM processes', fpm && isNum(fpm.totalProcesses) ? `${F.number(fpm.activeProcesses)} active · ${F.number(fpm.idleProcesses)} idle` : null],
      ['FPM max children hit', fpm && isNum(fpm.maxChildrenReached) ? F.number(fpm.maxChildrenReached) : null],
      ['Previews', d.config ? flag(d.config.previews) : null, true],
    ]);
  }

  function renderApps() {
    const d = state.status.details;
    setCardHidden('apps-card', !d);
    if (!d) return;
    const apps = d.apps;
    const up = d.update;
    let ncUpdate = null;
    if (up) {
      ncUpdate = up.available
        ? `<span class="flag flag-warn">${icon('alert')}${esc(up.availableVersion ? `${up.availableVersion} available` : 'Update available')}</span>`
        : `<span class="flag flag-good">${icon('check')}Up to date</span>`;
    }
    const table = kv([
      ['Nextcloud', ncUpdate, true],
      ['Last update check', up?.lastCheckedAt ? F.dateTime(up.lastCheckedAt, { year: true }) : null],
      ['Installed apps', apps ? F.number(apps.installed) : null],
      ['App updates', apps ? (apps.updatesAvailable ? `<span class="flag flag-warn">${icon('alert')}${F.number(apps.updatesAvailable)} available</span>` : `<span class="flag flag-good">${icon('check')}None</span>`) : null, true],
    ]);
    const list = apps && apps.updates.length
      ? `<ul class="list-plain">${apps.updates.map((u) => `<li><span class="mono">${esc(u.id)}</span><span class="tag">${esc(u.version || 'new')}</span></li>`).join('')}</ul>`
      : '';
    bind('apps').innerHTML = table + list;
  }

  function renderVolumes() {
    const mx = state.status.metrics;
    const vols = mx?.disk?.volumes || [];
    setCardHidden('volumes-card', vols.length === 0);
    if (!vols.length) return;
    const t = state.status.monitor.thresholds;
    bind('volumes').innerHTML = `<div class="table-scroll"><table class="data-table">
      <thead><tr><th scope="col">Volume</th><th scope="col">Used</th><th scope="col">Free</th><th scope="col">Size</th><th scope="col">Usage</th></tr></thead>
      <tbody>${vols.map((v, i) => `<tr>
        <td>Volume ${i + 1} ${i === mx.disk.dataVolumeIndex ? '<span class="tag">Nextcloud data</span>' : ''}</td>
        <td>${esc(F.bytes(v.usedBytes))}</td><td>${esc(F.bytes(v.availableBytes))}</td><td>${esc(F.bytes(v.totalBytes))}</td>
        <td>${meter(v.percent, F.percent(v.percent, 1), severity(v.percent, t.diskWarnPercent, t.diskCriticalPercent).fill)}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  function renderIncidents() {
    const list = state.status.incidents;
    const root = bind('incidents');
    if (!list.length) {
      root.innerHTML = `<div class="empty-state">${icon('check')}<div><strong>No incidents recorded.</strong><br><span class="section-sub">Everything has been running smoothly for the past 90 days.</span></div></div>`;
      return;
    }
    const openIds = new Set([...root.querySelectorAll('details[open]')].map((d) => d.dataset.id));
    const shown = state.showAllIncidents ? list : list.slice(0, 6);
    root.innerHTML = `<div class="incidents">${shown.map((inc) => {
      const m = meta(inc.status);
      const ongoing = inc.endedAt === null;
      return `<details class="incident" data-id="${esc(inc.id)}"${openIds.has(inc.id) || (ongoing && !root.dataset.seen) ? ' open' : ''}>
        <summary>
          <span class="incident-icon s-${esc(inc.status)}">${icon(m.icon)}</span>
          <div>
            <div class="incident-title">${esc(inc.title)}</div>
            <div class="incident-meta"><span>${esc(F.dateTime(inc.startedAt, { year: true }))}</span><span>${ongoing ? 'Ongoing for' : 'Lasted'} ${esc(F.duration(inc.durationMs))}</span></div>
          </div>
          <div class="incident-right">${ongoing ? '<span class="ongoing">Ongoing</span>' : `<span class="pill s-operational">${icon('check')}Resolved</span>`}${icon('chevron', 'chev')}</div>
        </summary>
        <ol class="timeline">${inc.updates.map((u) => `<li class="s-${esc(u.status)}"><time datetime="${new Date(u.t).toISOString()}">${esc(F.fullDateTime(u.t))}</time><strong>${esc(u.status === 'operational' ? 'Resolved' : meta(u.status).label)}</strong> · ${esc(u.message)}</li>`).join('')}</ol>
      </details>`;
    }).join('')}</div>${list.length > 6 ? `<p style="margin-top:12px"><button type="button" class="view-toggle" data-action="all-incidents">${state.showAllIncidents ? 'Show fewer' : `Show all ${list.length} incidents`}</button></p>` : ''}`;
    root.dataset.seen = '1';
    const more = $('[data-action="all-incidents"]', root);
    if (more) more.addEventListener('click', () => { state.showAllIncidents = !state.showAllIncidents; renderIncidents(); });
  }

  function renderFooter() {
    const s = state.status;
    const every = F.duration(s.monitor.pollIntervalMs);
    bind('footer-meta').textContent = `Checks every ${every} · Times shown in ${F.zoneName()} (${s.site.timeZone}) · Powered by the ${s.site.productName} serverinfo API`;
    const link = bind('api-link');
    if (STATIC) {
      link.removeAttribute('href');
      document.querySelector('.brand').setAttribute('href', '#main');
    }
  }

  // ------------------------------------------------------------------ ticks
  function tick() {
    if (state.status) renderLive();
    const ring = $('.ring-fill');
    if (ring) {
      const total = state.refreshDelay || REFRESH_FALLBACK_MS;
      const remaining = STATIC || document.hidden ? total : Math.max(0, state.nextRefreshAt - Date.now());
      ring.style.strokeDashoffset = String(100.53 * Math.min(1, remaining / total));
    }
  }

  function init() {
    $('[data-action="refresh"]').addEventListener('click', () => refresh());
    const group = bind('range');
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-range]');
      if (b) changeRange(b.dataset.range);
    });
    group.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const i = RANGES.indexOf(state.range);
      const next = RANGES[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + RANGES.length) % RANGES.length];
      changeRange(next).then(() => group.querySelector(`[data-range="${next}"]`).focus());
    });
    renderRange();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearTimeout(state.timer);
      else refresh();
    });
    window.addEventListener('scroll', () => C.Tooltip.hide(), { passive: true });
    setInterval(tick, 1000);
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
