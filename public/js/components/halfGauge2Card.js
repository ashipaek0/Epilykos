/**
 * Half Gauge 2 Card — 180° semicircle (9 o'clock to 3 o'clock).
 * Zero at 12 o'clock (top centre). Positive fills clockwise to 3 o'clock (right).
 * Negative fills counter-clockwise to 9 o'clock (left).
 */
import { escapeHtml, isNumericValue } from '../utils.js';
import { formatEntry, renderValue } from './format.js';
import { arcPath, gaugeSvg, setArc, negativeColor } from './gaugeArc.js';

export function buildHalfGauge2Card(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const metric = config.metric || '';
  const min = config.min ?? -100;
  const max = config.max ?? 100;
  const color = config.color || 'var(--color-solar)';

  const container = document.createElement('div');
  container.className = 'half-gauge2-card stat-card ep-card ep-gauge';
  container.dataset.metricMap = JSON.stringify({ value: metric, min, max, color });
  container.dataset.blockId = id;
  container.innerHTML = `
    <div class="ep-gauge-wrap ep-gauge-half">
      ${gaugeSvg({ viewBox: '0 0 200 112', d: arcPath(100, 100, 82, -90, 90), width: 18, color: escapeHtml(color) })}
      <span class="ep-gauge-zero" aria-hidden="true"></span>
      <div class="ep-gauge-readout">
        <span class="stat-value ep-value is-empty"><span class="ep-num">—</span></span>
      </div>
    </div>
    <span class="stat-label ep-label">${escapeHtml(config.title || metric || 'Gauge')}</span>`;
  return container;
}

export function updateHalfGauge2Card(state) {
  document.querySelectorAll('.half-gauge2-card').forEach(container => {
    let cfg; try { cfg = JSON.parse(container.dataset.metricMap); } catch (e) { return; }
    const entry = state.metrics?.[cfg.value];
    const v = entry?.value;
    if (v === undefined || v === null) return;
    const fill = container.querySelector('.ep-gauge-fill');
    if (isNumericValue(v)) {
      const min = cfg.min ?? -100, max = cfg.max ?? 100;
      // Each side of the centre covers its own half of the range.
      let frac;
      if (v >= 0) frac = max > 0 ? Math.min(1, v / max) : 0;
      else frac = min < 0 ? -Math.min(1, v / min) : 0;
      setArc(fill, 0.5, 0.5 + frac / 2, v >= 0 ? (cfg.color || 'var(--color-solar)') : negativeColor());
    } else {
      // AC-2.6: a number→text flip must not leave the previous fill on screen.
      setArc(fill, 0.5, 0.5, cfg.color || 'var(--color-solar)');
    }
    renderValue(container.querySelector('.stat-value'), formatEntry(entry, '', cfg.value));
  });
}
