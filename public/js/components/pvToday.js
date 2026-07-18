/**
 * PV Today Card — solar monitoring block with summary bar, weather timeline, and chart.
 */
import { escapeHtml } from '../utils.js';
import { uid } from '../utils/uid.js';

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

export async function updatePvToday(forecastData) {
  const cards = document.querySelectorAll('.pv-today-instance');
  if (!cards.length) { DEBUG_PVTODAY && console.log('[pvToday] no .pv-today-instance elements in DOM'); return; }

  const hasData = forecastData && !forecastData.error && forecastData.daily && forecastData.daily.length;
  DEBUG_PVTODAY && console.log('[pvToday] called — hasData:', hasData, 'cards found:', cards.length,
    forecastData ? `daily:${forecastData.daily?.length} hourly:${forecastData.hourly?.length} error:${forecastData.error}` : 'no forecastData');

  const now = new Date();
  const todayDate = now.toLocaleDateString('en-CA');
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
      .filter(h => new Date(h.period_end).toLocaleDateString('en-CA') === todayDate)
      .map(h => ({ x: new Date(h.period_end).getTime(), pv: h.pv_estimate || 0, cloud: h.cloud_cover != null ? h.cloud_cover : null }));
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
      if (emptyEl) emptyEl.style.display = 'flex';
      if (canvas) canvas.style.display = 'none';
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
      .reduce((sum, h) => sum + (h.pv || 0), 0);
    const progPct = totalForecastKwh > 0 ? Math.min(100, (actualKwh / Math.max(totalForecastKwh, actualKwh + remKwh)) * 100) : 0;
    DEBUG_PVTODAY && console.log('[pvToday] actualKwh:', actualKwh.toFixed(2), 'remKwh:', remKwh.toFixed(2), 'progPct:', progPct.toFixed(1));

    const genEl = el('pvt-generated');
    if (genEl) genEl.textContent = actualKwh.toFixed(1) + ' kWh';
    const remEl = el('pvt-remaining');
    if (remEl) remEl.textContent = remKwh.toFixed(1) + ' kWh';
    const fillEl = el('pvt-progress-fill');
    if (fillEl) fillEl.style.width = progPct + '%';

    // Weather timeline strip
    renderTimeline(el('pvt-icons'), el('pvt-timeline-bar'), todayHourly, now, isDark);

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

    if (typeof Chart === 'undefined') { DEBUG_PVTODAY && console.error('[pvToday] Chart.js not loaded!'); continue; }

    const mutedColor = isDark ? '#94a3b8' : '#666666';
    const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

    const ctx = canvas.getContext('2d');
    try {
    if (!pvTodayCharts[canvasId]) {
      pvTodayCharts[canvasId] = new Chart(ctx, {
        type: 'line',
        data: { datasets: [
          { label: 'Generated', data: [], borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.12)', borderWidth: 2, tension: 0.4, pointRadius: 0, fill: true, yAxisID: 'y', order: 2 },
          { label: 'Predicted', data: [], borderColor: '#d97706', backgroundColor: 'transparent', borderWidth: 2.5, borderDash: [6, 4], tension: 0.4, pointRadius: 0, fill: false, yAxisID: 'y', order: 4 },
          { label: 'Cloud Cover', data: [], borderColor: 'rgba(180,185,210,0.7)', backgroundColor: 'rgba(180,185,210,0.15)', borderWidth: 2, tension: 0.3, pointRadius: 0, fill: true, yAxisID: 'y1', order: 0 }
        ]},
        options: {
          responsive: true, maintainAspectRatio: false,
          devicePixelRatio: window.devicePixelRatio || 1,
          animation: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: {
            x: { type: 'linear', min: getHourTimestamp(7), max: getHourTimestamp(19), ticks: { stepSize: 2 * 3600000, callback: v => new Date(v).getHours(), color: mutedColor, font: { size: 9 } }, grid: { color: gridColor } },
            y: { type: 'linear', position: 'left', beginAtZero: true, ticks: { callback: v => v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v, color: mutedColor, font: { size: 9 }, maxTicksLimit: 4 }, grid: { color: gridColor } },
            y1: { type: 'linear', position: 'right', min: 0, max: 100, ticks: { callback: v => (v === 0 || v === 50 || v === 100) ? v : '', color: '#7d869e', font: { size: 8 } }, grid: { display: false } }
          }
        },
        plugins: [{
          id: 'nowLine',
          afterDraw(chart) {
            const { ctx, chartArea, scales } = chart;
            const nowX = Date.now();
            if (nowX < scales.x.min || nowX > scales.x.max) return;
            const x = scales.x.getPixelForValue(nowX);
            ctx.save(); ctx.beginPath(); ctx.setLineDash([3, 3]); ctx.strokeStyle = '#d94141'; ctx.lineWidth = 1;
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
    chart.options.scales.x.ticks.color = mutedColor;
    chart.options.scales.y.ticks.color = mutedColor;
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

function renderTimeline(iconsEl, barEl, hourly, now, isDark) {
  if (!iconsEl || !barEl) { DEBUG_PVTODAY && console.log('[pvToday] renderTimeline skipped — iconsEl:', !!iconsEl, 'barEl:', !!barEl); return; }
  const slots = [7, 10, 13, 16, 19];
  const timelineData = slots.map(h => {
    const t = getHourTimestamp(h);
    const entry = hourly.reduce((best, cur) => {
      if (!best || Math.abs(cur.x - t) < Math.abs(best.x - t)) return cur;
      return best;
    }, null);
    return { hour: h, cloud: entry ? entry.cloud : null };
  });
  DEBUG_PVTODAY && console.log('[pvToday] timelineData:', timelineData, 'hourly count:', hourly.length);
  // Weather timeline: bars only (emoji icons removed per design spec)
  iconsEl.innerHTML = timelineData.map(d => {
    return `<span class="pvt-timeline-icon" title="${d.hour}:00"></span>`;
  }).join('');
  const colors = timelineData.map(d => {
    if (d.cloud == null) return isDark ? '#475569' : '#c8cada';
    if (d.cloud > 80) return '#7b84a0';
    if (d.cloud > 50) return '#9ca3af';
    if (d.cloud > 20) return '#ffe870';
    return '#f59e0b';
  });
  barEl.innerHTML = colors.map(c =>
    `<div class="pvt-timeline-seg" style="background:${c};flex:1;height:3px;border-radius:1px;margin:0 1px;"></div>`
  ).join('');
}

function getHourTimestamp(hour) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0).getTime();
}
