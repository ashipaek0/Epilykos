/**
 * Half Gauge Card — 180° semicircle gauge (9 o'clock to 3 o'clock).
 * Fills from the zero point: positive values to the right, negative values
 * (when the range includes them) to the left in the negative colour.
 */
import { escapeHtml, isNumericValue } from '../utils.js';
import { formatEntry, renderValue } from './format.js';
import { arcPath, gaugeSvg, setArc, negativeColor } from './gaugeArc.js';
import { markBreakdown, applyBreakdowns } from './breakdown.js';

export function buildHalfGaugeCard(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const metric = config.metric || '';
  const min = config.min ?? -100;
  const max = config.max ?? 100;
  const color = config.color || 'var(--color-solar)';

  const container = document.createElement('div');
  container.className = 'half-gauge-card stat-card ep-card ep-gauge';
  container.dataset.metricMap = JSON.stringify({ value: metric, min, max, color });
  container.dataset.blockId = id;
  markBreakdown(container, config);
  container.innerHTML = `
    <div class="ep-gauge-wrap ep-gauge-half">
      ${gaugeSvg({ viewBox: '0 0 200 112', d: arcPath(100, 100, 82, -90, 90), width: 18, color: escapeHtml(color) })}
      <div class="ep-gauge-readout">
        <span class="stat-value ep-value is-empty"><span class="ep-num">—</span></span>
      </div>
    </div>
    <span class="stat-label ep-label">${escapeHtml(config.title || metric || 'Gauge')}</span>`;
  return container;
}

export function updateHalfGaugeCard(state) {
  document.querySelectorAll('.half-gauge-card').forEach(container => {
    let cfg; try { cfg = JSON.parse(container.dataset.metricMap); } catch (e) { return; }
    applyBreakdowns(container, state, [{ host: container, title: container.querySelector('.ep-label')?.textContent || '', specs: [{ name: cfg.value }] }]);
    const entry = state.metrics?.[cfg.value];
    const v = entry?.value;
    if (v === undefined || v === null) return;
    const fill = container.querySelector('.ep-gauge-fill');
    if (isNumericValue(v)) {
      const min = cfg.min ?? -100, max = cfg.max ?? 100;
      const range = max - min || 1;
      const pct = Math.max(0, Math.min(1, (v - min) / range));
      const zero = Math.max(0, Math.min(1, (0 - min) / range));
      setArc(fill, zero, pct, pct >= zero ? (cfg.color || 'var(--color-solar)') : negativeColor());
    } else {
      // AC-2.5: a number→text flip must not leave the previous fill on screen.
      setArc(fill, 0, 0, cfg.color || 'var(--color-solar)');
    }
    renderValue(container.querySelector('.stat-value'), formatEntry(entry, '', cfg.value));
  });
}
