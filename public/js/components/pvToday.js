/**
 * PV Today Card — industrial solar monitoring block inspired by PV Today widget.
 *
 * Features:
 * - Title bar with location name
 * - Daily production summary: Generated kWh + progress bar + Remaining kWh
 * - Weather timeline strip with icons and colored condition segments
 * - Dual-axis Chart.js chart: generated curve (solid), predicted curve (dashed),
 *   cloud cover overlay (lavender), "Now" marker (red dashed)
 * - Responsive and freely resizable via GridStack editor
 * - Respects Epilykos theme system (light/dark, transparency toggle, per-block styling)
 *
 * @module components/pvToday
 */
import { uid } from '../utils/uid.js';

const pvTodayCharts = {};

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
      <span class="pv-today-title" id="${uid('pvt-title', id)}">${escapeHtml(locationName)} — PV Today</span>
    </div>
    <div class="pv-today-summary" id="${uid('pvt-summary', id)}">
      <div class="pvt-metric pvt-left">
        <span class="pvt-value" id="${uid('pvt-generated', id)}">0.0 kWh</span>
        <span class="pvt-label">Generated</span>
      </div>
      <div class="pvt-progress-wrap">
        <div class="pvt-progress-bar" id="${uid('pvt-progress', id)}">
          <div class="pvt-progress-fill" id="${uid('pvt-progress-fill', id)}" style="width:0%"></div>
        </div>
      </div>
      <div class="pvt-metric pvt-right">
        <span class="pvt-value" id="${uid('pvt-remaining', id)}">0.0 kWh</span>
        <span class="pvt-label">Remaining</span>
      </div>
    </div>
    <div class="pv-today-timeline" id="${uid('pvt-timeline', id)}">
      <div class="pvt-timeline-icons" id="${uid('pvt-icons', id)}"></div>
      <div class="pvt-timeline-bar" id="${uid('pvt-timeline-bar', id)}"></div>
    </div>
    <div class="pvt-chart-container" id="${uid('pvt-chart-wrap', id)}">
      <canvas id="${uid('pvt-chart', id)}"></canvas>
    </div>
    <div class="pvt-legend" id="${uid('pvt-legend', id)}">
      <span class="pvt-legend-item"><span class="pvt-legend-line pvt-legend-generated"></span> Generated</span>
      <span class="pvt-legend-item"><span class="pvt-legend-line pvt-legend-predicted"></span> Predicted</span>
      <span class="pvt-legend-item"><span class="pvt-legend-line pvt-legend-now"></span> Now</span>
      <span class="pvt-legend-item"><span class="pvt-legend-line pvt-legend-cloud"></span> Cloud Cover</span>
    </div>
  `;
  return card;
}

export async function updatePvToday(forecastData) {
  const cards = document.querySelectorAll('.pv-today-instance');
  if (!cards.length) return;

  if (!forecastData || forecastData.error || !forecastData.daily || !forecastData.daily.length) {
    cards.forEach(c => c.style.display = 'none');
    return;
  }

  const now = new Date();
  const todayDate = now.toLocaleDateString('en-CA');
  let ti = forecastData.daily.findIndex(d => d.date === todayDate);
  if (ti === -1) ti = 0;
  const today = forecastData.daily[ti];
  const totalForecastKwh = today.total_kwh || 0;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  // Process forecast hourly data for today
  const todayHourly = (forecastData.hourly || [])
    .filter(h => new Date(h.period_end).toLocaleDateString('en-CA') === todayDate)
    .map(h => ({
      x: new Date(h.period_end).getTime(),
      pv: h.pv_estimate || 0,
      cloud: h.cloud_cover != null ? h.cloud_cover : null
    }));

  for (const card of cards) {
    const id = card.dataset.blockId || '';
    const el = (s) => document.getElementById(id ? `${s}-${id}` : s);

    // Read configured metric
    let generatedField = 'solar';
    try { const mm = JSON.parse(card.dataset.metricMap); if (mm.generated) generatedField = mm.generated; } catch (e) {}

    // Fetch intraday data for this card's configured field
    let intradayData = [];
    try {
      const intraRes = await fetch(`/api/solar/intraday?field=${encodeURIComponent(generatedField)}`);
      if (intraRes.ok) intradayData = await intraRes.json();
    } catch (e) {}

    // Compute actual kWh for the configured field from intraday data
    let actualKwh = 0;
    if (intradayData.length > 1) {
      for (let i = 0; i < intradayData.length - 1; i++) {
        const dt = (intradayData[i + 1].timestamp - intradayData[i].timestamp) / 3600;
        actualKwh += ((intradayData[i].watts + intradayData[i + 1].watts) / 2000) * dt;
      }
    }
    // Fallback to forecast's actual_so_far for solar field if intraday is empty
    if (actualKwh === 0 && generatedField === 'solar') actualKwh = today.actual_so_far ?? 0;
    const remKwh = Math.max(0, totalForecastKwh - actualKwh);
    const progPct = totalForecastKwh > 0 ? Math.min(100, (actualKwh / totalForecastKwh) * 100) : 0;

    // Update summary
    const genEl = el('pvt-generated');
    if (genEl) genEl.textContent = actualKwh.toFixed(1) + ' kWh';
    const remEl = el('pvt-remaining');
    if (remEl) remEl.textContent = remKwh.toFixed(1) + ' kWh';
    const fillEl = el('pvt-progress-fill');
    if (fillEl) { fillEl.style.width = progPct + '%'; fillEl.style.transition = 'width 0.6s ease'; }

    // Update timeline strip
    renderTimeline(el('pvt-icons'), el('pvt-timeline-bar'), todayHourly, now, isDark);

    // Update chart
    const canvasId = id ? `pvt-chart-${id}` : 'pvt-chart';
    const canvas = document.getElementById(canvasId);
    if (!canvas) continue;

    const wrap = el('pvt-chart-wrap');
    if (wrap) {
      const rect = wrap.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        canvas.width = rect.width * (window.devicePixelRatio || 1);
        canvas.height = rect.height * (window.devicePixelRatio || 1);
      }
    }

    const ctx = canvas.getContext('2d');

    // Build generated curve: intraday solar wattage, bucketed by hour
    const generatedByHour = bucketIntradayByHour(intradayData, now);
    // Build predicted curve from forecast hourly
    const predictedByHour = todayHourly.map(h => ({ x: h.x, y: h.pv * 1000 })); // kW → W
    // Build cloud cover curve
    const cloudByHour = todayHourly.filter(h => h.cloud != null).map(h => ({ x: h.x, y: h.cloud }));

    // Destroy previous chart
    if (pvTodayCharts[canvasId]) {
      pvTodayCharts[canvasId].destroy();
      pvTodayCharts[canvasId] = null;
    }

    const textColor = isDark ? '#f8fafc' : '#0f172a';
    const mutedColor = isDark ? '#94a3b8' : '#666666';
    const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

    pvTodayCharts[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Generated',
            data: generatedByHour,
            borderColor: '#d8b400',
            backgroundColor: 'rgba(216,180,0,0.15)',
            borderWidth: 2.5,
            tension: 0.4,
            pointRadius: 0,
            fill: true,
            yAxisID: 'y',
            order: 2
          },
          {
            label: 'Predicted',
            data: predictedByHour,
            borderColor: '#d8b400',
            backgroundColor: 'transparent',
            borderWidth: 2,
            borderDash: [6, 5],
            tension: 0.4,
            pointRadius: 0,
            fill: false,
            yAxisID: 'y',
            order: 3
          },
          {
            label: 'Cloud Cover',
            data: cloudByHour,
            borderColor: '#c8cada',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            tension: 0.3,
            pointRadius: 0,
            fill: false,
            yAxisID: 'y1',
            order: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: isDark ? '#1e293b' : '#fff',
            titleColor: textColor,
            bodyColor: textColor,
            borderColor: isDark ? '#334155' : '#e2e8f0',
            borderWidth: 1
          }
        },
        scales: {
          x: {
            type: 'linear',
            min: getHourTimestamp(6),
            max: getHourTimestamp(20),
            ticks: {
              stepSize: 2 * 3600000,
              callback: (val) => new Date(val).getHours(),
              color: mutedColor,
              font: { size: 11 }
            },
            grid: { color: gridColor, drawBorder: false }
          },
          y: {
            type: 'linear',
            position: 'left',
            beginAtZero: true,
            ticks: {
              callback: (val) => val >= 1000 ? (val / 1000).toFixed(0) + 'k' : val,
              color: mutedColor,
              font: { size: 11 }
            },
            grid: { color: gridColor, drawBorder: false }
          },
          y1: {
            type: 'linear',
            position: 'right',
            min: 0,
            max: 100,
            ticks: {
              callback: (val) => val === 0 || val === 50 || val === 100 ? val : '',
              color: '#7d869e',
              font: { size: 10 }
            },
            grid: { display: false }
          }
        }
      },
      plugins: [{
        id: 'nowLine',
        afterDraw(chart) {
          const { ctx, chartArea, scales } = chart;
          const nowX = Date.now();
          if (nowX < scales.x.min || nowX > scales.x.max) return;
          const x = scales.x.getPixelForValue(nowX);
          ctx.save();
          ctx.beginPath();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = '#d94141';
          ctx.lineWidth = 1.5;
          ctx.moveTo(x, chartArea.top);
          ctx.lineTo(x, chartArea.bottom);
          ctx.stroke();
          ctx.restore();
        }
      }]
    });

    // Apply gradient fill to generated curve
    const chart = pvTodayCharts[canvasId];
    if (chart && chart.chartArea) {
      const ca = chart.chartArea;
      const gctx = chart.ctx;
      const grad = gctx.createLinearGradient(0, ca.bottom, 0, ca.top);
      grad.addColorStop(0, 'rgba(216,180,0,0.02)');
      grad.addColorStop(0.6, 'rgba(216,180,0,0.08)');
      grad.addColorStop(1, 'rgba(216,180,0,0.18)');
      chart.data.datasets[0].backgroundColor = grad;
      chart.update();
    }
  }
}

function bucketIntradayByHour(data, now) {
  const buckets = {};
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const row of data) {
    const ts = row.timestamp * 1000;
    const hour = Math.floor((ts - todayStart) / 3600000);
    if (!buckets[hour]) buckets[hour] = [];
    buckets[hour].push(row.watts);
  }
  const result = [];
  for (const [hour, vals] of Object.entries(buckets)) {
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const x = todayStart + parseInt(hour) * 3600000 + 1800000; // middle of hour
    result.push({ x, y: Math.round(avg) });
  }
  result.sort((a, b) => a.x - b.x);
  return result;
}

function getHourTimestamp(hour) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0).getTime();
}

function renderTimeline(iconsEl, barEl, hourly, now, isDark) {
  if (!iconsEl || !barEl) return;

  // Find 4 representative time slots: morning, late morning, afternoon, evening
  const slots = [7, 10, 13, 16, 19];
  const timelineData = slots.map(h => {
    const t = getHourTimestamp(h);
    const entry = hourly.reduce((best, cur) => {
      if (!best || Math.abs(cur.x - t) < Math.abs(best.x - t)) return cur;
      return best;
    }, null);
    return {
      hour: h,
      cloud: entry ? entry.cloud : null
    };
  });

  // Icons
  iconsEl.innerHTML = timelineData.map(d => {
    let icon = '☀️';
    if (d.cloud != null) {
      if (d.cloud > 80) icon = '🌧️';
      else if (d.cloud > 50) icon = '☁️';
      else if (d.cloud > 20) icon = '⛅';
    }
    const label = d.hour + ':00';
    return `<span class="pvt-timeline-icon" title="${label}">${icon}</span>`;
  }).join('');

  // Bar segments
  const colors = timelineData.map(d => {
    if (d.cloud == null) return isDark ? '#475569' : '#c8cada';
    if (d.cloud > 80) return '#7b84a0';
    if (d.cloud > 50) return '#9ca3af';
    if (d.cloud > 20) return '#c8ba78';
    return '#e3c200';
  });

  barEl.innerHTML = colors.map((c, i) => {
    return `<div class="pvt-timeline-seg" style="background:${c};flex:1;height:4px;border-radius:2px;margin:0 1px;"></div>`;
  }).join('');
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
