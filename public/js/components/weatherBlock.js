import { escapeHtml } from "../utils.js";
import { fmtTemp, fmtNum, fmtWind, uvLabel, timeLabel, hourLabel, dayLabel, iconHtml } from "../weatherFormat.js";
import { ensureChartJS } from "../chartLoader.js";

const SOURCE_LABELS = { solcast: 'Solcast', 'open-meteo': 'Open-Meteo', auto: 'Auto' };
// In-memory last-good timestamp per source. Never persisted.
const lastGoodBySource = {};

export function buildWeatherBlock(block = {}) {
  const config = block.config || {};
  const charts = normalizeCharts(config.charts);
  const container = document.createElement('div');
  container.className = 'weather-block wx-card';
  if (block.id != null) container.dataset.blockId = block.id;

  container.innerHTML = `
    <header class="wx-head">
      <h3 class="wx-title">${escapeHtml(config.title || 'Weather')}</h3>
      <span class="wx-meta"><span class="weather-source"></span><span class="weather-last-updated"></span></span>
    </header>
    <div class="weather-error wx-error" role="alert" hidden></div>
    <div class="weather-alerts wx-alerts" hidden></div>
    <div class="wx-body">
      <section class="wx-now">
        <div class="weather-icon wx-now-icon"><i class="fi fi-sr-cloud wx-ic" data-kind="unknown"></i></div>
        <div class="wx-now-main">
          <div class="weather-temp wx-now-temp">--°</div>
          <div class="weather-desc wx-now-desc"></div>
          <div class="wx-hilo"></div>
          <div class="weather-extra wx-extra"></div>
        </div>
      </section>
      <dl class="wx-details"></dl>
      <div class="weather-forecast wx-days"></div>
    </div>
    <div class="wx-hourly" hidden></div>
    <div class="weather-charts wx-charts">
      <div class="weather-chart-ghi wx-chart"${charts.ghi ? '' : ' hidden'}>
        <canvas class="weather-canvas"></canvas>
        <div class="weather-chart-caption" hidden>--</div>
      </div>
      <div class="weather-chart-temp wx-chart"${charts.temp ? '' : ' hidden'}>
        <canvas class="weather-canvas"></canvas>
        <div class="weather-chart-caption" hidden>--</div>
      </div>
    </div>
  `;
  return container;
}

/** Effective display label: server source_label wins, else local map. */
function sourceLabelFor(data, fallbackSource) {
  if (data && data.source_label) return data.source_label;
  const key = (data && data.source) || fallbackSource || 'auto';
  return SOURCE_LABELS[key] || key || '';
}

/**
 * Normalize a block config.rest_map: object or JSON string; {} on malformed.
 */
function normalizeRestMap(raw) {
  let m = raw;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = {}; } }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
  return m;
}

/**
 * Resolve a weather card instance's source + rest_map.
 * Mirrors forecast.js resolveCardSource: dataset.source first, then block id
 * lookup in dashboard.js dashboardConfig, else 'auto' (legacy behavior).
 * restMap is the block config.rest_map (normalized, {} default); only sent for rest: sources.
 */
async function resolveCardSource(card) {
  if (card?.dataset?.source) return { source: card.dataset.source, restMap: {} };
  const blockId = card?.dataset?.blockId
    || card?.closest?.('.dashboard-block')?.dataset?.blockId;
  if (!blockId) return { source: 'auto', restMap: {} };
  try {
    const { dashboardConfig } = await import('../dashboard.js');
    const layout = dashboardConfig?.dashboards?.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
    const block = (layout || []).find(b => String(b.id) === String(blockId));
    return { source: block?.config?.source || 'auto', restMap: normalizeRestMap(block?.config?.rest_map) };
  } catch { return { source: 'auto', restMap: {} }; }
}

function weatherUrlFor(source, restMap) {
  if (!source || source === 'auto') return '/api/solar-forecast';
  let url = `/api/solar-forecast?source=${encodeURIComponent(source)}`;
  // S5-front-A: thread per-card rest_map to the backend, rest: sources only.
  if (source.startsWith('rest:')) url += `&rest_map=${encodeURIComponent(JSON.stringify(restMap || {}))}`;
  return url;
}

/** Per-card inline error. Never hides the card itself. */
function setCardError(card, message) {
  const err = card.querySelector(':scope > .weather-error');
  if (!err) return;
  if (!message) { err.textContent = ''; err.hidden = true; return; }
  err.textContent = message;
  err.hidden = false;
}

/** Per-card display prefs. Absent keys = shown (the card shows everything the
 *  source provides unless a toggle is explicitly off); days 0–6 (default all 6).
 *  Alert rules live in config.alerts — see normalizeAlerts. */
const MAX_DAYS = 6;
function normalizeDisplay(raw) {
  let d = raw;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = {}; } }
  if (!d || typeof d !== 'object') d = {};
  let days = d.days != null ? parseInt(d.days, 10) : MAX_DAYS;
  if (!isFinite(days)) days = MAX_DAYS;
  days = Math.max(0, Math.min(MAX_DAYS, days));
  const on = (k) => d[k] !== false;
  return {
    temp: on('temp'), feels_like: on('feels_like'), humidity: on('humidity'), wind: on('wind'),
    desc: on('desc'), details: on('details'), hourly: on('hourly'), sun: on('sun'),
    days
  };
}

/** Mirror resolveCardSource: per-card display prefs, default = current behavior. */
async function resolveCardDisplay(card) {
  const blockId = card?.dataset?.blockId
    || card?.closest?.('.dashboard-block')?.dataset?.blockId;
  if (!blockId) return normalizeDisplay({});
  try {
    const { dashboardConfig } = await import('../dashboard.js');
    const layout = dashboardConfig?.dashboards?.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
    const block = (layout || []).find(b => String(b.id) === String(blockId));
    return normalizeDisplay(block?.config?.display);
  } catch { return normalizeDisplay({}); }
}

/** Charts prefs (S4', AC12). config charts:{ghi default ON, temp default OFF}.
 *  JSON-string convention accepted. No new metric names. */
function normalizeCharts(raw) {
  let c = raw;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = {}; } }
  if (!c || typeof c !== 'object') c = {};
  return { ghi: c.ghi !== false, temp: c.temp === true };
}

/** Mirror resolveCardDisplay: per-card chart prefs, defaults = ghi on/temp off. */
async function resolveCardCharts(card) {
  const blockId = card?.dataset?.blockId
    || card?.closest?.('.dashboard-block')?.dataset?.blockId;
  if (!blockId) return normalizeCharts({});
  try {
    const { dashboardConfig } = await import('../dashboard.js');
    const layout = dashboardConfig?.dashboards?.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
    const block = (layout || []).find(b => String(b.id) === String(blockId));
    return normalizeCharts(block?.config?.charts);
  } catch { return normalizeCharts({}); }
}

function wxHourMs(h) {
  const t = h && (h.period_end || h.period);
  const ms = t ? new Date(t).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Next-24h window of hourly[], sorted. Shared x-axis for both charts. */
function next24hPoints(hourly) {
  const now = Date.now();
  const end = now + 24 * 3600 * 1000;
  return (hourly || [])
    .map(h => ({ h, ms: wxHourMs(h) }))
    .filter(e => e.ms != null && e.ms >= now - 3600 * 1000 && e.ms <= end)
    .sort((a, b) => a.ms - b.ms);
}

/** p10/p90 band pair for one period: ghi10/90 preferred, else pv_estimate10/90.
 *  Both bounds must be non-null (AC13); never do arithmetic on nulls. */
function wxBandPair(h) {
  const g10 = numOrNull(h.ghi10), g90 = numOrNull(h.ghi90);
  if (g10 != null && g90 != null) return [g10, g90];
  const p10 = numOrNull(h.pv_estimate10), p90 = numOrNull(h.pv_estimate90);
  if (p10 != null && p90 != null) return [p10, p90];
  return [null, null];
}

/** Destroy-before-recreate for one card chart; handles stored on the element. */
function destroyWxChart(card, key) {
  const handles = card && card._wxCharts;
  const prev = handles && handles[key];
  if (prev) {
    try { prev.destroy(); } catch { /* already gone */ }
    handles[key] = null;
  }
}

/** Render one mini-chart. Mirrors forecast.js Chart load/lifecycle/theme:
 *  parent-rect x DPR sizing, new Chart(ctx), time x-axis, theme tick colors.
 *  All-null series -> "--" caption, no crash (AC13). */
function drawWxChart(card, key, enabled, series, band, opts) {
  const wrap = card.querySelector(`.weather-chart-${key}`);
  if (!wrap) return;
  const canvas = wrap.querySelector('canvas');
  const caption = wrap.querySelector('.weather-chart-caption');
  destroyWxChart(card, key);
  if (!enabled) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const hasData = series.some(p => p.y != null);
  if (!hasData) { wrap.hidden = true; return; } // nothing to plot from this source
  if (!canvas || typeof Chart === 'undefined') {
    if (canvas) canvas.style.display = 'none';
    if (caption) { caption.textContent = 'Chart unavailable'; caption.hidden = false; }
    return;
  }
  if (caption) caption.hidden = true;
  canvas.style.display = '';

  const rect = wrap.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    canvas.width = rect.width * (window.devicePixelRatio || 1);
    canvas.height = rect.height * (window.devicePixelRatio || 1);
  }

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const tickColor = isDark ? '#f8fafc' : '#0f172a';
  const now = Date.now();
  const datasets = [];
  if (band && band.some(p => p.lo != null && p.hi != null)) {
    datasets.push(
      { label: `${opts.label} p10`, data: band.map(p => ({ x: p.x, y: p.lo })), borderColor: 'transparent', backgroundColor: 'transparent', borderWidth: 0, pointRadius: 0, spanGaps: true },
      { label: `${opts.label} p90`, data: band.map(p => ({ x: p.x, y: p.hi })), borderColor: 'transparent', backgroundColor: opts.bandColor, borderWidth: 0, pointRadius: 0, fill: '-1', spanGaps: true }
    );
  }
  datasets.push({
    label: opts.label, data: series,
    borderColor: opts.color, backgroundColor: opts.fill || 'transparent',
    borderWidth: 2, tension: 0.4, pointRadius: 0, fill: !!opts.fill, spanGaps: true
  });

  card._wxCharts = card._wxCharts || {};
  card._wxCharts[key] = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      elements: { line: { borderWidth: 2, tension: 0.4 }, point: { radius: 0 } },
      scales: {
        x: { type: 'time', time: { unit: 'hour', displayFormats: { hour: 'HH' } }, grid: { display: false }, ticks: { color: tickColor, maxTicksLimit: 8 }, min: now, max: now + 24 * 3600 * 1000 },
        y: { beginAtZero: true, grid: { display: false }, ticks: { color: tickColor, maxTicksLimit: 4 } }
      },
      plugins: { tooltip: { enabled: true }, legend: { display: false } }
    }
  });
}

/** Per-card GHI area + temp line over the shared next-24h axis. No badges. */
function renderWeatherCharts(card, hourly, charts) {
  const prefs = charts || normalizeCharts({});
  const pts = next24hPoints(hourly);
  const ghiSeries = pts.map(({ h, ms }) => ({
    x: ms, y: numOrNull(h.ghi ?? h.shortwave_radiation ?? h.pv_estimate)
  }));
  const tempSeries = pts.map(({ h, ms }) => ({ x: ms, y: numOrNull(h.air_temp) }));
  const band = pts.map(({ h, ms }) => {
    const [lo, hi] = wxBandPair(h);
    return { x: ms, lo, hi };
  });
  drawWxChart(card, 'ghi', prefs.ghi, ghiSeries, band,
    { label: 'GHI', color: '#f59e0b', fill: 'rgba(245,158,11,0.25)', bandColor: 'rgba(245,158,11,0.15)' });
  drawWxChart(card, 'temp', prefs.temp, tempSeries, null,
    { label: 'Temp C', color: '#38bdf8', fill: null, bandColor: 'transparent' });
}

/** Current-hour entry from the card's own hourly[] (already fetched). */
function currentHourEntry(hourly) {
  const nowHour = new Date().getHours();
  for (const h of hourly || []) {
    const t = h && (h.period_end || h.period);
    if (!t) continue;
    if (new Date(t).getHours() !== nowHour) continue;
    return h;
  }
  return null;
}

/** Alert rules (M2b, AC15/AC16). config.alerts[{metric,op,value}], max 4.
 *  JSON-string convention accepted. Malformed entries ignored defensively
 *  (editor validates; renderer never throws). */
const ALERT_METRICS = new Set(['temp', 'wind', 'precip', 'cloud']);
const ALERT_OPS = new Set(['>', '<']);
function normalizeAlerts(raw) {
  let a = raw;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = []; } }
  if (!Array.isArray(a)) return [];
  return a
    .filter(r => r && typeof r === 'object'
      && ALERT_METRICS.has(r.metric) && ALERT_OPS.has(r.op)
      && Number.isFinite(Number(r.value)))
    .slice(0, 4)
    .map(r => ({ metric: r.metric, op: r.op, value: Number(r.value) }));
}

/** Mirror resolveCardDisplay: per-card alert rules, default = none. */
async function resolveCardAlerts(card) {
  const blockId = card?.dataset?.blockId
    || card?.closest?.('.dashboard-block')?.dataset?.blockId;
  if (!blockId) return [];
  try {
    const { dashboardConfig } = await import('../dashboard.js');
    const layout = dashboardConfig?.dashboards?.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
    const block = (layout || []).find(b => String(b.id) === String(blockId));
    return normalizeAlerts(block?.config?.alerts);
  } catch { return []; }
}

/** Current value per metric. temp: w.temp else current-hour air_temp;
 *  wind: current-hour wind_speed_10m else wind_speed (m/s);
 *  precip: current-hour precip_rate; cloud: current-hour cloud_opacity.
 *  Null/absent -> null (rule skipped silently, T19). */
function alertCurrentValue(metric, w, hourly) {
  const entry = currentHourEntry(hourly);
  switch (metric) {
    case 'temp': {
      const t = w && w.temp != null ? w.temp : entry?.air_temp;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    }
    case 'wind': {
      const v = entry ? (entry.wind_speed_10m ?? entry.wind_speed) : (w ? w.wind_speed : undefined);
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case 'precip': {
      const v = entry ? (entry.precip_rate ?? entry.precip) : (w ? w.precip : undefined);
      const n = Number(v);
      return v != null && Number.isFinite(n) ? n : null;
    }
    case 'cloud': {
      const v = entry ? (entry.cloud_opacity ?? entry.cloud_cover) : (w ? w.cloud_cover : undefined);
      const n = Number(v);
      return v != null && Number.isFinite(n) ? n : null;
    }
    default: return null;
  }
}

const ALERT_LABEL = {
  temp: v => `Temp ${v.toFixed(0)}°C`,
  wind: v => `Wind ${v.toFixed(0)} m/s`,
  precip: v => `Precip ${v.toFixed(1)} mm`,
  cloud: v => `Cloud ${v.toFixed(0)}%`
};

/** Evaluate rules against current values; render one inline badge per
 *  breach. Container cleared on recovery / no-breach / no-rules, so
 *  switching source or removing config clears badges. No persistence,
 *  no cross-card state — all inputs are this card's own w + hourly[]. */
function renderAlerts(card, w, hourly, alerts) {
  const box = card.querySelector(':scope > .weather-alerts');
  if (!box) return;
  box.innerHTML = '';
  box.hidden = true;
  box.style.display = 'none';
  if (!alerts || !alerts.length) return;
  const breaches = [];
  for (const rule of alerts) {
    const cur = alertCurrentValue(rule.metric, w, hourly);
    if (cur == null) continue;
    const hit = rule.op === '>' ? cur > rule.value : cur < rule.value;
    if (hit) breaches.push({ rule, cur });
  }
  if (!breaches.length) return;
  for (const { rule, cur } of breaches) {
    const badge = document.createElement('span');
    badge.className = 'weather-alert-badge';
    badge.innerHTML = escapeHtml(`${ALERT_LABEL[rule.metric](cur)} ${rule.op} ${rule.value}`);
    box.appendChild(badge);
  }
  box.hidden = false;
  box.style.display = '';
}

/** Clear badges (error path / source switch without data). */
function clearAlerts(card) {
  const box = card.querySelector(':scope > .weather-alerts');
  if (!box) return;
  box.innerHTML = '';
  box.hidden = true;
  box.style.display = 'none';
}

function detailItem(icon, label, value) {
  return `<div class="wx-detail"><dt><i class="fi ${icon}" aria-hidden="true"></i>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function renderCard(container, data, disp, charts, alerts) {
  const w = data.weather || {};
  const show = disp || normalizeDisplay({});
  const q = (sel) => container.querySelector(sel);
  container.classList.toggle('wx-stale', !!w.stale);

  const updated = w.updated_at ? new Date(w.updated_at) : new Date();
  q('.weather-last-updated').textContent = `${w.stale ? 'Stale · ' : ''}${updated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;

  // Current conditions
  q('.wx-now-icon').innerHTML = iconHtml(w.icon_class, w.code, w.is_day);
  const tempEl = q('.wx-now-temp');
  tempEl.textContent = fmtTemp(w.temp);
  tempEl.hidden = !show.temp;
  const descEl = q('.wx-now-desc');
  descEl.textContent = w.available === false ? 'Weather unavailable' : (w.desc || '');
  descEl.hidden = !show.desc && w.available !== false;
  const today = w.today || null;
  const hilo = q('.wx-hilo');
  hilo.textContent = today && (today.temp_max != null || today.temp_min != null)
    ? `H ${fmtTemp(today.temp_max)} · L ${fmtTemp(today.temp_min)}` : '';
  hilo.hidden = !show.temp || !hilo.textContent;
  // Compact one-liner used when the card is too narrow for the details grid.
  const extraParts = [];
  if (show.feels_like && w.feels_like != null) extraParts.push(`Feels ${fmtTemp(w.feels_like)}`);
  if (show.humidity && w.humidity != null) extraParts.push(`${fmtNum(w.humidity, 0, '%')} RH`);
  if (show.wind && w.wind_speed != null) extraParts.push(fmtWind(w.wind_speed, w.wind_compass));
  const extraEl = q('.wx-extra');
  extraEl.textContent = extraParts.join(' · ');
  extraEl.hidden = !extraParts.length;

  // Details grid: every value the source provided
  const items = [];
  if (show.feels_like && w.feels_like != null) items.push(detailItem('fi-sr-temperature-high', 'Feels like', fmtTemp(w.feels_like)));
  if (show.humidity && w.humidity != null) items.push(detailItem('fi-sr-humidity', 'Humidity', fmtNum(w.humidity, 0, '%')));
  if (show.wind && w.wind_speed != null) items.push(detailItem('fi-sr-wind', 'Wind', fmtWind(w.wind_speed, w.wind_compass, w.wind_gusts)));
  if (show.details) {
    const rain = [w.precip_probability != null ? fmtNum(w.precip_probability, 0, '%') : null,
      w.precip != null && w.precip > 0 ? fmtNum(w.precip, 1, ' mm') : null].filter(Boolean).join(' · ');
    if (rain) items.push(detailItem('fi-sr-umbrella', 'Rain', rain));
    if (w.cloud_cover != null) items.push(detailItem('fi-sr-clouds', 'Cloud', fmtNum(w.cloud_cover, 0, '%')));
    if (w.uv_index != null) items.push(detailItem('fi-sr-sun', 'UV', uvLabel(w.uv_index)));
    if (w.pressure != null) items.push(detailItem('fi-sr-tachometer-average', 'Pressure', fmtNum(w.pressure, 0, ' hPa')));
    if (w.ghi != null) items.push(detailItem('fi-sr-sun-dust', 'Irradiance', fmtNum(w.ghi, 0, ' W/m²')));
  }
  if (show.sun && w.sunrise) items.push(detailItem('fi-sr-sunrise', 'Sunrise', timeLabel(w.sunrise)));
  if (show.sun && w.sunset) items.push(detailItem('fi-sr-sunset', 'Sunset', timeLabel(w.sunset)));
  const details = q('.wx-details');
  details.innerHTML = items.join('');
  details.hidden = !items.length;
  container.classList.toggle('wx-has-details', items.length > 0);

  // Hourly strip (next 24 h)
  const hourlyEl = q('.wx-hourly');
  // Skip hours already past (the payload can be up to 15 min old).
  const hours = show.hourly ? (w.hourly || []).filter(h => new Date(h.time).getTime() > Date.now() - 45 * 60000) : [];
  hourlyEl.innerHTML = hours.map(h => `
    <div class="wx-hour">
      <span class="wx-hour-time">${escapeHtml(hourLabel(h.time))}</span>
      ${iconHtml(h.icon_class, h.code, h.is_day)}
      <span class="wx-hour-temp">${fmtTemp(h.temp)}</span>
      <span class="wx-hour-rain">${h.precip_probability != null && h.precip_probability > 0 ? fmtNum(h.precip_probability, 0, '%') : ''}</span>
    </div>`).join('');
  hourlyEl.hidden = !hours.length;

  // Multi-day outlook with a hi/lo range bar scaled across the shown days
  const days = (w.forecast_weather || []).slice(0, show.days);
  const daysEl = q('.wx-days');
  const lows = days.map(d => d.temp_min).filter(v => v != null);
  const highs = days.map(d => d.temp_max ?? d.temp).filter(v => v != null);
  const lo = lows.length ? Math.min(...lows) : null;
  const hi = highs.length ? Math.max(...highs) : null;
  const span = lo != null && hi != null && hi > lo ? hi - lo : null;
  daysEl.innerHTML = days.map(d => {
    const max = d.temp_max ?? d.temp;
    const bar = span != null && d.temp_min != null && max != null
      ? `<span class="wx-range"><span style="left:${((d.temp_min - lo) / span) * 100}%;right:${100 - ((max - lo) / span) * 100}%"></span></span>` : '<span class="wx-range"></span>';
    return `
      <div class="wx-day weather-forecast-day" title="${escapeHtml(d.desc || '')}">
        <span class="wx-day-name forecast-day-name">${escapeHtml(dayLabel(d.date, 'short'))}</span>
        ${iconHtml(d.icon_class, d.code, true)}
        <span class="wx-day-rain">${d.precip_probability != null && d.precip_probability > 0 ? fmtNum(d.precip_probability, 0, '%') : ''}</span>
        <span class="wx-day-lo">${d.temp_min != null ? fmtTemp(d.temp_min) : ''}</span>
        ${bar}
        <span class="wx-day-hi forecast-temp">${fmtTemp(max)}</span>
      </div>`;
  }).join('');
  daysEl.hidden = !days.length;
  container.classList.toggle('wx-has-days', days.length > 0);

  renderWeatherCharts(container, data.hourly, charts);
  renderAlerts(container, w, data.hourly, alerts);
}

export async function updateWeatherBlock(state) {
  const containers = [...document.querySelectorAll('.weather-block')];
  if (!containers.length) return;
  // Mini-charts need Chart.js; a dashboard may have no other chart card to load it.
  await ensureChartJS().catch(() => {});

  // Group instances by resolved source (+rest_map for rest:); default auto = legacy global behavior
  const sources = await Promise.all(containers.map(el => resolveCardSource(el)));
  const displays = await Promise.all(containers.map(el => resolveCardDisplay(el)));
  const dispByEl = new Map(containers.map((el, i) => [el, displays[i]]));
  const chartPrefs = await Promise.all(containers.map(el => resolveCardCharts(el)));
  const chartsByEl = new Map(containers.map((el, i) => [el, chartPrefs[i]]));
  const alertRules = await Promise.all(containers.map(el => resolveCardAlerts(el)));
  const alertsByEl = new Map(containers.map((el, i) => [el, alertRules[i]]));
  const groups = new Map();
  containers.forEach((el, i) => {
    const r = sources[i] || {};
    const src = r.source || 'auto';
    const restMap = r.restMap || {};
    const key = src.startsWith('rest:') ? JSON.stringify([src, restMap]) : src;
    if (!groups.has(key)) groups.set(key, { src, restMap, els: [] });
    groups.get(key).els.push(el);
  });

  // One fetch per distinct source (+rest_map); omit ?source= when auto (legacy URL, byte-identical)
  const entries = [...groups.entries()];
  const results = await Promise.all(entries.map(async ([key, g]) => {
    try {
      const res = await fetch(weatherUrlFor(g.src, g.restMap));
      return [key, await res.json()];
    } catch (err) { return [key, { error: true, _fetchFailed: true, source: g.src }]; }
  }));
  const dataBySource = new Map(results);

  for (const [key, g] of entries) {
    const src = g.src;
    const cards = g.els;
    const data = dataBySource.get(key);
    const label = sourceLabelFor(data, src);
    cards.forEach(c => {
      const el = c.querySelector('.weather-source');
      if (el) el.textContent = label;
    });

    cards.forEach(c => c.classList.toggle('wx-failed', (!data || data.error || !data.weather) && !c._wxRendered));
    if (!data || data.error || !data.weather) {
      const lastGood = lastGoodBySource[src];
      const msg = `Source ${label || src} unavailable${lastGood ? ` — last good ${lastGood}` : ''}`;
      cards.forEach(c => { setCardError(c, msg); clearAlerts(c); });
      continue;
    }
    lastGoodBySource[src] = new Date().toLocaleTimeString();
    cards.forEach(c => {
      setCardError(c, '');
      try {
        renderCard(c, data, dispByEl.get(c), chartsByEl.get(c), alertsByEl.get(c));
        c._wxRendered = true;
      } catch (err) {
        console.error('Weather block error:', err);
        setCardError(c, `Source ${label || src} unavailable`);
      }
    });
  }
}
