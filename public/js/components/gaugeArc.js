/**
 * Shared SVG arcs for the gauge cards. Arcs use pathLength="100", so fills
 * are set in percent with stroke-dasharray / stroke-dashoffset, and the SVG
 * scales with its block (viewBox, no fixed pixel size).
 *
 * @module components/gaugeArc
 */

function polar(cx, cy, r, deg) {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** SVG path for an arc from startDeg to endDeg (0° = 12 o'clock, clockwise). */
export function arcPath(cx, cy, r, startDeg, endDeg) {
  const [x1, y1] = polar(cx, cy, r, startDeg);
  const [x2, y2] = polar(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/**
 * Gauge SVG markup: a track and a fill along the same arc.
 * @param {{viewBox: string, d: string, width: number, color: string}} o
 */
export function gaugeSvg(o) {
  return `<svg class="ep-gauge-svg" viewBox="${o.viewBox}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path class="ep-gauge-track" d="${o.d}" pathLength="100" fill="none" stroke-width="${o.width}" stroke-linecap="round"/>
    <path class="ep-gauge-fill" d="${o.d}" pathLength="100" fill="none" stroke="${o.color}" stroke-width="${o.width}" stroke-linecap="round" stroke-dasharray="0 100"/>
  </svg>`;
}

/** Fill from `from` to `to` (fractions of the arc, 0..1). */
export function setArc(fillEl, from, to, color) {
  if (!fillEl) return;
  const a = Math.max(0, Math.min(1, Math.min(from, to)));
  const b = Math.max(0, Math.min(1, Math.max(from, to)));
  const len = (b - a) * 100;
  // A zero-length round-capped dash still draws a dot; hide it instead.
  fillEl.style.visibility = len < 0.5 ? 'hidden' : '';
  fillEl.setAttribute('stroke-dasharray', `${len} 100`);
  fillEl.setAttribute('stroke-dashoffset', String(-a * 100));
  if (color) fillEl.setAttribute('stroke', color);
}

export function negativeColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--color-negative').trim() || '#d94141';
}
