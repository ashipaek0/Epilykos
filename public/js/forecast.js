/**
 * Solar forecast cards — data + rendering for forecast banner, info and
 * sparkline cards (PV Today renders itself from the same payload).
 *
 * One /api/solar-forecast fetch per distinct card source; every card renders
 * into its own elements (class-scoped, no page-global ids), so any number of
 * instances coexist. Missing data renders as '--' — never throws.
 *
 * @module forecast
 */
import { updatePvToday } from './components/pvToday.js';
import { ensureChartJS } from './chartLoader.js';
import { escapeHtml } from './utils.js';
import { fmtTemp, fmtKwh, fmtNum, dayLabel, localDate, iconHtml } from './weatherFormat.js';

const charts = new Set();
export function clearSparklineCharts() {
  charts.forEach(c => { try { c.destroy(); } catch { /* already gone */ } });
  charts.clear();
}

const SOURCE_LABELS = { solcast: 'Solcast', 'open-meteo': 'Open-Meteo', auto: 'Auto' };
// In-memory last-good timestamp per source (AC8). Never persisted.
const lastGoodBySource = {};

/** Effective display label: server source_label wins, else local map. */
export function sourceLabelFor(data, fallbackSource) {
  if (data && data.source_label) return data.source_label;
  const key = (data && data.source) || fallbackSource || 'auto';
  return SOURCE_LABELS[key] || key || '';
}

/** Block config.rest_map: object or JSON string; {} on malformed. */
function normalizeRestMap(raw) {
  let m = raw;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = {}; } }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
  return m;
}

/** A card's block config from the active dashboard (read-only). */
async function blockConfigFor(card) {
  const blockId = card?.dataset?.blockId;
  if (!blockId) return {};
  try {
    const { dashboardConfig } = await import('./dashboard.js');
    const layout = dashboardConfig?.dashboards?.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
    return (layout || []).find(b => String(b.id) === String(blockId))?.config || {};
  } catch { return {}; }
}

function forecastUrlFor(source, restMap) {
  if (!source || source === 'auto') return '/api/solar-forecast';
  let url = `/api/solar-forecast?source=${encodeURIComponent(source)}`;
  // S5-front-A: per-card rest_map for rest: sources only.
  if (source.startsWith('rest:')) url += `&rest_map=${encodeURIComponent(JSON.stringify(restMap || {}))}`;
  return url;
}

/** Per-card inline error (AC8). Never hides the card itself. */
function setCardError(card, message) {
  const err = card.querySelector('.fc-error');
  if (!err) return;
  err.textContent = message || '';
  err.hidden = !message;
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const periodEndMs = (h) => new Date(h.period_end).getTime();
/** kWh in one forecast period (backend sets energy_kwh; older payloads: 1-h kW). */
const periodKwh = (h) => num(h.energy_kwh) ?? (num(h.pv_estimate) || 0);

/** Today's production figures from one payload. */
function todayFigures(data) {
  const today = localDate();
  const day = (data.daily || []).find(d => d.date === today) || null;
  const nowMs = Date.now();
  const hourly = (data.hourly || []).filter(h => localDate(new Date(h.period_end)) === today);
  const remaining = hourly.length ? hourly.filter(h => periodEndMs(h) > nowMs).reduce((s, h) => s + periodKwh(h), 0) : null;
  const total = day ? num(day.total_kwh) : null;
  const actual = day ? num(day.actual_so_far) : null;
  return { total, actual, remaining };
}

/** Weather row for a date: today → weather.today, later → forecast_weather. */
function weatherForDate(w, date) {
  if (!w) return null;
  if (w.today && w.today.date === date) return w.today;
  return (w.forecast_weather || []).find(d => d.date === date) || null;
}

function renderSummary(card, data, cfg) {
  const q = (s) => card.querySelector(s);
  const w = data.weather || null;
  const { total, actual, remaining } = todayFigures(data);
  // REST weather sources carry no PV forecast: hide the kWh sections entirely.
  const hasProduction = total != null || remaining != null || (data.daily || []).some(d => num(d.total_kwh) != null);
  const todayEl = q('.fc-today');
  if (todayEl) todayEl.hidden = !hasProduction;

  // Today: remaining forecast energy, with produced / expected context
  const valueEl = q('.fc-today-value');
  if (valueEl) valueEl.textContent = remaining != null ? fmtKwh(remaining) : fmtKwh(total);
  const sub = [];
  if (remaining != null) sub.push('remaining');
  if (actual != null && actual > 0) sub.push(`${fmtNum(actual, 1)} produced`);
  if (total != null) sub.push(`${fmtNum(total, 1)} expected`);
  const subEl = q('.fc-today-sub');
  if (subEl) subEl.textContent = sub.join(' · ');
  const prog = q('.fc-progress');
  if (prog) {
    const denom = (actual || 0) + (remaining || 0);
    prog.hidden = !(actual != null && actual > 0 && denom > 0);
    if (!prog.hidden) prog.firstElementChild.style.width = `${Math.min(100, (actual / denom) * 100)}%`;
  }

  // Current weather
  const now = q('.fc-now');
  if (now) {
    const hasWx = w && w.available !== false && (w.temp != null || w.desc);
    now.hidden = !hasWx;
    if (hasWx) {
      q('.fc-now-icon').innerHTML = iconHtml(w.icon_class, w.code, w.is_day);
      q('.fc-now-temp').textContent = fmtTemp(w.temp);
      q('.fc-now-desc').textContent = w.desc || '';
      const extra = [];
      if (w.today && (w.today.temp_max != null || w.today.temp_min != null)) extra.push(`H ${fmtTemp(w.today.temp_max)} · L ${fmtTemp(w.today.temp_min)}`);
      if (w.humidity != null) extra.push(`${fmtNum(w.humidity, 0, '%')} RH`);
      if (w.precip_probability != null && w.precip_probability > 0) extra.push(`Rain ${fmtNum(w.precip_probability, 0, '%')}`);
      q('.fc-now-extra').textContent = extra.join(' · ');
    }
  }

  // Next days: production + that day's weather
  const daysEl = q('.fc-days');
  if (daysEl) {
    const today = localDate();
    const maxDays = Math.max(1, Math.min(6, parseInt(cfg.days, 10) || 3));
    const days = hasProduction ? (data.daily || []).filter(d => d.date > today).slice(0, maxDays) : [];
    daysEl.innerHTML = days.map(d => {
      const dw = weatherForDate(w, d.date);
      const hilo = dw && (dw.temp_max != null || dw.temp_min != null)
        ? `<span class="fc-day-temp">${fmtTemp(dw.temp_max ?? dw.temp)}<small>${dw.temp_min != null ? ' / ' + fmtTemp(dw.temp_min) : ''}</small></span>` : '';
      const rain = dw && dw.precip_probability != null && dw.precip_probability > 0
        ? `<span class="fc-day-rain">${fmtNum(dw.precip_probability, 0, '%')}</span>` : '';
      return `
        <div class="fc-day" title="${escapeHtml(dw?.desc || '')}">
          <span class="fc-day-name">${escapeHtml(dayLabel(d.date, 'short'))}</span>
          ${dw ? iconHtml(dw.icon_class, dw.code, true, 'fc-day-icon') : ''}
          <span class="fc-day-kwh">${fmtKwh(d.total_kwh)}</span>
          <span class="fc-day-wx">${hilo}${rain}</span>
        </div>`;
    }).join('');
    daysEl.hidden = !days.length;
  }
}

/** Chart window: sunrise−1 h … sunset+1 h when known, else 06:00–20:00. */
function chartWindow(w) {
  const base = new Date(); base.setHours(0, 0, 0, 0);
  const at = (h) => base.getTime() + h * 3600000;
  const rise = w && w.sunrise ? new Date(w.sunrise) : null;
  const set = w && w.sunset ? new Date(w.sunset) : null;
  const ok = rise && set && !isNaN(rise) && !isNaN(set) && localDate(rise) === localDate();
  const start = ok ? at(Math.max(0, rise.getHours() - 1)) : at(6);
  const end = ok ? at(Math.min(24, set.getHours() + 2)) : at(20);
  return { start, end };
}

async function renderChart(card, data, historyData) {
  const wrap = card.querySelector('.fc-chart');
  if (!wrap) return;
  const canvas = wrap.querySelector('canvas');
  const empty = wrap.querySelector('.fc-chart-empty');
  try { await ensureChartJS(); } catch { if (empty) { empty.textContent = 'Chart library unavailable'; empty.hidden = false; } return; }

  const { start, end } = chartWindow(data.weather);
  const today = localDate();
  const inWin = (x) => x >= start && x <= end;
  const periods = (data.hourly || []).filter(h => localDate(new Date(h.period_end)) === today);
  const forecast = periods.map(h => ({ x: periodEndMs(h), y: num(h.pv_estimate) ?? 0 })).filter(p => inWin(p.x)).sort((a, b) => a.x - b.x);
  const band = periods.filter(h => num(h.pv_estimate10) != null && num(h.pv_estimate90) != null)
    .map(h => ({ x: periodEndMs(h), lo: num(h.pv_estimate10), hi: num(h.pv_estimate90) })).filter(p => inWin(p.x)).sort((a, b) => a.x - b.x);

  let actualField = 'solar_kw';
  try { const mm = JSON.parse(card.dataset.metricMap || '{}'); if (mm.actual_energy) actualField = mm.actual_energy; } catch { /* default */ }
  const actual = computeActualCurve((historyData || []).filter(d => inWin(new Date(d.timestamp).getTime())), actualField, start, end);

  if (empty) empty.hidden = forecast.length > 0 || actual.length > 0;
  const styles = getComputedStyle(document.documentElement);
  const muted = styles.getPropertyValue('--text-secondary').trim() || '#64748b';
  const grid = document.documentElement.getAttribute('data-theme') === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const capacity = num(window.systemCapacityKwp);

  const datasets = [];
  if (band.length) {
    datasets.push(
      { label: 'P10', data: band.map(p => ({ x: p.x, y: p.lo })), borderWidth: 0, pointRadius: 0, fill: false, tension: 0.4 },
      { label: 'P10–P90', data: band.map(p => ({ x: p.x, y: p.hi })), borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: 'rgba(217,119,6,0.12)', tension: 0.4 }
    );
  }
  datasets.push(
    { label: 'Forecast', data: forecast, borderColor: '#d97706', borderDash: [5, 4], borderWidth: 2, pointRadius: 0, fill: false, tension: 0.4 },
    { label: 'Actual', data: actual, borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.22)', borderWidth: 2, pointRadius: 0, fill: 'origin', tension: 0.4 }
  );

  const options = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { intersect: false, mode: 'index' },
    scales: {
      x: { type: 'time', min: start, max: end, time: { unit: 'hour', displayFormats: { hour: 'HH' } }, grid: { display: false }, ticks: { color: muted, maxTicksLimit: 8, font: { size: 10 } } },
      y: { beginAtZero: true, suggestedMax: capacity || undefined, grid: { color: grid }, ticks: { color: muted, maxTicksLimit: 4, font: { size: 10 }, callback: v => `${v} kW` } }
    },
    plugins: {
      legend: { display: true, labels: { color: muted, boxWidth: 12, font: { size: 10 }, filter: i => i.text !== 'P10' } },
      tooltip: {
        filter: i => i.dataset.label !== 'P10',
        callbacks: { label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toFixed(2)} kW` }
      }
    }
  };

  if (card._fcChart && card._fcChart.canvas !== canvas) { charts.delete(card._fcChart); try { card._fcChart.destroy(); } catch { /* gone */ } card._fcChart = null; }
  if (card._fcChart) {
    card._fcChart.data.datasets = datasets;
    card._fcChart.options = options;
    card._fcChart.update('none');
  } else {
    card._fcChart = new Chart(canvas.getContext('2d'), { type: 'line', data: { datasets }, options });
    charts.add(card._fcChart);
  }
}

/** Date + live clock in the card header (one timer per card, self-cleaning). */
function startClock(card) {
  const dateEl = card.querySelector('.fc-date');
  const clockEl = card.querySelector('.fc-clock');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (!clockEl || card._fcClock) return;
  const tick = () => {
    if (!card.isConnected) { clearInterval(card._fcClock); card._fcClock = null; return; }
    clockEl.textContent = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };
  tick();
  card._fcClock = setInterval(tick, 15000);
}

export async function updateForecast() {
  const cards = [...document.querySelectorAll('.forecast-banner-instance, .forecast-info-instance, .forecast-sparkline-instance')];
  const pvCards = [...document.querySelectorAll('.pv-today-instance')];
  if (!cards.length && !pvCards.length) return;

  // Group instances by source (+rest_map) so each distinct source is fetched once.
  const all = [...cards.map(el => ({ el, pv: false })), ...pvCards.map(el => ({ el, pv: true }))];
  const configs = await Promise.all(all.map(a => blockConfigFor(a.el)));
  const groups = new Map();
  all.forEach((a, i) => {
    const cfg = configs[i] || {};
    const src = a.el.dataset.source || cfg.source || 'auto';
    const restMap = normalizeRestMap(cfg.rest_map);
    const key = src.startsWith('rest:') ? JSON.stringify([src, restMap]) : src;
    if (!groups.has(key)) groups.set(key, { src, restMap, cards: [], pvs: [] });
    const g = groups.get(key);
    (a.pv ? g.pvs : g.cards).push({ el: a.el, cfg });
  });

  const entries = [...groups.values()];
  const results = await Promise.all(entries.map(async (g) => {
    try { return await (await fetch(forecastUrlFor(g.src, g.restMap))).json(); }
    catch { return { error: true, source: g.src }; }
  }));
  let historyData = null;
  if (cards.some(c => c.querySelector('.fc-chart'))) {
    try { historyData = await (await fetch('/api/history?days=1')).json(); } catch { historyData = []; }
  }

  for (let i = 0; i < entries.length; i++) {
    const g = entries[i];
    const data = results[i];
    const label = sourceLabelFor(data, g.src);
    const failed = !data || data.error || !Array.isArray(data.daily);

    for (const { el: card, cfg } of g.cards) {
      const srcEl = card.querySelector('.fc-source');
      if (srcEl) srcEl.textContent = [label, data?.weather?.stale ? 'weather stale' : ''].filter(Boolean).join(' · ');
      startClock(card);
      // Until a card has rendered once, a failure shows only the message.
      card.classList.toggle('fc-failed', !!failed && !card._fcRendered);
      if (failed) {
        const lastGood = lastGoodBySource[g.src];
        setCardError(card, `Source ${label || g.src} unavailable${lastGood ? ` — last good ${lastGood}` : ''}${data && typeof data.error === 'string' ? ` (${data.error})` : ''}`);
        continue;
      }
      setCardError(card, '');
      try {
        if (card.querySelector('.fc-today')) renderSummary(card, data, cfg);
        if (card.querySelector('.fc-chart')) await renderChart(card, data, historyData);
        card._fcRendered = true;
      } catch (e) {
        console.error('Forecast card render error:', e);
        setCardError(card, `Could not render forecast from ${label || g.src}`);
      }
    }
    if (!failed) lastGoodBySource[g.src] = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

    if (g.pvs.length) {
      const pvEls = g.pvs.map(p => p.el);
      if (failed) updatePvToday({ error: true, source: g.src, source_label: label }, pvEls, lastGoodBySource[g.src] || '');
      else updatePvToday(data, pvEls);
    }
  }
}

/**
 * Actual PV curve (kW) in 30-min buckets across the chart window, from
 * /api/history rows: instantaneous kW when present, else derived from the
 * daily_solar kWh counter.
 */
function computeActualCurve(points, actualField, start, end) {
  const nowMs = Date.now();
  const intervals = [];
  for (let t = start; t <= Math.min(end, nowMs); t += 1800000) intervals.push(t);
  const hasInstant = points.some(d => (d[actualField] || 0) > 0);
  if (hasInstant) {
    const bins = {};
    for (const p of points) {
      const bt = Math.floor(new Date(p.timestamp).getTime() / 1800000) * 1800000;
      (bins[bt] = bins[bt] || []).push(Number(p[actualField]) || 0);
    }
    return intervals.map(ts => {
      const vals = bins[ts];
      return vals && vals.length ? { x: ts + 900000, y: vals.reduce((a, b) => a + b, 0) / vals.length } : null;
    }).filter(Boolean);
  }
  const counter = points.filter(d => d.daily_solar != null)
    .map(d => ({ t: new Date(d.timestamp).getTime(), kwh: Number(d.daily_solar) }))
    .sort((a, b) => a.t - b.t);
  if (counter.length && counter[0].kwh > 0) counter.unshift({ t: start, kwh: 0 });
  if (counter.length < 2) return [];
  return intervals.map(ts => {
    const mid = ts + 900000;
    let prev = null;
    for (let i = counter.length - 1; i >= 0; i--) if (counter[i].t <= mid) { prev = counter[i]; break; }
    const next = counter.find(c => c.t > mid);
    if (!prev || !next || next.t <= prev.t) return null;
    return { x: mid, y: Math.max(0, (next.kwh - prev.kwh) / ((next.t - prev.t) / 3600000)) };
  }).filter(Boolean);
}
