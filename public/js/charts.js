/* Dependency-free SVG charts for the status page. */
(function () {
  'use strict';

  const F = window.NasFormat;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  function svg(tag, attrs = {}, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== null && v !== undefined) el.setAttribute(k, String(v));
    }
    if (parent) parent.appendChild(el);
    return el;
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // ------------------------------------------------------------ tooltip
  const Tooltip = {
    el: null,
    ensure() {
      if (this.el) return this.el;
      this.el = document.createElement('div');
      this.el.className = 'tooltip';
      this.el.setAttribute('role', 'tooltip');
      this.el.hidden = true;
      document.body.appendChild(this.el);
      return this.el;
    },
    show(html, clientX, clientY) {
      const el = this.ensure();
      el.innerHTML = html;
      el.hidden = false;
      const pad = 12;
      const rect = el.getBoundingClientRect();
      let x = clientX + 14;
      let y = clientY + 14;
      if (x + rect.width + pad > window.innerWidth) x = clientX - rect.width - 14;
      if (y + rect.height + pad > window.innerHeight) y = clientY - rect.height - 14;
      el.style.transform = `translate(${Math.max(pad, Math.round(x))}px, ${Math.max(pad, Math.round(y))}px)`;
    },
    hide() {
      if (this.el) this.el.hidden = true;
    },
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // -------------------------------------------------------------- scales
  function niceNum(range, round) {
    const exp = Math.floor(Math.log10(range));
    const f = range / 10 ** exp;
    let nf;
    if (round) nf = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10;
    else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nf * 10 ** exp;
  }

  function niceTicks(min, max, count = 4) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
    if (min === max) {
      const pad = Math.abs(min) * 0.1 || 1;
      min -= pad;
      max += pad;
    }
    const step = niceNum(niceNum(max - min, false) / count, true);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
    return { min: lo, max: hi, ticks };
  }

  const TIME_STEPS = [5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY];

  function timeTicks(from, to, maxTicks) {
    const span = to - from;
    const step = TIME_STEPS.find((s) => span / s <= maxTicks) || 7 * DAY;
    const ticks = [];
    // Align to wall-clock boundaries in the site's time zone.
    const offset = F.tzOffset(from);
    let t = Math.ceil((from + offset) / step) * step - offset;
    for (; t <= to; t += step) {
      const off = F.tzOffset(t);
      const aligned = Math.round((t + off) / step) * step - off; // re-align across DST changes
      if (aligned >= from && aligned <= to && !ticks.includes(aligned)) ticks.push(aligned);
    }
    const label = step >= DAY ? F.dayShort : step >= HOUR && span > DAY ? (ts) => F.dayShort(ts) + ' ' + F.hour(ts) : step >= HOUR ? F.hour : F.time;
    return { ticks, label, step };
  }

  // --------------------------------------------------- time series chart
  class TimeSeriesChart {
    /**
     * @param {HTMLElement} el
     * @param {{series: {key: string, label: string, color: string}[], format: (v:number)=>string,
     *   tickFormat?: (v:number)=>string, height?: number, area?: boolean, zeroBased?: boolean,
     *   yMaxFloor?: number, statusBands?: boolean, step?: boolean, ariaLabel: string}} opts
     */
    constructor(el, opts) {
      this.el = el;
      this.opts = { height: 220, area: true, zeroBased: true, statusBands: false, step: false, ...opts };
      this.data = null;
      this.width = 0;
      this.activeIndex = null;
      this.ro = new ResizeObserver(() => {
        if (this.el.clientWidth !== this.width) this.render();
      });
      this.ro.observe(el);
    }

    update(data) {
      this.data = data;
      this.render();
    }

    render() {
      const width = this.el.clientWidth;
      this.width = width;
      if (!width || !this.data) return;
      const { opts } = this;
      const { points, from, to, bucketMs } = this.data;
      const height = opts.height;
      const compact = width < 420;
      const m = { top: 14, right: 14, bottom: 28, left: compact ? 44 : 56 };
      const ih = height - m.top - m.bottom;

      const values = [];
      for (const p of points) for (const s of opts.series) if (p[s.key] !== null && p[s.key] !== undefined) values.push(p[s.key]);
      const hasData = values.length > 0;
      let lo = opts.zeroBased ? 0 : Math.min(...values);
      let hi = hasData ? Math.max(...values) : 1;
      if (opts.yMaxFloor !== undefined) hi = Math.max(hi, opts.yMaxFloor);
      if (!opts.zeroBased && hasData) {
        const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.01 || 1;
        lo -= pad;
        hi += pad;
      }
      const y = niceTicks(lo, hi, compact ? 3 : 4);
      if (opts.zeroBased) y.min = 0;
      const tickStep = y.ticks.length > 1 ? y.ticks[1] - y.ticks[0] : 1;
      const tickFmt = opts.tickFormat || opts.format;
      const tickLabels = y.ticks.map((v) => tickFmt(v, tickStep));
      // Size the left margin to the longest tick label so nothing is clipped.
      m.left = Math.max(m.left, Math.ceil(Math.max(...tickLabels.map((l) => l.length)) * 6.4) + 14);
      const iwFinal = Math.max(10, width - m.left - m.right);
      const xs = (t) => m.left + ((t - from) / (to - from)) * iwFinal;
      const ys = (v) => m.top + ih - ((v - y.min) / (y.max - y.min || 1)) * ih;
      const center = (p) => p.t + bucketMs / 2;

      const root = svg('svg', {
        width, height, viewBox: `0 0 ${width} ${height}`, class: 'chart-svg', role: 'img',
        'aria-label': opts.ariaLabel, tabindex: 0,
      });

      // Status bands (non-operational periods) sit behind everything else.
      if (opts.statusBands) {
        const bands = svg('g', { class: 'bands' }, root);
        let run = null;
        const flush = () => {
          if (!run) return;
          svg('rect', {
            x: xs(run.start), y: m.top, width: Math.max(2, xs(run.end) - xs(run.start)), height: ih,
            class: `band band-${run.status}`,
          }, bands);
          run = null;
        };
        for (const p of points) {
          const bad = p.status && p.status !== 'operational' && p.status !== 'unknown';
          if (bad && run && run.status === p.status) run.end = p.t + bucketMs;
          else {
            flush();
            if (bad) run = { status: p.status, start: p.t, end: p.t + bucketMs };
          }
        }
        flush();
      }

      // Grid + y axis labels.
      const grid = svg('g', { class: 'grid' }, root);
      y.ticks.forEach((v, i) => {
        const yy = Math.round(ys(v)) + 0.5;
        svg('line', { x1: m.left, x2: m.left + iwFinal, y1: yy, y2: yy, class: i === 0 ? 'baseline' : 'gridline' }, grid);
        const label = svg('text', { x: m.left - 8, y: yy, class: 'axis-label', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, grid);
        label.textContent = tickLabels[i];
      });

      // X axis labels.
      const xt = timeTicks(from, to, Math.max(2, Math.floor(iwFinal / (compact ? 70 : 90))));
      for (const t of xt.ticks) {
        const label = svg('text', { x: xs(t), y: height - 8, class: 'axis-label', 'text-anchor': 'middle' }, grid);
        label.textContent = xt.label(t);
      }

      // Series.
      const seriesGroup = svg('g', { class: 'series' }, root);
      for (const s of opts.series) {
        const segments = [];
        let current = [];
        for (const p of points) {
          const v = p[s.key];
          if (v === null || v === undefined) {
            if (current.length) segments.push(current);
            current = [];
          } else {
            current.push([center(p), v]);
          }
        }
        if (current.length) segments.push(current);

        for (const seg of segments) {
          if (seg.length === 1) {
            svg('circle', { cx: xs(seg[0][0]), cy: ys(seg[0][1]), r: 2.5, fill: s.color }, seriesGroup);
            continue;
          }
          let d = '';
          seg.forEach(([t, v], i) => {
            const X = xs(t).toFixed(1);
            const Y = ys(v).toFixed(1);
            if (i === 0) d += `M${X},${Y}`;
            else if (opts.step) d += `H${X}V${Y}`;
            else d += `L${X},${Y}`;
          });
          if (opts.area) {
            const base = ys(Math.max(y.min, 0)).toFixed(1);
            const area = `${d}V${base}H${xs(seg[0][0]).toFixed(1)}Z`;
            svg('path', { d: area, fill: s.color, class: 'area' }, seriesGroup);
          }
          svg('path', { d, stroke: s.color, class: 'line' }, seriesGroup);
        }

        // End marker on the most recent value.
        const last = segments.length ? segments[segments.length - 1] : null;
        if (last) {
          const [t, v] = last[last.length - 1];
          svg('circle', { cx: xs(t), cy: ys(v), r: 4, fill: s.color, class: 'end-dot' }, seriesGroup);
        }
      }

      if (!hasData) {
        const t = svg('text', { x: m.left + iwFinal / 2, y: m.top + ih / 2, class: 'empty-label', 'text-anchor': 'middle' }, root);
        t.textContent = 'No data for this period yet';
      }

      // Hover layer.
      const hover = svg('g', { class: 'hover', visibility: 'hidden' }, root);
      const cross = svg('line', { y1: m.top, y2: m.top + ih, class: 'crosshair' }, hover);
      const dots = opts.series.map((s) => svg('circle', { r: 4.5, fill: s.color, class: 'hover-dot' }, hover));
      const overlay = svg('rect', { x: m.left, y: m.top, width: iwFinal, height: ih, class: 'overlay' }, root);

      const showIndex = (i, clientX, clientY) => {
        const p = points[i];
        if (!p) return;
        this.activeIndex = i;
        const x = xs(center(p));
        cross.setAttribute('x1', x);
        cross.setAttribute('x2', x);
        let any = false;
        opts.series.forEach((s, k) => {
          const v = p[s.key];
          if (v === null || v === undefined) dots[k].setAttribute('visibility', 'hidden');
          else {
            any = true;
            dots[k].setAttribute('visibility', 'visible');
            dots[k].setAttribute('cx', x);
            dots[k].setAttribute('cy', ys(v));
          }
        });
        hover.setAttribute('visibility', 'visible');
        const rangeLabel = bucketMs > MIN
          ? `${F.dateTime(p.t)} – ${F.time(p.t + bucketMs)}`
          : F.dateTime(p.t);
        const rows = opts.series.map((s) => {
          const v = p[s.key];
          return `<div class="tt-row"><span class="tt-key" style="--c:${s.color}"></span><span class="tt-label">${escapeHtml(s.label)}</span><span class="tt-value">${v === null || v === undefined ? '—' : escapeHtml(opts.format(v))}</span></div>`;
        }).join('');
        const status = p.status && p.status !== 'operational' && opts.statusBands
          ? `<div class="tt-status tt-status-${p.status}">${escapeHtml(window.NasStatusLabel ? window.NasStatusLabel(p.status) : p.status)}</div>`
          : '';
        const body = any ? rows : '<div class="tt-row tt-muted">No data in this interval</div>';
        Tooltip.show(`<div class="tt-title">${escapeHtml(rangeLabel)}</div>${status}${body}`, clientX, clientY);
      };

      const indexAt = (clientX) => {
        const rect = root.getBoundingClientRect();
        const t = from + ((clientX - rect.left - m.left) / iwFinal) * (to - from);
        return Math.max(0, Math.min(points.length - 1, Math.floor((t - from) / bucketMs)));
      };

      overlay.addEventListener('pointermove', (e) => showIndex(indexAt(e.clientX), e.clientX, e.clientY));
      overlay.addEventListener('pointerdown', (e) => showIndex(indexAt(e.clientX), e.clientX, e.clientY));
      const hide = () => {
        hover.setAttribute('visibility', 'hidden');
        Tooltip.hide();
        this.activeIndex = null;
      };
      overlay.addEventListener('pointerleave', hide);
      root.addEventListener('blur', hide);
      root.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) return;
        e.preventDefault();
        if (e.key === 'Escape') return hide();
        let i = this.activeIndex ?? points.length - 1;
        if (e.key === 'ArrowLeft') i -= 1;
        if (e.key === 'ArrowRight') i += 1;
        if (e.key === 'Home') i = 0;
        if (e.key === 'End') i = points.length - 1;
        i = Math.max(0, Math.min(points.length - 1, i));
        const rect = root.getBoundingClientRect();
        showIndex(i, rect.left + xs(center(points[i])), rect.top + m.top + 8);
      });

      this.el.replaceChildren(root);
    }
  }

  // ---------------------------------------------------------- sparkline
  class Sparkline {
    constructor(el, { color, height = 40, zeroBased = true } = {}) {
      this.el = el;
      this.color = color;
      this.height = height;
      this.zeroBased = zeroBased;
      this.values = [];
      this.width = 0;
      this.ro = new ResizeObserver(() => {
        if (this.el.clientWidth !== this.width) this.render();
      });
      this.ro.observe(el);
    }

    update(values) {
      this.values = values;
      this.render();
    }

    render() {
      const width = this.el.clientWidth;
      this.width = width;
      const height = this.height;
      if (!width) return;
      const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'spark-svg', 'aria-hidden': 'true' });
      const vals = this.values.map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined);
      if (vals.length >= 2) {
        const nums = vals.map(([, v]) => v);
        let lo = this.zeroBased ? 0 : Math.min(...nums);
        let hi = Math.max(...nums);
        if (hi === lo) { hi += 1; if (!this.zeroBased) lo -= 1; }
        const pad = 5;
        const n = this.values.length - 1 || 1;
        const X = (i) => pad + (i / n) * (width - pad * 2);
        const Y = (v) => pad + (height - pad * 2) * (1 - (v - lo) / (hi - lo));
        let d = '';
        let prev = null;
        for (const [i, v] of vals) {
          d += `${prev === null || i - prev > 1 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
          prev = i;
        }
        if (this.zeroBased) {
          svg('path', { d: `${d}V${height - pad}H${X(vals[0][0]).toFixed(1)}Z`, fill: this.color, class: 'area' }, root);
        }
        svg('path', { d, stroke: this.color, class: 'line' }, root);
        const [li, lv] = vals[vals.length - 1];
        svg('circle', { cx: X(li), cy: Y(lv), r: 3.5, fill: this.color, class: 'end-dot' }, root);
      }
      this.el.replaceChildren(root);
    }
  }

  // --------------------------------------------------------------- gauge
  const GAUGE_SWEEP = 270;

  function polar(cx, cy, r, deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  function arcPath(cx, cy, r, startDeg, endDeg) {
    const [x1, y1] = polar(cx, cy, r, startDeg);
    const [x2, y2] = polar(cx, cy, r, endDeg);
    const large = endDeg - startDeg > 180 ? 1 : 0;
    return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
  }

  /** Radial meter. The fill colour carries severity; the track is a dim step of the same hue. */
  function renderGauge(el, { percent, color }) {
    const size = 132;
    const r = 54;
    const c = size / 2;
    const start = -GAUGE_SWEEP / 2;
    const length = (Math.PI * 2 * r * GAUGE_SWEEP) / 360;
    const p = percent === null || percent === undefined ? 0 : Math.max(0, Math.min(100, percent));
    const root = svg('svg', { viewBox: `0 0 ${size} ${size}`, class: 'gauge-svg', 'aria-hidden': 'true' });
    svg('path', { d: arcPath(c, c, r, start, start + GAUGE_SWEEP), class: 'gauge-track', stroke: color }, root);
    const fill = svg('path', {
      d: arcPath(c, c, r, start, start + GAUGE_SWEEP),
      class: 'gauge-fill',
      stroke: color,
      'stroke-dasharray': `${length} ${length}`,
      'stroke-dashoffset': length,
    }, root);
    el.replaceChildren(root);
    // Animate from empty to the value (or straight to it if motion is reduced).
    const target = length * (1 - p / 100);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) fill.setAttribute('stroke-dashoffset', target);
    else requestAnimationFrame(() => requestAnimationFrame(() => fill.setAttribute('stroke-dashoffset', target)));
  }

  // --------------------------------------------------------------- donut
  function renderDonut(el, segments, { format = F.number } = {}) {
    const size = 168;
    const r = 66;
    const stroke = 20;
    const c = size / 2;
    const total = segments.reduce((s, x) => s + (x.value || 0), 0);
    const root = svg('svg', { viewBox: `0 0 ${size} ${size}`, class: 'donut-svg', role: 'img', 'aria-label': segments.map((s) => `${s.label}: ${format(s.value)}`).join(', ') });
    svg('circle', { cx: c, cy: c, r, class: 'donut-track', 'stroke-width': stroke }, root);
    const live = segments.filter((s) => s.value > 0);
    if (total > 0) {
      const gapDeg = live.length > 1 ? (2 / (2 * Math.PI * r)) * 360 : 0; // 2px surface gap
      let angle = 0;
      for (const s of live) {
        const sweep = (s.value / total) * 360;
        let node;
        if (sweep >= 359.99) {
          node = svg('circle', { cx: c, cy: c, r, stroke: s.color, 'stroke-width': stroke, fill: 'none', class: 'donut-seg' }, root);
        } else {
          const a0 = angle + gapDeg / 2;
          const a1 = angle + sweep - gapDeg / 2;
          node = svg('path', { d: arcPath(c, c, r, a0, Math.max(a0 + 0.01, a1)), stroke: s.color, 'stroke-width': stroke, fill: 'none', class: 'donut-seg' }, root);
        }
        const pct = (s.value / total) * 100;
        const html = `<div class="tt-title">${escapeHtml(s.label)}</div><div class="tt-row"><span class="tt-key" style="--c:${s.color}"></span><span class="tt-label">${escapeHtml(format(s.value))}</span><span class="tt-value">${pct.toFixed(1)}%</span></div>`;
        node.addEventListener('pointermove', (e) => Tooltip.show(html, e.clientX, e.clientY));
        node.addEventListener('pointerleave', () => Tooltip.hide());
        angle += sweep;
      }
    }
    el.replaceChildren(root);
  }

  // --------------------------------------------------------- uptime bars
  function renderUptimeBars(el, days, { tooltip, statusClass }) {
    el.replaceChildren();
    el.setAttribute('role', 'group');
    el.tabIndex = 0;
    const bars = days.map((day, i) => {
      const b = document.createElement('span');
      b.className = `ubar ${statusClass(day)}${i < days.length - 30 ? ' ubar-old' : ''}`;
      b.dataset.index = String(i);
      el.appendChild(b);
      return b;
    });
    let active = null;
    const show = (i, x, y) => {
      if (active !== null) bars[active].classList.remove('is-active');
      active = i;
      bars[i].classList.add('is-active');
      Tooltip.show(tooltip(days[i]), x, y);
    };
    const hide = () => {
      if (active !== null) bars[active].classList.remove('is-active');
      active = null;
      Tooltip.hide();
    };
    el.addEventListener('pointermove', (e) => {
      const target = e.target.closest('.ubar');
      if (!target) return;
      show(Number(target.dataset.index), e.clientX, e.clientY);
    });
    el.addEventListener('pointerleave', hide);
    el.addEventListener('blur', hide);
    el.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) return;
      e.preventDefault();
      if (e.key === 'Escape') return hide();
      const firstVisible = bars.findIndex((b) => b.offsetParent !== null);
      let i = active ?? days.length - 1;
      if (e.key === 'ArrowLeft') i -= 1;
      if (e.key === 'ArrowRight') i += 1;
      if (e.key === 'Home') i = firstVisible;
      if (e.key === 'End') i = days.length - 1;
      i = Math.max(Math.max(0, firstVisible), Math.min(days.length - 1, i));
      const r = bars[i].getBoundingClientRect();
      show(i, r.left + r.width / 2, r.bottom);
    });
  }

  window.NasCharts = { TimeSeriesChart, Sparkline, renderGauge, renderDonut, renderUptimeBars, Tooltip, escapeHtml, cssVar, niceTicks };
})();
