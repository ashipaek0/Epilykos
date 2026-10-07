/**
 * Retro Bar Gauge — segmented LED/VU meter style.
 * Each row: label | [▮▮▮▮▯▯▯▯▯▯] | value+unit
 * Lit segments determined by value position between min and max.
 */
import { escapeHtml, isNumericValue } from '../utils.js';
import { formatEntry, renderValue } from './format.js';
import { markBreakdown, applyBreakdowns } from './breakdown.js';
export function buildBarGaugeRetro(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const rows = (config.metrics && config.metrics.length ? config.metrics : [{ label: '', metric: '', unit: '', min: 0, max: 100, color: '', segments: 10 }]);

  const container = document.createElement('div');
  container.className = 'bar-gauge-retro-card ep-card';
  container.dataset.blockId = id;
  markBreakdown(container, config);
  container.dataset.metricMap = JSON.stringify(rows);

  let html = '';
  rows.forEach((r, i) => {
    const segs = r.segments || 10;
    const color = r.color || 'var(--accent)';
    let segsHtml = '';
    for (let s = 0; s < segs; s++) {
      segsHtml += `<span class="bg-retro-seg" id="bg-retro-seg-${id}-${i}-${s}"></span>`;
    }
    html += `
      <div class="bg-retro-row" data-bgidx="${i}">
        <span class="bg-retro-label">${escapeHtml(r.label || '--')}</span>
        <div class="bg-retro-segments" id="bg-retro-segments-${id}-${i}" data-color="${color}" data-gradient="${escapeHtml(r.gradient||'')}" data-segments="${segs}">
          ${segsHtml}
        </div>
        <span class="bg-retro-value" id="bg-retro-val-${id}-${i}" data-metric="${escapeHtml(r.metric || '')}"><span class="ep-num">\u2014</span></span>
      </div>`;
  });
  container.innerHTML = html;
  return container;
}
export function updateBarGaugeRetro(state) {
  document.querySelectorAll('.bar-gauge-retro-card').forEach(container => {
    let rows;
    try { rows = JSON.parse(container.dataset.metricMap); } catch (e) { return; }
    const id = container.dataset.blockId || '';
    const m = state.metrics || {};
    applyBreakdowns(container, state, rows.map((cfg, i) => ({ host: container.querySelector(`.bg-retro-row[data-bgidx="${i}"]`), title: cfg.label || cfg.metric, specs: [{ name: cfg.metric, unit: cfg.unit }] })));

    rows.forEach((cfg, i) => {
      if (!cfg.metric) return;
      const entry = m[cfg.metric];
      const v = entry?.value;
      if (v === undefined || v === null) return;

      const min = cfg.min ?? 0;
      const max = cfg.max ?? 100;
      const range = max - min;
      const pct = (isNumericValue(v) && range > 0) ? Math.min(1, Math.max(0, (v - min) / range)) : 0;
      const segs = cfg.segments || 10;
      const litCount = Math.round(pct * segs);
      const color = cfg.color || 'var(--accent)';
      const gradient = cfg.gradient || '';

      for (let s = 0; s < segs; s++) {
        const seg = document.getElementById(`bg-retro-seg-${id}-${i}-${s}`);
        if (!seg) continue;
        if (s < litCount) {
          let segColor = color;
          if (gradient) {
            const stops = gradient.split(',').map(c => c.trim());
            const t = segs > 1 ? s / (segs - 1) : 0;
            const idx = t * (stops.length - 1);
            const lo = Math.floor(idx), hi = Math.ceil(idx);
            if (lo === hi) segColor = stops[lo];
            else {
              const f = idx - lo;
              segColor = lerpColor(stops[lo], stops[hi], f);
            }
          }
          seg.style.background = segColor;
          seg.style.boxShadow = 'none';
        } else {
          seg.style.background = '';
          seg.style.boxShadow = 'none';
        }
      }

      const val = document.getElementById(`bg-retro-val-${id}-${i}`);
      // D6 (non-numeric: explicit units only) is handled by formatEntry.
      renderValue(val, formatEntry(entry, cfg.unit, cfg.metric));
    });
  });
}

/** Simple linear interpolation between two hex colors */
function lerpColor(a, b, t) {
  const ah = parseInt(a.replace('#', ''), 16);
  const bh = parseInt(b.replace('#', ''), 16);
  /* eslint-disable no-bitwise */
  const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
  const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
  const rr = Math.round(ar + (br - ar) * t);
  const rg = Math.round(ag + (bg - ag) * t);
  const rb = Math.round(ab + (bb - ab) * t);
  return `#${((1 << 24) | (rr << 16) | (rg << 8) | rb).toString(16).slice(1)}`;
}

