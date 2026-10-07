import { escapeHtml, isNumericValue } from '../utils.js';
import { formatEntry, renderValue } from './format.js';
import { arcPath, gaugeSvg, setArc } from './gaugeArc.js';
import { markBreakdown, applyBreakdowns } from './breakdown.js';

/** One value on a 270° dial. Scales with its block. */
export function buildGaugeCard(block = {}) {
  const config = block.config || {};
  const metric = config.metric || '';
  const min = config.min ?? 0, max = config.max ?? 100;
  const color = config.color || 'var(--accent)';
  const container = document.createElement('div');
  container.className = 'gauge-card stat-card ep-card ep-gauge';
  container.dataset.blockId = block.id || '';
  markBreakdown(container, config);
  container.dataset.metricMap = JSON.stringify({ value: metric, min, max, color });
  container.innerHTML = `
    <div class="ep-gauge-wrap ep-gauge-ring">
      ${gaugeSvg({ viewBox: '0 0 200 200', d: arcPath(100, 100, 80, -135, 135), width: 16, color: escapeHtml(color) })}
      <div class="ep-gauge-readout">
        <span class="stat-value ep-value is-empty"><span class="ep-num">—</span></span>
        <span class="stat-label ep-label">${escapeHtml(config.title || metric || 'Gauge')}</span>
      </div>
    </div>`;
  return container;
}

export function updateGaugeCard(state) {
  document.querySelectorAll('.gauge-card').forEach(container => {
    let cfg; try { cfg = JSON.parse(container.dataset.metricMap); } catch (e) { return; }
    applyBreakdowns(container, state, [{ host: container, title: container.querySelector('.ep-label')?.textContent || '', specs: [{ name: cfg.value }] }]);
    const entry = state.metrics?.[cfg.value];
    const v = entry?.value;
    if (v === undefined || v === null) return;
    const fill = container.querySelector('.ep-gauge-fill');
    // Non-numeric values show as text with an empty arc (D6: explicit units only).
    const pct = isNumericValue(v) && cfg.max !== cfg.min ? (v - cfg.min) / (cfg.max - cfg.min) : 0;
    setArc(fill, 0, pct);
    renderValue(container.querySelector('.stat-value'), formatEntry(entry, '', cfg.value));
  });
}
