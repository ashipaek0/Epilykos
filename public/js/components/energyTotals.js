/**
 * Day totals card: a row of tiles with today's energy so far.
 *
 *   To grid / From grid   kWh exported and imported today
 *   Consumption / Solar   kWh so far, and the day's forecast as a range,
 *                         drawn on one scale: the "So far" bar fills up
 *                         towards the forecast band below it.
 *   Battery in / out      kWh charged and discharged today (optional)
 *
 * Data: /api/energy/hourly?forecast=1 (day totals and the day forecast).
 * Refreshes every 5 minutes.
 *
 * @module components/energyTotals
 */
import { escapeHtml } from '../utils.js';
import { icon } from '../editor-catalog.js';
import { markBreakdown, applyBreakdowns, kwhFormat } from './breakdown.js';

const REFRESH_MS = 5 * 60 * 1000;
export const ENERGY_TOTAL_TILES = {
  grid_export: { label: 'To grid', field: 'grid_export', color: '--color-export', icon: 'plug' },
  grid_import: { label: 'From grid', field: 'grid_import', color: '--color-grid', icon: 'plug' },
  consumption: { label: 'Consumption', field: 'consumption', color: '--color-home', icon: 'flow', forecast: 'consumption' },
  solar: { label: 'Solar', field: 'solar', color: '--color-solar', icon: 'sun', forecast: 'solar' },
  battery_charge: { label: 'Battery in', field: 'battery_charge', color: '--color-battery', icon: 'chartArea' },
  battery_discharge: { label: 'Battery out', field: 'battery_discharge', color: '--color-battery', icon: 'chartArea' }
};
export const DEFAULT_TILES = ['grid_export', 'grid_import', 'consumption', 'solar'];

const fmt = v => (v == null || !Number.isFinite(v) ? '—' : v === 0 ? '0' : v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const range = r => (r ? (Math.abs(r.high - r.low) < 0.05 ? `${fmt(r.expected)} kWh` : `${fmt(r.low)}–${fmt(r.high)} kWh`) : null);

export function buildEnergyTotals(block = {}) {
  const config = block.config || {};
  const keys = (Array.isArray(config.show) && config.show.length ? config.show : DEFAULT_TILES).filter(k => ENERGY_TOTAL_TILES[k]);
  const card = document.createElement('div');
  card.className = 'energy-totals-card';
  card.dataset.blockId = block.id || '';
  markBreakdown(card, config);
  card.innerHTML = (config.title ? `<h3 class="et-title">${escapeHtml(config.title)}</h3>` : '') +
    `<div class="et-tiles">${keys.map(k => {
      const t = ENERGY_TOTAL_TILES[k];
      return `<section class="et-tile" data-tile="${k}" style="--et-c: var(${t.color})">
        <h4 class="et-label"><span class="et-icon" aria-hidden="true">${icon(t.icon, 16)}</span>${escapeHtml(t.label)}</h4>
        <p class="et-value"><span class="et-num">—</span> <span class="et-unit">kWh</span></p>
        ${t.forecast ? `<div class="et-compare" hidden>
          <div class="et-row"><span>So far</span><span class="et-sofar"></span></div>
          <div class="et-track"><span class="et-fill"></span></div>
          <div class="et-row"><span>Forecast</span><span class="et-range"></span></div>
          <div class="et-track"><span class="et-band"></span></div>
        </div>` : ''}
      </section>`;
    }).join('')}</div><p class="et-status" role="status"></p>`;

  const load = async () => {
    try {
      const res = await fetch('/api/energy/hourly?forecast=1', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      render(card, await res.json());
    } catch (err) {
      card.querySelector('.et-status').textContent = 'Energy totals are unavailable right now.';
      console.warn('[energy-totals] load failed:', err);
    }
  };
  requestAnimationFrame(load);
  const timer = setInterval(() => { if (!card.isConnected) clearInterval(timer); else load(); }, REFRESH_MS);
  return card;
}

/**
 * Parts of each tile's daily total (e.g. today's kWh per MPPT or inverter),
 * from the dashboard state. Each tile follows its daily role, so a tile shows
 * parts when that role is a combined metric: a sum of daily kWh, or energy
 * today from a sum of power.
 */
export function updateEnergyTotalsFromState(state) {
  document.querySelectorAll('.energy-totals-card').forEach(card => {
    applyBreakdowns(card, state, [...card.querySelectorAll('.et-tile')].map(tile => {
      const t = ENERGY_TOTAL_TILES[tile.dataset.tile];
      return { host: tile, title: `${t.label} today`, specs: [{ name: `daily_${t.field}`, format: kwhFormat }], before: tile.querySelector('.et-compare') };
    }));
  });
}

export function render(card, data) {
  const totals = data.totals?.energy || {}, day = data.forecast?.day || {};
  card.querySelector('.et-status').textContent = '';
  card.querySelectorAll('.et-tile').forEach(tile => {
    const t = ENERGY_TOTAL_TILES[tile.dataset.tile];
    const actual = totals[t.field];
    tile.querySelector('.et-num').textContent = fmt(actual);
    const box = tile.querySelector('.et-compare');
    if (!box) return;
    const fc = day[t.forecast];
    box.hidden = !fc;
    if (!fc) return;
    // One scale for both bars: the larger of the forecast's top and the actual.
    const max = Math.max(fc.high || 0, actual || 0) || 1, pct = v => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
    // The big number already says how much; this row says how far along.
    tile.querySelector('.et-sofar').textContent = fc.expected > 0 ? `${Math.round(((actual || 0) / fc.expected) * 100)}% of forecast` : '';
    tile.querySelector('.et-range').textContent = range(fc);
    tile.querySelector('.et-fill').style.width = pct(actual || 0);
    const band = tile.querySelector('.et-band');
    band.style.left = pct(fc.low); band.style.width = `calc(${pct(fc.high)} - ${pct(fc.low)})`;
    band.style.minWidth = '4px';
    tile.querySelector('.et-compare').setAttribute('aria-label', `${t.label}: ${fmt(actual)} kWh so far, forecast ${range(fc)} for the day`);
  });
}
