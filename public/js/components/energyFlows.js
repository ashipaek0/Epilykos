/**
 * Energy flows card: where each hour's energy came from and went.
 *
 * One stacked bar per hour on a signed kWh axis:
 *   above zero  energy from solar: to the home, the battery, the grid
 *   below zero  energy from the battery, the grid and a generator: battery
 *               to home, grid to home, battery to grid, grid to battery,
 *               generator to home, generator to battery
 * Hours so far are solid; the rest of today is the forecast (hatched),
 * from the battery projection, so it needs a battery capacity in Settings.
 *
 * Colours: the validated categorical palette, picked by meaning and ordered so
 * every pair of touching segments stays apart for colour-blind readers in both
 * themes (checked with the dataviz validator; worst adjacent pair dE 9.1 light,
 * 8.4 dark; the generator segments, teal as on every chart, add no worse pair).
 *
 * @module components/energyFlows
 */
import { escapeHtml } from '../utils.js';
import { ensureChartJS } from '../chartLoader.js';
import { localDate, shiftDate, dayLabel, kwh, tokens, hatch, nowBand } from './energyChartKit.js';

const REFRESH_MS = 5 * 60 * 1000;
const MAX_DAYS_AHEAD = 0;   // flows are forecast for the rest of today only

// Stack order matters: within each side, the first flow sits next to zero.
const FLOWS = [
  { key: 'solar_to_home', label: 'Solar to home', side: 1, light: '#eda100', dark: '#c98500' },
  { key: 'solar_to_battery', label: 'Solar to battery', side: 1, light: '#1baf7a', dark: '#199e70' },
  { key: 'solar_to_grid', label: 'Solar to grid', side: 1, light: '#eb6834', dark: '#d95926' },
  { key: 'battery_to_home', label: 'Battery to home', side: -1, light: '#2a78d6', dark: '#3987e5' },
  { key: 'grid_to_home', label: 'Grid to home', side: -1, light: '#e34948', dark: '#e66767' },
  { key: 'generator_to_home', label: 'Generator to home', side: -1, light: '#008f96', dark: '#00a3a3' },
  { key: 'battery_to_grid', label: 'Battery to grid', side: -1, light: '#4a3aa7', dark: '#9085e9' },
  { key: 'grid_to_battery', label: 'Grid to battery', side: -1, light: '#e87ba4', dark: '#d55181' },
  { key: 'generator_to_battery', label: 'Generator to battery', side: -1, light: '#5f8a00', dark: '#6f9a10' }
];
export const ENERGY_FLOW_KEYS = FLOWS.map(f => f.key);

// Axis numbers with a real minus sign: 0, −1, 2.5.
const signed = v => { const a = Math.abs(v); return `${v < 0 ? '−' : ''}${Number.isInteger(a) ? a : a.toFixed(a < 1 ? 2 : 1)}`; };

/** "↑ From solar" / "↓ From battery and grid" inside the plot, at each end. */
const sideLabels = {
  id: 'efSides',
  afterDraw(chart) {
    const { left, top, bottom } = chart.chartArea, y = chart.scales.y, ctx = chart.ctx, t = tokens();
    ctx.save(); ctx.fillStyle = t.text; ctx.font = '600 10px system-ui, sans-serif'; ctx.textAlign = 'left';
    if (y.max > 0) { ctx.textBaseline = 'top'; ctx.fillText('↑ From solar', left + 6, top + 4); }
    if (y.min < 0) { ctx.textBaseline = 'bottom'; ctx.fillText((chart.options.plugins.efSides && chart.options.plugins.efSides.low) || '↓ From battery and grid', left + 6, bottom - 4); }
    ctx.restore();
  }
};

export function buildEnergyFlows(block = {}) {
  const config = block.config || {};
  const card = document.createElement('div');
  card.className = 'energy-day-card energy-flows-card';
  card.dataset.blockId = block.id || '';
  card.innerHTML = `
    <div class="ed-header">
      ${config.hideTitle ? '<span></span>' : `<h3 class="ed-title">${escapeHtml(config.title || 'Energy flows')}</h3>`}
      <div class="ed-controls">
        <button type="button" class="ed-btn ed-toggle-forecast" aria-pressed="false">Hide forecast</button>
        <div class="ed-daynav" role="group" aria-label="Day">
          <button type="button" class="ed-btn ed-prev" aria-label="Previous day">‹</button>
          <span class="ed-day" aria-live="polite">Today</span>
          <button type="button" class="ed-btn ed-next" aria-label="Next day">›</button>
        </div>
      </div>
    </div>
    <div class="ed-panels"><div class="ed-panel ed-energy"><canvas aria-label="Energy flows per hour"></canvas></div></div>
    <div class="ed-legend"></div>
    <p class="ed-status" role="status"></p>`;
  const state = { date: localDate(new Date()), hideForecast: config.showForecast === false, data: null, chart: null };
  card._energyFlows = state;
  card.querySelector('.ed-prev').addEventListener('click', () => { state.date = shiftDate(state.date, -1); load(card); });
  card.querySelector('.ed-next').addEventListener('click', () => { state.date = shiftDate(state.date, 1); load(card); });
  card.querySelector('.ed-toggle-forecast').addEventListener('click', () => { state.hideForecast = !state.hideForecast; render(card); });
  requestAnimationFrame(() => load(card));
  const timer = setInterval(() => {
    if (!card.isConnected) { clearInterval(timer); return; }
    if (state.date === localDate(new Date())) load(card, true);
  }, REFRESH_MS);
  const themeWatch = new MutationObserver(() => { if (!card.isConnected) themeWatch.disconnect(); else if (state.data) render(card); });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return card;
}

async function load(card, quiet) {
  const state = card._energyFlows, today = localDate(new Date()), date = state.date;
  card.querySelector('.ed-day').textContent = dayLabel(date);
  card.querySelector('.ed-next').disabled = date >= shiftDate(today, MAX_DAYS_AHEAD);
  const status = card.querySelector('.ed-status');
  if (!quiet) status.textContent = 'Loading…';
  try {
    const res = await fetch(`/api/energy/hourly?date=${date}${date === today ? '&forecast=1' : ''}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (state.date !== date) return;
    state.data = data;
    await ensureChartJS();
    render(card);
  } catch (err) {
    if (state.date !== date) return;
    status.textContent = 'Energy data is unavailable right now.';
    console.warn('[energy-flows] load failed:', err);
  }
}

function render(card) {
  const state = card._energyFlows, data = state.data;
  if (!data || typeof Chart === 'undefined') return;
  const t = tokens(), dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const surface = getComputedStyle(card).backgroundColor || (dark ? '#111111' : '#f5f5f5');
  const hours = data.hours, projection = data.forecast?.battery || null;
  const projected = new Map((projection?.hours || []).map(p => [p.start, p]));
  const showForecast = !!projection && !state.hideForecast;
  const labels = hours.map(h => String(new Date(h.start * 1000).getHours()).padStart(2, '0'));
  const nowIndex = hours.findIndex(h => h.status === 'current');
  const toggle = card.querySelector('.ed-toggle-forecast');
  toggle.hidden = !projection; toggle.textContent = state.hideForecast ? 'Show forecast' : 'Hide forecast'; toggle.setAttribute('aria-pressed', String(state.hideForecast));

  // Each hour: measured flows for hours that have started, projected ones after.
  const point = h => {
    if (h.status !== 'future') return { flows: h.flows, forecast: false };
    const p = showForecast && projected.get(h.start);
    return p && p.flows ? { flows: p.flows, forecast: true, spare: p.spareSolar } : { flows: null, forecast: false };
  };
  const points = hours.map(point);
  const used = FLOWS.filter(f => points.some(p => p.flows && p.flows[f.key] > 0.0005));
  const datasets = used.map(f => {
    const color = dark ? f.dark : f.light, pattern = hatch(color);
    return {
      label: f.label, key: f.key, stack: 'flows',
      data: points.map(p => (p.flows && p.flows[f.key] ? f.side * p.flows[f.key] : null)),
      backgroundColor: points.map(p => (p.forecast ? pattern : color)),
      // Solid segments get a thin card-coloured edge so stacked colours stay apart.
      borderColor: points.map(p => (p.forecast ? color : surface)), borderWidth: 1,
      borderRadius: 2, borderSkipped: false, categoryPercentage: 0.82, barPercentage: 0.92
    };
  });

  if (state.chart) { state.chart.destroy(); state.chart = null; }
  const canvas = card.querySelector('.ed-energy canvas');
  state.chart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      layout: { padding: { top: 14 } },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true, offset: true, grid: { display: false }, ticks: { color: t.text, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 6 } },
        y: {
          stacked: true, grace: '8%', border: { display: false },
          grid: { color: ctx => (ctx.tick.value === 0 ? t.text : t.grid), lineWidth: ctx => (ctx.tick.value === 0 ? 1 : 1) },
          ticks: { color: t.text, font: { size: 10 }, maxTicksLimit: 7, callback: v => signed(v) },
          title: { display: true, text: 'kWh', color: t.text, font: { size: 10 } }
        }
      },
      plugins: {
        efSides: { low: used.some(f => f.key.startsWith('generator_')) ? '↓ From battery, grid and generator' : '↓ From battery and grid' },
        legend: { display: false },
        tooltip: {
          filter: item => item.raw != null && item.raw !== 0,
          callbacks: {
            title: items => (items.length ? `${labels[items[0].dataIndex]}:00–${String((Number(labels[items[0].dataIndex]) + 1) % 24).padStart(2, '0')}:00${points[items[0].dataIndex].forecast ? ' (forecast)' : ''}` : ''),
            label: item => `${item.dataset.label}: ${kwh(Math.abs(item.raw))}`,
            footer: items => { const p = items.length ? points[items[0].dataIndex] : null; return p && p.spare > 0.05 ? `${kwh(p.spare)} more solar than the home and battery can take` : ''; }
          }
        }
      }
    },
    plugins: [nowBand(() => nowIndex, true), sideLabels]
  });

  const legend = used.map(f => ['solid', dark ? f.dark : f.light, f.label]);
  if (points.some(p => p.forecast)) legend.push(['hatch', t.text, 'Forecast']);
  card.querySelector('.ed-legend').innerHTML = legend.map(([kind, color, name]) => `<span class="ed-key"><span class="ed-swatch ed-swatch-${kind}" style="--c:${color}"></span>${escapeHtml(name)}</span>`).join('');

  const today = localDate(new Date());
  const status = card.querySelector('.ed-status');
  status.textContent = !used.length ? 'No energy recorded for this day.'
    : (state.date === today && !projection ? 'Add your battery capacity in Settings › Prices and savings to see the rest of today forecast.' : '');
}
