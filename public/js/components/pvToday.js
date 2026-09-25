/**
 * PV Today Card — solar monitoring block with summary bar, weather timeline, and chart.
 */
import { escapeHtml } from '../utils.js';
import { uid } from '../utils/uid.js';
import { ensureChartJS } from '../chartLoader.js';
import { iconHtml, iconForCode, localDate } from '../weatherFormat.js';

const pvTodayCharts = {};
const pvTodayObservers = {};

export function buildPvToday(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const metrics = config.metrics || {};
  const locationName = config.location_name || 'Solar PV';
  const generatedField = metrics.generated || 'solar';

  const card = document.createElement('div');
  card.className = 'pv-today-card pv-today-instance';
  card.dataset.blockId = id;
  card.dataset.metricMap = JSON.stringify({ generated: generatedField });

  card.innerHTML = `
    <div class="pv-today-header">
      <span class="pv-today-title" id="${uid('pvt-title', id)}">${escapeHtml(locationName)}</span>
    </div>
    <div class="pv-today-summary" id="${uid('pvt-summary', id)}">
      <div class="pvt-metric pvt-left">
        <span class="pvt-value" id="${uid('pvt-generated', id)}">--</span>
        <span class="pvt-label">Generated</span>
      </div>
      <div class="pvt-progress-wrap">
        <div class="pvt-progress-bar"><div class="pvt-progress-fill" id="${uid('pvt-progress-fill', id)}" style="width:0%"></div></div>
      </div>
      <div class="pvt-metric pvt-right">
        <span class="pvt-value" id="${uid('pvt-remaining', id)}">--</span>
        <span class="pvt-label">Remaining</span>
      </div>
    </div>
    <div class="pv-today-timeline" id="${uid('pvt-timeline', id)}">
      <div class="pvt-timeline-icons" id="${uid('pvt-icons', id)}"></div>
      <div class="pvt-timeline-bar" id="${uid('pvt-timeline-bar', id)}"></div>
    </div>
    <div class="pvt-chart-container" id="${uid('pvt-chart-wrap', id)}">
      <canvas id="${uid('pvt-chart', id)}"></canvas>
      <div class="pvt-no-data" id="${uid('pvt-empty', id)}" style="display:none;">No forecast data</div>
    </div>
    <div class="pvt-legend">
      <span class="pvt-legend-item"><span class="pvt-legend-line pvt-legend-generated"></span> Generated</span>
      <span class="pvt-legend-item"><span class="pvt-legend-line pvt-legend-predicted"></span> Predicted</span>
      <span class="pvt-legend-item"><span class="pvt-legend-line pvt-legend-now"></span> Now</span>
      <span class="pvt-legend-item"><span class="pvt-legend-line pvt-legend-cloud"></span> Cloud</span>
    </div>
  `;

  // ResizeObserver: keeps canvas sized to container, triggers chart.resize()
  const canvasId = id ? `pvt-chart-${id}` : 'pvt-chart';
  const wrapId = id ? `pvt-chart-wrap-${id}` : 'pvt-chart-wrap';
  requestAnimationFrame(() => {
    const wrap = document.getElementById(wrapId);
    const canvas = document.getElementById(canvasId);
    if (!wrap || !canvas) return;
    const observer = new ResizeObserver(() => {
      const chart = pvTodayCharts[canvasId];
      if (chart) chart.resize();
    });
    observer.observe(wrap);
    pvTodayObservers[canvasId] = observer;
  });

  return card;
}

const DEBUG_PVTODAY = false; // Set to false to silence diagnostic logs

const PV_SOURCE_LABELS = { solcast: 'Solcast', 'open-meteo': 'Open-Meteo', auto: 'Auto' };
function pvSourceLabel(data) {
  if (data && data.source_label) return data.source_label;
  const key = (data && data.source) || '';
  return PV_SOURCE_LABELS[key] || key || '';
}

/**
 * Render PV Today cards.
 * @param {object} forecastData server payload for this card group (must carry
 *   source/source_label when rendered per-source from forecast.js)
 * @param {Element[]} [targetCards] restrict rendering to these instances
 *   (per-source group threading); omitted = all .pv-today-instance (legacy)
 * @param {string} [lastGoodTime] in-memory last-good timestamp for this source (AC8)
 */
export async function updatePvToday(forecastData, targetCards, lastGoodTime = '') {
  const cards = (targetCards && targetCards.length ? [...targetCards] : [...document.querySelectorAll('.pv-today-instance')]);
  if (!cards.length) { DEBUG_PVTODAY && console.log('[pvToday] no .pv-today-instance elements in DOM'); return; }

  const hasData = forecastData && !forecastData.error && forecastData.daily && forecastData.daily.length;
  DEBUG_PVTODAY && console.log('[pvToday] called — hasData:', hasData, 'cards found:', cards.length,
    forecastData ? `daily:${forecastData.daily?.length} hourly:${forecastData.hourly?.length} error:${forecastData.error}` : 'no forecastData');

  const now = new Date();
  const todayDate = localDate(now);
  const win = pvWindow(forecastData && forecastData.weather);
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  DEBUG_PVTODAY && console.log('[pvToday] todayDate:', todayDate, 'systemCapacityKwp:', window.systemCapacityKwp, 'Chart loaded:', typeof Chart !== 'undefined');

  let today = null, totalForecastKwh = 0, todayHourly = [];

  if (hasData) {
    let ti = forecastData.daily.findIndex(d => d.date === todayDate);
    if (ti === -1) ti = 0;
    today = forecastData.daily[ti];
    totalForecastKwh = today.total_kwh || 0;
    DEBUG_PVTODAY && console.log('[pvToday] today index:', ti, 'total_kwh:', totalForecastKwh, 'actual_so_far:', today.actual_so_far);
    todayHourly = (forecastData.hourly || [])
      .filter(h => localDate(new Date(h.period_end)) === todayDate)
      .map(h => ({
        x: new Date(h.period_end).getTime(),
        pv: h.pv_estimate || 0,
        // kWh in this period (Solcast periods are 30 min; energy_kwh from the backend)
        kwh: h.energy_kwh != null ? h.energy_kwh : (h.pv_estimate || 0),
        cloud: h.cloud_cover != null ? h.cloud_cover : null,
        code: h.weather_code != null ? h.weather_code : null,
        isDay: h.is_day
      }));
    DEBUG_PVTODAY && console.log('[pvToday] todayHourly entries:', todayHourly.length, 'sample:', todayHourly.slice(0,3));
  }

  // Fetch intraday once, not per-card
  let intradayData = [];
  try {
    const intraRes = await fetch('/api/solar/intraday?field=solar');
    if (intraRes.ok) intradayData = await intraRes.json();
  } catch (e) { DEBUG_PVTODAY && console.error('[pvToday] intraday fetch error:', e); }
  DEBUG_PVTODAY && console.log('[pvToday] intraday rows:', intradayData.length, 'hasWatts>0:', intradayData.some(r => r.watts > 0), 'hasDailySolar>0:', intradayData.some(r => r.daily_solar > 0));

  for (const card of cards) {
    try {
    const id = card.dataset.blockId || '';
    DEBUG_PVTODAY && console.log('[pvToday] processing card:', id || '(no id)');
    const el = (s) => document.getElementById(id ? `${s}-${id}` : s);
    const canvasId = id ? `pvt-chart-${id}` : 'pvt-chart';
    const canvas = document.getElementById(canvasId);
    const emptyEl = el('pvt-empty');
    DEBUG_PVTODAY && console.log('[pvToday] canvas found:', !!canvas, 'canvasId:', canvasId, 'emptyEl:', !!emptyEl);

    if (!hasData) {
      // Inline per-card error (AC8): card stays visible, never display:none.
      const label = pvSourceLabel(forecastData);
      const msg = forecastData && forecastData.error
        ? `Source ${label || 'forecast'} unavailable${lastGoodTime ? ` — last good ${lastGoodTime}` : ''}`
        : 'No forecast data';
      if (emptyEl) { emptyEl.textContent = msg; emptyEl.style.display = 'flex'; }
      continue;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    if (canvas) canvas.style.display = '';

    let generatedField = '';
    try { const mm = JSON.parse(card.dataset.metricMap); if (mm.generated) generatedField = mm.generated; } catch (e) {}
    if (!generatedField) generatedField = 'solar';
    DEBUG_PVTODAY && console.log('[pvToday] generatedField:', generatedField);

    let actualKwh = 0;
    const todayStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
    if (intradayData.length > 1) {
      const todayData = intradayData.filter(r => r.timestamp >= todayStart);
      const hasInstant = todayData.some(r => r.watts > 0);
      if (hasInstant) {
        for (let i = 0; i < todayData.length - 1; i++) {
          const dt = (todayData[i + 1].timestamp - todayData[i].timestamp) / 3600;
          actualKwh += ((todayData[i].watts + todayData[i + 1].watts) / 2000) * dt;
        }
      } else if (todayData[0]?.daily_solar != null) {
        // Derive from daily_solar — use today's data only, skip yesterday's tail
        const ds = todayData.filter(r => r.daily_solar != null);
        if (ds.length >= 2) actualKwh = ds[ds.length - 1].daily_solar - ds[0].daily_solar;
        if (actualKwh < 0) actualKwh = ds[ds.length - 1].daily_solar || 0;
      }
    }
    if (actualKwh === 0 && generatedField === 'solar') actualKwh = today?.actual_so_far ?? 0;
    // Remaining: sum forecast from now until end of today
    const nowMs = Date.now();
    const remKwh = todayHourly
      .filter(h => h.x > nowMs)
      .reduce((sum, h) => sum + (h.kwh || 0), 0);
    const progPct = totalForecastKwh > 0 ? Math.min(100, (actualKwh / Math.max(totalForecastKwh, actualKwh + remKwh)) * 100) : 0;
    DEBUG_PVTODAY && console.log('[pvToday] actualKwh:', actualKwh.toFixed(2), 'remKwh:', remKwh.toFixed(2), 'progPct:', progPct.toFixed(1));

    const genEl = el('pvt-generated');
    if (genEl) genEl.textContent = actualKwh.toFixed(1) + ' kWh';
    const remEl = el('pvt-remaining');
    if (remEl) remEl.textContent = remKwh.toFixed(1) + ' kWh';
    const fillEl = el('pvt-progress-fill');
    if (fillEl) fillEl.style.width = progPct + '%';

    // Weather timeline strip
    renderTimeline(el('pvt-icons'), el('pvt-timeline-bar'), todayHourly, win);

    // Chart — sized by CSS + Chart.js responsive; resize handled by observer in builder
    if (!canvas) continue;

    const hasInstantW = intradayData.some(r => r.watts > 0);
    const generatedByHour = hasInstantW
      ? bucketIntradayByHour(intradayData, now)
      : bucketIntradayByDailySolar(intradayData, now);
    const predictedByHour = todayHourly.map(h => ({ x: h.x, y: h.pv * 1000 }));
    const cloudByHour = todayHourly.filter(h => h.cloud != null).map(h => ({ x: h.x, y: h.cloud }));
    DEBUG_PVTODAY && console.log('[pvToday] chart datasets — generated:', generatedByHour.length, 'predicted:', predictedByHour.length, 'cloud:', cloudByHour.length, 'hasInstantW:', hasInstantW);
    if (generatedByHour.length) DEBUG_PVTODAY && console.log('[pvToday] generated sample:', generatedByHour.slice(0, 3));

    try { await ensureChartJS(); } catch (e) { continue; }

    const mutedColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();
    const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

    const ctx = canvas.getContext('2d');
    try {
    if (!pvTodayCharts[canvasId]) {
      // Adapt chart colors based on theme via CSS variables
      var style = getComputedStyle(document.documentElement);
      var generatedColor = style.getPropertyValue('--color-solar').trim();
      var predictedColor = style.getPropertyValue('--color-solar-r').trim();
      var cloudColor = style.getPropertyValue('--color-cloud-moderate').trim();
      // Compute rgba fill from cloud color with low alpha
      var cloudFill = cloudColor.replace(')', ',0.15)').replace('rgb', 'rgba');
      if (cloudFill === cloudColor) cloudFill = 'rgba(180,185,210,0.15)'; // fallback
      var nowLineColor = style.getPropertyValue('--color-negative').trim();
      var axisColor = style.getPropertyValue('--text-secondary').trim();
      // Compute rgba from resolved solar color for fill
      var genFill = generatedColor.replace(')', ',0.12)').replace('rgb', 'rgba');
      if (genFill === generatedColor) genFill = 'rgba(245,158,11,0.12)'; // fallback
      pvTodayCharts[canvasId] = new Chart(ctx, {
        type: 'line',
        data: { datasets: [
          { label: 'Generated', data: [], borderColor: generatedColor, backgroundColor: genFill, borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true, yAxisID: 'y', order: 2 },
          { label: 'Predicted', data: [], borderColor: predictedColor, backgroundColor: 'transparent', borderWidth: 2.5, borderDash: [6, 4], tension: 0.4, pointRadius: 0, fill: false, yAxisID: 'y', order: 4 },
          { label: 'Cloud Cover', data: [], borderColor: cloudColor, backgroundColor: cloudFill, borderWidth: 2, tension: 0.3, pointRadius: 0, fill: true, yAxisID: 'y1', order: 0 }
        ]},
        options: {
          responsive: true, maintainAspectRatio: false,
          devicePixelRatio: window.devicePixelRatio || 1,
          animation: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: {
            x: { type: 'linear', min: win.start, max: win.end, ticks: { stepSize: 2 * 3600000, callback: v => new Date(v).getHours(), color: mutedColor, font: { size: 9 } }, grid: { color: gridColor } },
            y: { type: 'linear', position: 'left', beginAtZero: true, ticks: { callback: v => v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v, color: mutedColor, font: { size: 9 }, maxTicksLimit: 4 }, grid: { color: gridColor } },
            y1: { type: 'linear', position: 'right', min: 0, max: 100, ticks: { callback: v => (v === 0 || v === 50 || v === 100) ? v : '', color: axisColor, font: { size: 8 } }, grid: { display: false } }
          }
        },
        plugins: [{
          id: 'nowLine',
          afterDraw(chart) {
            const { ctx, chartArea, scales } = chart;
            const nowX = Date.now();
            if (nowX < scales.x.min || nowX > scales.x.max) return;
            const x = scales.x.getPixelForValue(nowX);
            ctx.save(); ctx.beginPath(); ctx.setLineDash([3, 3]); ctx.strokeStyle = nowLineColor; ctx.lineWidth = 1;
            ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke(); ctx.restore();
          }
        }]
      });
    }
    // Update datasets in place — don't destroy/recreate
    const chart = pvTodayCharts[canvasId];
    chart.data.datasets[0].data = generatedByHour;
    chart.data.datasets[1].data = predictedByHour;
    chart.data.datasets[2].data = cloudByHour;
    chart.options.scales.x.min = win.start;
    chart.options.scales.x.max = win.end;
    chart.options.scales.x.ticks.color = mutedColor;
    chart.options.scales.y.ticks.color = mutedColor;
    chart.options.scales.x.grid.color = gridColor;
    chart.options.scales.y.grid.color = gridColor;
    chart.update('none');
    } catch (e) { DEBUG_PVTODAY && console.error('[pvToday] chart error:', e); }
    } catch (e) { DEBUG_PVTODAY && console.error('[pvToday] card processing error:', e); }
  }
}

function bucketIntradayByHour(data, now) {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayStartUnix = Math.floor(todayStart / 1000);
  const buckets = {};
  for (const row of data) {
    if (row.timestamp < todayStartUnix) continue;
    const ts = row.timestamp * 1000;
    const hour = Math.floor((ts - todayStart) / 3600000);
    if (!buckets[hour]) buckets[hour] = [];
    buckets[hour].push(row.watts);
  }
  return Object.entries(buckets).map(([hour, vals]) => ({
    x: todayStart + parseInt(hour) * 3600000 + 1800000,
    y: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
  })).sort((a, b) => a.x - b.x);
}

function bucketIntradayByDailySolar(data, now) {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayStartUnix = Math.floor(todayStart / 1000);
  const rows = data.filter(r => r.daily_solar != null && r.timestamp >= todayStartUnix).sort((a, b) => a.timestamp - b.timestamp);
  if (rows.length < 1) return [];
  // Anchor: prepend a synthetic 0 kWh point at sunrise if cumulative started above 0
  if (rows[0].daily_solar > 0) {
    const sunrise = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0).getTime() / 1000);
    rows.unshift({ timestamp: sunrise, daily_solar: 0 });
  }
  if (rows.length < 2) return [];
  const firstHour = Math.max(6, Math.floor((rows[0].timestamp - todayStartUnix) / 3600));
  const result = [];
  for (let h = firstHour; h <= 20; h++) {
    const t = (todayStart + h * 3600000 + 1800000) / 1000;
    let prev = null; for (let i = rows.length - 1; i >= 0; i--) { if (rows[i].timestamp <= t) { prev = rows[i]; break; } }
    const next = rows.find(r => r.timestamp > t);
    if (!prev || !next) continue;
    const dtHours = (next.timestamp - prev.timestamp) / 3600;
    if (dtHours <= 0) continue;
    const kw = ((next.daily_solar - prev.daily_solar) / dtHours) || 0;
    result.push({ x: todayStart + h * 3600000 + 1800000, y: Math.round(Math.max(0, kw) * 1000) });
  }
  return result;
}

/** Chart/timeline window: sunrise−1 h … sunset+1 h when known, else 07–19. */
function pvWindow(w) {
  const rise = w && w.sunrise ? new Date(w.sunrise) : null;
  const set = w && w.sunset ? new Date(w.sunset) : null;
  const ok = rise && set && !isNaN(rise) && !isNaN(set) && localDate(rise) === localDate();
  return ok
    ? { start: getHourTimestamp(Math.max(0, rise.getHours() - 1)), end: getHourTimestamp(Math.min(24, set.getHours() + 2)) }
    : { start: getHourTimestamp(7), end: getHourTimestamp(19) };
}

/** Cloud-cover % → WMO-like code, for sources (Solcast) without weather codes. */
function cloudToCode(cloud) {
  if (cloud == null) return null;
  return cloud > 85 ? 3 : cloud > 40 ? 2 : cloud > 15 ? 1 : 0;
}

function renderTimeline(iconsEl, barEl, hourly, win) {
  if (!iconsEl || !barEl) return;
  // Five evenly spaced slots across the daylight window.
  const slots = [0, 0.25, 0.5, 0.75, 1].map(f => win.start + f * (win.end - win.start));
  const timelineData = slots.map(t => {
    const entry = hourly.reduce((best, cur) => (!best || Math.abs(cur.x - t) < Math.abs(best.x - t) ? cur : best), null);
    const code = entry ? (entry.code != null ? entry.code : cloudToCode(entry.cloud)) : null;
    return { t, cloud: entry ? entry.cloud : null, code, isDay: entry ? entry.isDay : null };
  });
  iconsEl.innerHTML = timelineData.map(d => {
    const hour = new Date(d.t).getHours();
    const label = `${String(hour).padStart(2, '0')}:00${d.cloud != null ? ` · cloud ${Math.round(d.cloud)}%` : ''}`;
    return `<span class="pvt-timeline-icon" title="${label}">${d.code != null ? iconHtml(iconForCode(d.code, d.isDay), d.code, d.isDay) : ''}</span>`;
  }).join('');
  // Read CSS variable colors for cloud coverage bars
  const style = getComputedStyle(document.documentElement);
  const cloudNoData = style.getPropertyValue('--border').trim();
  const cloudHeavy = style.getPropertyValue('--color-cloud-heavy').trim();
  const cloudModerate = style.getPropertyValue('--color-cloud-moderate').trim();
  const cloudLight = style.getPropertyValue('--color-cloud-light').trim();
  const cloudClear = style.getPropertyValue('--color-cloud-clear').trim();
  const colors = timelineData.map(d => {
    if (d.cloud == null) return cloudNoData;
    if (d.cloud > 80) return cloudHeavy;
    if (d.cloud > 50) return cloudModerate;
    if (d.cloud > 20) return cloudLight;
    return cloudClear;
  });
  barEl.innerHTML = colors.map(c =>
    `<div class="pvt-timeline-seg" style="background:${c};flex:1;height:3px;border-radius:1px;margin:0 1px;"></div>`
  ).join('');
}

function getHourTimestamp(hour) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0).getTime();
}

export function destroyPvTodayCharts() {
  for (const key in pvTodayCharts) {
    try { pvTodayCharts[key].destroy(); } catch (e) {}
    delete pvTodayCharts[key];
  }
  for (const key in pvTodayObservers) {
    try { pvTodayObservers[key].disconnect(); } catch (e) {}
    delete pvTodayObservers[key];
  }
}
