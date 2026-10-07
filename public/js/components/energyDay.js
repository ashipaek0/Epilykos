/**
 * Energy day card: one day's energy by the hour.
 *
 *   top panel     consumption and solar (kWh per hour). Past hours are solid,
 *                 forecast hours hatched; a dashed line marks the base load.
 *   bottom panel  battery charge (%): the hour's average with its low-high
 *                 band, then the projection for the rest of today (dotted).
 *
 * The two panels share the hour axis. Battery % gets its own panel rather
 * than a second y-axis on the energy chart, so neither scale can be misread.
 *
 * Data: /api/energy/hourly?date=YYYY-MM-DD&forecast=1 (see modules/energyHourly.js
 * and modules/energyForecast.js). The card fetches its own data and refreshes
 * every 5 minutes while it shows today.
 *
 * @module components/energyDay
 */
import { escapeHtml } from '../utils.js';
import { ensureChartJS } from '../chartLoader.js';

const REFRESH_MS = 5 * 60 * 1000;
const AXIS_WIDTH = 44;   // both panels' y-axes, so their hours line up
const MAX_DAYS_AHEAD = 1;

function localDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function shiftDate(date, days) { const [y, m, d] = date.split('-').map(Number); return localDate(new Date(y, m - 1, d + days, 12)); }
function dayLabel(date) {
  const today = localDate(new Date());
  if (date === today) return 'Today';
  if (date === shiftDate(today, -1)) return 'Yesterday';
  if (date === shiftDate(today, 1)) return 'Tomorrow';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}
const kwh = v => (v == null || !Number.isFinite(v) ? '—' : `${v < 10 ? v.toFixed(2) : v.toFixed(1)} kWh`);

function tokens() {
  const s = getComputedStyle(document.documentElement), v = (n, f) => s.getPropertyValue(n).trim() || f;
  return {
    home: v('--color-home', '#333333'), solar: v('--color-solar', '#f59e0b'), battery: v('--color-battery', '#4a6a2e'),
    text: v('--text-secondary', '#64748b'), grid: document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)',
    now: document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)'
  };
}
function alpha(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex); if (!m) return hex;
  const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
/** Diagonal stripes in `color`: the forecast texture. */
function hatch(color) {
  const c = document.createElement('canvas'); c.width = c.height = 8;
  const x = c.getContext('2d');
  x.fillStyle = alpha(color, 0.12); x.fillRect(0, 0, 8, 8);
  x.strokeStyle = alpha(color, 0.85); x.lineWidth = 1.5;
  x.beginPath(); x.moveTo(-2, 10); x.lineTo(10, -2); x.moveTo(-2, 2); x.lineTo(2, -2); x.moveTo(6, 10); x.lineTo(10, 6); x.stroke();
  return x.createPattern(c, 'repeat');
}

/** Grey band behind the current hour; `label` adds a "Now" tag above it. */
function nowBand(getIndex, label) {
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

export function buildEnergyDay(block = {}) {
  const config = block.config || {};
  const card = document.createElement('div');
  card.className = 'energy-day-card';
  card.dataset.blockId = block.id || '';
  card.innerHTML = `
    <div class="ed-header">
      <h3 class="ed-title">${escapeHtml(config.title || 'Energy')}</h3>
      <div class="ed-controls">
        <button type="button" class="ed-btn ed-toggle-forecast" aria-pressed="false">Hide forecast</button>
        <div class="ed-daynav" role="group" aria-label="Day">
          <button type="button" class="ed-btn ed-prev" aria-label="Previous day">‹</button>
          <span class="ed-day" aria-live="polite">Today</span>
          <button type="button" class="ed-btn ed-next" aria-label="Next day">›</button>
        </div>
      </div>
    </div>
    <div class="ed-panels">
      <div class="ed-panel ed-energy"><canvas aria-label="Energy per hour"></canvas></div>
      <div class="ed-panel ed-battery"><canvas aria-label="Battery charge per hour"></canvas></div>
    </div>
    <div class="ed-legend"></div>
    <p class="ed-status" role="status"></p>`;
  const state = { date: localDate(new Date()), hideForecast: config.showForecast === false, showBattery: config.showBattery !== false, data: null, charts: {}, timer: null };
  card._energyDay = state;
  if (!state.showBattery) card.querySelector('.ed-battery').hidden = true;

  card.querySelector('.ed-prev').addEventListener('click', () => { state.date = shiftDate(state.date, -1); load(card); });
  card.querySelector('.ed-next').addEventListener('click', () => { state.date = shiftDate(state.date, 1); load(card); });
  card.querySelector('.ed-toggle-forecast').addEventListener('click', () => { state.hideForecast = !state.hideForecast; render(card); });

  requestAnimationFrame(() => load(card));
  state.timer = setInterval(() => {
    if (!card.isConnected) { clearInterval(state.timer); return; }
    if (state.date === localDate(new Date())) load(card, true);
  }, REFRESH_MS);
  const themeWatch = new MutationObserver(() => { if (!card.isConnected) themeWatch.disconnect(); else if (state.data) render(card); });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return card;
}

async function load(card, quiet) {
  const state = card._energyDay, today = localDate(new Date()), date = state.date;
  card.querySelector('.ed-day').textContent = dayLabel(date);
  card.querySelector('.ed-next').disabled = date >= shiftDate(today, MAX_DAYS_AHEAD);
  const status = card.querySelector('.ed-status');
  if (!quiet) status.textContent = 'Loading…';
  try {
    const wantForecast = date >= today;
    const res = await fetch(`/api/energy/hourly?date=${date}${wantForecast ? '&forecast=1' : ''}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (state.date !== date) return;   // the person moved on to another day meanwhile
    state.data = data;
    await ensureChartJS();
    render(card);
  } catch (err) {
    if (state.date !== date) return;
    status.textContent = 'Energy data is unavailable right now.';
    console.warn('[energy-day] load failed:', err);
  }
}

function render(card) {
  const state = card._energyDay, data = state.data;
  if (!data || typeof Chart === 'undefined') return;
  const t = tokens(), hours = data.hours, f = data.forecast || null;
  const showForecast = !!f && !state.hideForecast;
  const labels = hours.map(h => String(new Date(h.start * 1000).getHours()).padStart(2, '0'));
  const nowIndex = hours.findIndex(h => h.status === 'current');
  const hourTitle = items => (items.length ? `${labels[items[0].dataIndex]}:00–${String((Number(labels[items[0].dataIndex]) + 1) % 24).padStart(2, '0')}:00` : '');
  const toggle = card.querySelector('.ed-toggle-forecast');
  toggle.hidden = !f; toggle.textContent = state.hideForecast ? 'Show forecast' : 'Hide forecast'; toggle.setAttribute('aria-pressed', String(state.hideForecast));

  // Per hour: actual for hours that have started, forecast for hours to come.
  const value = (h, i, key) => {
    if (h.status !== 'future') return { v: h.energy[key], forecast: false };
    const fc = showForecast && f.hours[i] && f.hours[i][key === 'consumption' ? 'consumption' : 'solar'];
    return fc ? { v: fc.expected, forecast: true, low: fc.low, high: fc.high } : { v: null, forecast: false };
  };
  const series = ['consumption', 'solar'].map(key => hours.map((h, i) => value(h, i, key)));
  const colors = { consumption: t.home, solar: t.solar };
  const hatches = { consumption: hatch(t.home), solar: hatch(t.solar) };
  const anyEnergy = series.some(s => s.some(p => p.v > 0));
  const baseLoad = showForecast && f.hours[0] ? f.hours[0].baseLoad : null;

  const yAxis = (extra) => ({ grid: { color: t.grid }, border: { display: false }, ticks: { color: t.text, font: { size: 10 }, maxTicksLimit: 5, ...extra.ticks }, afterFit: s => { s.width = AXIS_WIDTH; }, ...extra.scale });
  // offset: hours sit in the middle of their slot on both panels, as bars do.
  const xAxis = (show) => ({ offset: true, grid: { display: false }, ticks: { display: show, color: t.text, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 6 } });
  const batteryShown = state.showBattery && hours.some(h => h.soc);

  const energyDatasets = ['consumption', 'solar'].map((key, k) => ({
    type: 'bar', label: key === 'consumption' ? 'Consumption' : 'Solar', key,
    data: series[k].map(p => p.v),
    backgroundColor: series[k].map(p => (p.forecast ? hatches[key] : colors[key])),
    borderColor: series[k].map(p => (p.forecast ? alpha(colors[key], 0.9) : colors[key])),
    borderWidth: series[k].map(p => (p.forecast ? 1 : 0)),
    borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom',
    categoryPercentage: 0.78, barPercentage: 0.9, order: 2
  }));
  if (baseLoad != null) energyDatasets.push({ type: 'line', label: 'Base load', key: 'base', data: hours.map(() => baseLoad), borderColor: alpha(t.home, 0.55), borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0, fill: false, order: 1 });

  drawChart(card, 'energy', {
    type: 'bar',
    data: { labels, datasets: energyDatasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      layout: { padding: { top: 14 } },
      interaction: { mode: 'index', intersect: false },
      scales: { x: xAxis(!batteryShown), y: yAxis({ scale: { beginAtZero: true, title: { display: true, text: 'kWh', color: t.text, font: { size: 10 } } }, ticks: {} }) },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: item => item.raw != null && item.dataset.key !== 'base',
          callbacks: {
            title: hourTitle,
            label: item => {
              const p = series[item.datasetIndex]?.[item.dataIndex];
              if (!p) return '';
              return p.forecast ? `${item.dataset.label} forecast: ${kwh(p.v)} (likely ${kwh(p.low)}–${kwh(p.high)})` : `${item.dataset.label}: ${kwh(p.v)}`;
            },
            footer: () => (baseLoad != null ? `Base load ${kwh(baseLoad)} per hour` : '')
          }
        }
      }
    },
    plugins: [nowBand(() => nowIndex, true)]
  });

  // Battery panel.
  const batteryEl = card.querySelector('.ed-battery');
  batteryEl.hidden = !batteryShown;
  if (batteryShown) {
    const proj = showForecast && f.battery ? f.battery : null;
    const projected = hours.map(() => null);
    if (proj && nowIndex >= 0) {
      projected[nowIndex] = proj.from;
      proj.hours.forEach(p => { const i = hours.findIndex(h => h.start === p.start); if (i >= 0 && i + 1 < hours.length) projected[i + 1] = p.soc; });
    }
    const lowest = proj ? proj.minSoc : null;
    const batteryDatasets = [
      { label: 'Low', data: hours.map(h => h.soc ? h.soc.min : null), borderWidth: 0, pointRadius: 0, fill: false, spanGaps: false },
      { label: 'High', data: hours.map(h => h.soc ? h.soc.max : null), borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: alpha(t.battery, 0.18), spanGaps: false },
      { label: 'Battery', data: hours.map(h => h.soc ? h.soc.avg : null), borderColor: t.battery, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.3, fill: false },
      { label: 'Projected', data: projected, borderColor: t.battery, borderDash: [2, 3], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.3, fill: false, spanGaps: true }
    ];
    if (lowest) batteryDatasets.push({ label: 'Lowest charge', data: hours.map(() => lowest), borderColor: alpha(t.text, 0.6), borderDash: [4, 4], borderWidth: 1, pointRadius: 0, pointHitRadius: 0, fill: false });
    drawChart(card, 'battery', {
      type: 'line',
      data: { labels, datasets: batteryDatasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: { x: xAxis(true), y: yAxis({ scale: { min: 0, max: 100 }, ticks: { stepSize: 50, callback: v => `${v}%` } }) },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: item => item.raw != null && (item.dataset.label === 'Battery' || item.dataset.label === 'Projected'),
            callbacks: {
              title: hourTitle,
              label: item => {
                const h = hours[item.dataIndex];
                if (item.dataset.label === 'Projected') return `Projected: ${Math.round(item.raw)}%`;
                return h.soc ? `Battery: ${Math.round(h.soc.avg)}% (low ${Math.round(h.soc.min)}%, high ${Math.round(h.soc.max)}%)` : '';
              }
            }
          }
        }
      },
      plugins: [nowBand(() => nowIndex, false)]
    });
  } else destroyChart(card, 'battery');

  // Legend: identity never by colour alone (solid vs hatched swatches, named).
  const legend = [
    ['solid', t.home, 'Consumption'], ['solid', t.solar, 'Solar'],
    ...(series[0].some(p => p.forecast) ? [['hatch', t.home, 'Consumption forecast']] : []),
    ...(series[1].some(p => p.forecast) ? [['hatch', t.solar, 'Solar forecast']] : []),
    ...(baseLoad != null ? [['dash', t.home, 'Base load']] : []),
    ...(batteryShown ? [['line', t.battery, 'Battery'], ...(showForecast && f.battery && f.battery.hours.length ? [['dots', t.battery, 'Projected']] : [])] : [])
  ];
  card.querySelector('.ed-legend').innerHTML = legend.map(([kind, color, name]) => `<span class="ed-key"><span class="ed-swatch ed-swatch-${kind}" style="--c:${color}"></span>${escapeHtml(name)}</span>`).join('');

  const status = card.querySelector('.ed-status');
  const noForecastYet = f && f.historyDays < 3 ? 'The consumption forecast starts after 3 days of history.' : '';
  status.textContent = !anyEnergy && !hours.some(h => h.soc) ? 'No energy recorded for this day.' : noForecastYet;
}

function drawChart(card, which, cfg) {
  // Rebuilt on each render (at most every few minutes): the Now band and the
  // colours are baked into the chart's plugins and patterns.
  destroyChart(card, which);
  const canvas = card.querySelector(`.ed-${which} canvas`);
  card._energyDay.charts[which] = new Chart(canvas.getContext('2d'), cfg);
}
function destroyChart(card, which) {
  const c = card._energyDay.charts[which];
  if (c) { c.destroy(); delete card._energyDay.charts[which]; }
}
