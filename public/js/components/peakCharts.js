/**
 * Daily peak and Histogram cards.
 *
 *   Daily peak   a bar for each day: the highest solar power of that day (or the highest value of any
 *                metric, e.g. a "Highest today" combined metric). Days with no readings are gaps.
 *   Histogram    bars for bands of power. "Daily peaks" counts days by their peak; "Time at each power
 *                level" (solar) adds up the hours spent in each band, night left out.
 *
 * Solar power comes from the stored readings, so every day on record has a peak without any setup.
 * Data: /api/peaks and /api/histogram (modules/peaks.js). Each card fetches its own data and refreshes
 * every 10 minutes while it is on the page.
 *
 * @module components/peakCharts
 */
import { escapeHtml } from '../utils.js';
import { ensureChartJS } from '../chartLoader.js';
import { tokens, alpha } from './energyChartKit.js';

const REFRESH_MS = 10 * 60 * 1000;
const RANGES = [[30, '30 days'], [90, '90 days'], [365, '1 year']];

/** The card's settings with defaults; solar is shown in kW, a metric in its own unit. */
export function peakSettings(config = {}) {
  const metric = String(config.metric || '').trim();
  const source = config.source === 'metric' && metric ? 'metric' : 'solar';
  const scale = source === 'solar' ? 0.001 : (Number.isFinite(parseFloat(config.scale)) && parseFloat(config.scale) !== 0 ? parseFloat(config.scale) : 1);
  const unit = source === 'solar' ? 'kW' : String(config.unit || '').trim().slice(0, 12);
  const days = RANGES.some(r => r[0] === Number(config.days)) ? Number(config.days) : 30;
  const bins = Math.min(30, Math.max(4, parseInt(config.bins, 10) || 10));
  const color = /^#[0-9a-f]{6}$/i.test(config.color || '') ? config.color : '';
  return { source, metric, scale, unit, days, bins, color, mode: config.mode === 'time' && source === 'solar' ? 'time' : 'peaks', includeNight: config.includeNight === true };
}

const num = v => (v == null || !Number.isFinite(v) ? '—' : Math.abs(v) < 10 ? v.toFixed(2) : Math.abs(v) < 100 ? v.toFixed(1) : String(Math.round(v)));
const withUnit = (v, unit) => num(v) + (unit ? ' ' + unit : '');
const dayText = day => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, 12).toLocaleDateString([], { day: 'numeric', month: 'short' }); };
const dayLong = day => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, 12).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); };

function shell(card, title, controlsHtml, label) {
  card.innerHTML = `
    <div class="ed-header">
      <h3 class="ed-title">${escapeHtml(title)}</h3>
      <div class="ed-controls">${controlsHtml}</div>
    </div>
    <div class="ed-panels"><div class="ed-panel pk-panel"><canvas aria-label="${escapeHtml(label)}"></canvas></div></div>
    <p class="ed-status" role="status"></p>`;
}
const rangeButtons = days => `<div class="pk-ranges" role="group" aria-label="Days shown">${RANGES.map(([n, text]) => `<button type="button" class="ed-btn pk-range" data-days="${n}" aria-pressed="${n === days}">${text}</button>`).join('')}</div>`;

function baseOptions(yTitle, xTitle) {
  const t = tokens();
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
    scales: {
      x: { title: { display: !!xTitle, text: xTitle || '', color: t.text }, grid: { display: false }, ticks: { color: t.text, maxRotation: 0, autoSkipPadding: 10 } },
      y: { beginAtZero: true, title: { display: true, text: yTitle, color: t.text }, grid: { color: t.grid }, ticks: { color: t.text }, grace: '5%' }
    },
    plugins: { legend: { display: false } }
  };
}

function setStatus(card, text, empty) {
  card.querySelector('.ed-status').textContent = text || '';
  const panel = card.querySelector('.pk-panel');
  if (panel) panel.style.visibility = empty ? 'hidden' : '';
}

async function getJson(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Wire the refresh timer, the theme watcher and the range buttons for a card. */
function run(card, state, load, draw) {
  card.querySelectorAll('.pk-range').forEach(b => b.addEventListener('click', () => {
    state.settings.days = Number(b.dataset.days);
    card.querySelectorAll('.pk-range').forEach(o => o.setAttribute('aria-pressed', String(o === b)));
    load(card, false);
  }));
  requestAnimationFrame(() => load(card, false));
  state.timer = setInterval(() => { if (!card.isConnected) { clearInterval(state.timer); if (state.chart) state.chart.destroy(); return; } load(card, true); }, REFRESH_MS);
  const themeWatch = new MutationObserver(() => { if (!card.isConnected) themeWatch.disconnect(); else if (state.data) draw(card); });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

function chartOn(card, state, type, data, options) {
  if (state.chart) state.chart.destroy();
  state.chart = new Chart(card.querySelector('canvas').getContext('2d'), { type, data, options });
}

// ── Daily peak ───────────────────────────────────────────────────────────
export function buildPeakBars(block = {}) {
  const config = block.config || {};
  const settings = peakSettings(config);
  const card = document.createElement('div');
  card.className = 'energy-day-card pk-card pk-bars-card';
  card.dataset.blockId = block.id || '';
  shell(card, config.title || (settings.source === 'solar' ? 'Daily peak solar power' : `Daily highest: ${settings.metric}`), rangeButtons(settings.days), 'Highest value of each day');
  const state = { settings, data: null, chart: null, timer: null };
  card._peakBars = state;
  run(card, state, loadBars, drawBars);
  return card;
}

async function loadBars(card, quiet) {
  const state = card._peakBars, s = state.settings, days = s.days;
  if (!quiet) setStatus(card, 'Loading…');
  try {
    await ensureChartJS();
    const url = `/api/peaks?days=${days}` + (s.source === 'metric' ? `&source=metric&metric=${encodeURIComponent(s.metric)}` : '');
    const data = await getJson(url);
    if (state.settings.days !== days) return;   // another range was chosen meanwhile
    state.data = data;
    drawBars(card);
  } catch (err) {
    setStatus(card, 'Could not load: ' + err.message, true);
  }
}

function drawBars(card) {
  const state = card._peakBars, s = state.settings, data = state.data;
  if (!data) return;
  if (!data.daysWithData) { setStatus(card, s.source === 'solar' ? 'No solar power readings in this period yet.' : `No readings of ${s.metric} in this period yet.`, true); return; }
  const t = tokens(), color = s.color || t.solar, scaled = data.days.map(d => (d.value === null ? null : d.value * s.scale));
  const unitText = s.unit ? ` (${s.unit})` : '';
  const options = baseOptions((s.source === 'solar' ? 'Peak power' : 'Highest value') + unitText);
  options.scales.x.ticks.callback = function (v) { return dayText(this.getLabelForValue(v)); };
  options.plugins.tooltip = { callbacks: { title: items => dayLong(items[0].label), label: ctx => withUnit(ctx.parsed.y, s.unit) } };
  chartOn(card, state, 'bar', { labels: data.days.map(d => d.day), datasets: [{ data: scaled, backgroundColor: alpha(color, 0.85), borderRadius: 3, maxBarThickness: 26 }] }, options);
  const best = data.highest;
  setStatus(card, `Highest ${withUnit(best.value * s.scale, s.unit)} on ${dayText(best.day)} · typical ${withUnit(data.median * s.scale, s.unit)} (median) · ${data.daysWithData} of ${data.days.length} days with readings`);
}

// ── Histogram ────────────────────────────────────────────────────────────
export function buildPeakHistogram(block = {}) {
  const config = block.config || {};
  const settings = peakSettings(config);
  const card = document.createElement('div');
  card.className = 'energy-day-card pk-card pk-histogram-card';
  card.dataset.blockId = block.id || '';
  const modeButtons = settings.source === 'solar'
    ? `<div class="pk-modes" role="group" aria-label="What to count"><button type="button" class="ed-btn pk-mode" data-mode="peaks" aria-pressed="${settings.mode === 'peaks'}">Daily peaks</button><button type="button" class="ed-btn pk-mode" data-mode="time" aria-pressed="${settings.mode === 'time'}">Time at power</button></div>`
    : '';
  shell(card, config.title || (settings.source === 'solar' ? 'Solar power histogram' : `Histogram: ${settings.metric}`), modeButtons + rangeButtons(settings.days), 'Histogram');
  const state = { settings, data: null, chart: null, timer: null };
  card._peakHistogram = state;
  card.querySelectorAll('.pk-mode').forEach(b => b.addEventListener('click', () => {
    state.settings.mode = b.dataset.mode;
    card.querySelectorAll('.pk-mode').forEach(o => o.setAttribute('aria-pressed', String(o === b)));
    loadHistogram(card, false);
  }));
  run(card, state, loadHistogram, drawHistogram);
  return card;
}

async function loadHistogram(card, quiet) {
  const state = card._peakHistogram, s = state.settings, days = s.days, mode = s.mode;
  if (!quiet) setStatus(card, 'Loading…');
  try {
    await ensureChartJS();
    const url = `/api/histogram?days=${days}&mode=${mode}&bins=${s.bins}` + (s.source === 'metric' ? `&source=metric&metric=${encodeURIComponent(s.metric)}` : '') + (mode === 'time' && s.includeNight ? '&night=1' : '');
    const data = await getJson(url);
    if (state.settings.days !== days || state.settings.mode !== mode) return;
    state.data = data;
    drawHistogram(card);
  } catch (err) {
    setStatus(card, 'Could not load: ' + err.message, true);
  }
}

function drawHistogram(card) {
  const state = card._peakHistogram, s = state.settings, data = state.data;
  if (!data) return;
  const time = data.mode === 'time';
  if (!data.bins.length) { setStatus(card, s.source === 'solar' ? 'No solar power readings in this period yet.' : `No readings of ${s.metric} in this period yet.`, true); return; }
  const t = tokens(), color = s.color || t.solar;
  const edge = v => String(Number((v * s.scale).toFixed(3)));
  const labels = data.bins.map(b => `${edge(b.from)}–${edge(b.to)}`);
  const counts = data.bins.map(b => b.count);
  const countText = n => time ? `${n < 10 ? n.toFixed(1) : Math.round(n)} h` : `${n} day${n === 1 ? '' : 's'}`;
  const options = baseOptions(time ? 'Hours' : 'Days', (time ? 'Solar power' : (s.source === 'solar' ? 'Peak power' : 'Highest value')) + (s.unit ? ` (${s.unit})` : ''));
  options.scales.y.ticks.precision = time ? undefined : 0;
  if (data.bins.length <= 14) options.scales.x.ticks.autoSkip = false;
  options.plugins.tooltip = { callbacks: { title: items => `${items[0].label}${s.unit ? ' ' + s.unit : ''}`, label: ctx => countText(ctx.parsed.y) } };
  chartOn(card, state, 'bar', { labels, datasets: [{ data: counts, backgroundColor: alpha(color, 0.85), borderColor: alpha(color, 1), borderWidth: 1, barPercentage: 1, categoryPercentage: 1 }] }, options);
  const top = data.bins.reduce((b, x) => (x.count > b.count ? x : b), data.bins[0]);
  const range = `${edge(top.from)}–${edge(top.to)}${s.unit ? ' ' + s.unit : ''}`;
  setStatus(card, time
    ? `${countText(data.total)} of daylight readings (night, under ${data.nightBelowWatts} W, is left out) · most time at ${range}`
    : `${data.total} day${data.total === 1 ? '' : 's'} with readings · most common peak ${range}`);
  if (time && s.includeNight) setStatus(card, `${countText(data.total)} of readings, night included · most time at ${range}`);
}
