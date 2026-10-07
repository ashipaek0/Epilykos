/**
 * Costs and earnings card: what each hour of the day cost or earned, at the
 * prices in Settings > Prices and savings.
 *
 *   above zero  grid earnings (exported kWh x sell price)
 *   below zero  battery wear (kWh into and out of the battery x wear cost)
 *               and grid costs (imported kWh x buy price)
 *
 * Hours so far use measured energy; the rest of today uses the forecast flows
 * from the battery projection (hatched). Totals underneath: net result, grid
 * earnings, grid costs and battery wear, each so far and with the forecast.
 *
 * Colours: categorical palette by meaning, ordered so touching segments pass
 * the colour-blind check in both themes (worst adjacent dE 21.6 light, 19.2 dark).
 *
 * @module components/energyCosts
 */
import { escapeHtml } from '../utils.js';
import { ensureChartJS } from '../chartLoader.js';
import { localDate, shiftDate, dayLabel, tokens, hatch, nowBand } from './energyChartKit.js';

const REFRESH_MS = 5 * 60 * 1000;
const PARTS = [
  { key: 'grid_earnings', label: 'Grid earnings', side: 1, light: '#1baf7a', dark: '#199e70' },
  { key: 'battery_cost', label: 'Battery wear', side: -1, light: '#2a78d6', dark: '#3987e5' },
  { key: 'grid_cost', label: 'Grid costs', side: -1, light: '#e34948', dark: '#e66767' }
];

function money(currency) {
  const nf = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v => `${v < 0 ? '−' : ''}${currency || ''}${currency && /\w$/.test(currency) ? ' ' : ''}${nf.format(Math.abs(v))}`;
}
const axisMoney = v => { const a = Math.abs(v); return `${v < 0 ? '−' : ''}${a >= 1000 ? `${+(a / 1000).toFixed(1)}k` : Number.isInteger(a) ? a : a.toFixed(1)}`; };

/** Forecast cost of one projected hour from its flows and the prices. */
function forecastCosts(flows, prices) {
  const imported = (flows.grid_to_home || 0) + (flows.grid_to_battery || 0);
  const exported = (flows.solar_to_grid || 0) + (flows.battery_to_grid || 0);
  const battery = (flows.solar_to_battery || 0) + (flows.grid_to_battery || 0) + (flows.battery_to_home || 0) + (flows.battery_to_grid || 0);
  return { grid_earnings: exported * prices.sell, grid_cost: imported * prices.buy, battery_cost: battery * prices.batteryWear };
}

export function buildEnergyCosts(block = {}) {
  const config = block.config || {};
  const card = document.createElement('div');
  card.className = 'energy-day-card energy-costs-card';
  card.dataset.blockId = block.id || '';
  card.innerHTML = `
    <div class="ed-header">
      ${config.hideTitle ? '<span></span>' : `<h3 class="ed-title">${escapeHtml(config.title || 'Costs and earnings')}</h3>`}
      <div class="ed-controls">
        <button type="button" class="ed-btn ed-toggle-forecast" aria-pressed="false">Hide forecast</button>
        <div class="ed-daynav" role="group" aria-label="Day">
          <button type="button" class="ed-btn ed-prev" aria-label="Previous day">‹</button>
          <span class="ed-day" aria-live="polite">Today</span>
          <button type="button" class="ed-btn ed-next" aria-label="Next day">›</button>
        </div>
      </div>
    </div>
    <div class="ed-panels"><div class="ed-panel ed-energy"><canvas aria-label="Costs and earnings per hour"></canvas></div></div>
    <div class="ed-legend"></div>
    <div class="ec-totals">
      ${[['result', 'Net result'], ['grid_earnings', 'Grid earnings'], ['grid_cost', 'Grid costs'], ['battery_cost', 'Battery wear']].map(([k, l]) =>
        `<section class="ec-total" data-total="${k}"><h4>${l}</h4><p class="ec-amount">—</p><p class="ec-sub"></p></section>`).join('')}
    </div>
    <p class="ec-prices"></p>
    <p class="ed-status" role="status"></p>`;
  const state = { date: localDate(new Date()), hideForecast: config.showForecast === false, data: null, chart: null };
  card._energyCosts = state;
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
  const state = card._energyCosts, today = localDate(new Date()), date = state.date;
  card.querySelector('.ed-day').textContent = dayLabel(date);
  card.querySelector('.ed-next').disabled = date >= today;
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
    status.textContent = 'Cost data is unavailable right now.';
    console.warn('[energy-costs] load failed:', err);
  }
}

function render(card) {
  const state = card._energyCosts, data = state.data;
  if (!data || typeof Chart === 'undefined') return;
  const t = tokens(), dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const surface = getComputedStyle(card).backgroundColor || (dark ? '#111111' : '#f5f5f5');
  const prices = data.prices || { buy: 0, sell: 0, batteryWear: 0 }, fmt = money(data.currency);
  const hours = data.hours, projection = data.forecast?.battery || null;
  const projected = new Map((projection?.hours || []).map(p => [p.start, p]));
  const showForecast = !!projection && !state.hideForecast;
  const labels = hours.map(h => String(new Date(h.start * 1000).getHours()).padStart(2, '0'));
  const nowIndex = hours.findIndex(h => h.status === 'current');
  const toggle = card.querySelector('.ed-toggle-forecast');
  toggle.hidden = !projection; toggle.textContent = state.hideForecast ? 'Show forecast' : 'Hide forecast'; toggle.setAttribute('aria-pressed', String(state.hideForecast));

  const points = hours.map(h => {
    if (h.status !== 'future') return { costs: h.costs, forecast: false };
    const p = showForecast && projected.get(h.start);
    return p && p.flows ? { costs: forecastCosts(p.flows, prices), forecast: true } : { costs: null, forecast: false };
  });
  const used = PARTS.filter(part => points.some(p => p.costs && p.costs[part.key] > 0.005));
  const datasets = used.map(part => {
    const color = dark ? part.dark : part.light, pattern = hatch(color);
    return {
      label: part.label, key: part.key, stack: 'money',
      data: points.map(p => (p.costs && p.costs[part.key] ? part.side * p.costs[part.key] : null)),
      backgroundColor: points.map(p => (p.forecast ? pattern : color)),
      borderColor: points.map(p => (p.forecast ? color : surface)), borderWidth: 1,
      borderRadius: 2, borderSkipped: false, categoryPercentage: 0.82, barPercentage: 0.92
    };
  });

  if (state.chart) { state.chart.destroy(); state.chart = null; }
  state.chart = new Chart(card.querySelector('.ed-energy canvas').getContext('2d'), {
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
          grid: { color: ctx => (ctx.tick.value === 0 ? t.text : t.grid) },
          ticks: { color: t.text, font: { size: 10 }, maxTicksLimit: 7, callback: axisMoney },
          title: { display: true, text: data.currency ? `${data.currency}` : 'Cost', color: t.text, font: { size: 10 } }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: item => item.raw != null && item.raw !== 0,
          callbacks: {
            title: items => (items.length ? `${labels[items[0].dataIndex]}:00–${String((Number(labels[items[0].dataIndex]) + 1) % 24).padStart(2, '0')}:00${points[items[0].dataIndex].forecast ? ' (forecast)' : ''}` : ''),
            label: item => `${item.dataset.label}: ${fmt(Math.abs(item.raw))}`,
            footer: items => { const c = items.length ? points[items[0].dataIndex].costs : null; return c ? `Net: ${fmt((c.grid_earnings || 0) - (c.grid_cost || 0) - (c.battery_cost || 0))}` : ''; }
          }
        }
      }
    },
    plugins: [nowBand(() => nowIndex, true)]
  });

  const legend = used.map(part => ['solid', dark ? part.dark : part.light, part.label]);
  if (points.some(p => p.forecast)) legend.push(['hatch', t.text, 'Forecast']);
  card.querySelector('.ed-legend').innerHTML = legend.map(([kind, color, name]) => `<span class="ed-key"><span class="ed-swatch ed-swatch-${kind}" style="--c:${color}"></span>${escapeHtml(name)}</span>`).join('');

  // Totals: so far, and for the whole day with the forecast.
  const sum = (filter) => points.reduce((acc, p) => { if (p.costs && filter(p)) for (const k of ['grid_earnings', 'grid_cost', 'battery_cost']) acc[k] += p.costs[k] || 0; return acc; }, { grid_earnings: 0, grid_cost: 0, battery_cost: 0 });
  const soFar = sum(p => !p.forecast), withForecast = sum(() => true);
  const net = c => c.grid_earnings - c.grid_cost - c.battery_cost;
  const hasForecast = points.some(p => p.forecast);
  for (const [k, value, dayValue] of [['result', net(soFar), net(withForecast)], ['grid_earnings', soFar.grid_earnings, withForecast.grid_earnings], ['grid_cost', soFar.grid_cost, withForecast.grid_cost], ['battery_cost', soFar.battery_cost, withForecast.battery_cost]]) {
    const box = card.querySelector(`[data-total="${k}"]`);
    box.querySelector('.ec-amount').textContent = fmt(value);
    box.querySelector('.ec-sub').textContent = hasForecast ? `${fmt(dayValue)} with forecast` : (state.date === localDate(new Date()) ? 'So far today' : 'Whole day');
  }
  card.querySelector('.ec-prices').textContent = `Prices per kWh: buy ${fmt(prices.buy)} · sell ${fmt(prices.sell)} · battery wear ${fmt(prices.batteryWear)}`;

  const noPrices = !prices.buy && !prices.sell && !prices.batteryWear;
  card.querySelector('.ed-status').textContent = noPrices ? 'Set your prices in Settings › Prices and savings to see costs.'
    : (!used.length ? 'No costs or earnings for this day.' : '');
}
