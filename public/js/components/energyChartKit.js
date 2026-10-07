/**
 * Shared pieces for the hourly energy cards (Energy day, Energy flows):
 * dates and the day picker label, theme colours, the hatched forecast
 * texture and the grey "Now" band.
 *
 * @module components/energyChartKit
 */
export function localDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
export function shiftDate(date, days) { const [y, m, d] = date.split('-').map(Number); return localDate(new Date(y, m - 1, d + days, 12)); }
export function dayLabel(date) {
  const today = localDate(new Date());
  if (date === today) return 'Today';
  if (date === shiftDate(today, -1)) return 'Yesterday';
  if (date === shiftDate(today, 1)) return 'Tomorrow';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}
export const kwh = v => (v == null || !Number.isFinite(v) ? '—' : `${v < 10 ? v.toFixed(2) : v.toFixed(1)} kWh`);

export function tokens() {
  const s = getComputedStyle(document.documentElement), v = (n, f) => s.getPropertyValue(n).trim() || f;
  return {
    home: v('--color-home', '#333333'), solar: v('--color-solar', '#f59e0b'), battery: v('--color-battery', '#4a6a2e'),
    text: v('--text-secondary', '#64748b'), grid: document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)',
    now: document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)'
  };
}
export function alpha(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex); if (!m) return hex;
  const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
/** Diagonal stripes in `color`: the forecast texture. */
export function hatch(color) {
  const c = document.createElement('canvas'); c.width = c.height = 8;
  const x = c.getContext('2d');
  x.fillStyle = alpha(color, 0.12); x.fillRect(0, 0, 8, 8);
  x.strokeStyle = alpha(color, 0.85); x.lineWidth = 1.5;
  x.beginPath(); x.moveTo(-2, 10); x.lineTo(10, -2); x.moveTo(-2, 2); x.lineTo(2, -2); x.moveTo(6, 10); x.lineTo(10, 6); x.stroke();
  return x.createPattern(c, 'repeat');
}

/** Grey band behind the current hour; `label` adds a "Now" tag above it. */
export function nowBand(getIndex, label) {
  return {
    id: 'edNow',
    beforeDatasetsDraw(chart) {
      const i = getIndex(); if (i == null || i < 0) return;
      const x = chart.scales.x, { top, bottom } = chart.chartArea, ctx = chart.ctx;
      const w = x.width / x.ticks.length, cx = x.getPixelForValue(i);
      ctx.save(); ctx.fillStyle = tokens().now; ctx.fillRect(cx - w / 2, top, w, bottom - top);
      if (label) { ctx.fillStyle = tokens().text; ctx.font = '600 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Now', cx, top - 4); }
      ctx.restore();
    }
  };
}

