import { renderTimelineBar, formatHoursToHM, updateGridDate, formatTimestamp } from '../grid.js';

export function buildGridCard(block = {}) {
  const config = block.config || {};
  const showTimeline = config.showTimeline !== false;
  const metrics = config.metrics || {};
  const gridStatusMetric = metrics.grid_status || '';

  const card = document.createElement('div');
  card.className = 'grid-card';
  card.dataset.metricMap = JSON.stringify({ grid_status: gridStatusMetric });

  card.innerHTML = `
    <div class="grid-date" id="grid-date"></div>
    <div class="grid-stats">
      <div class="stat-card">
        <div class="stat-label">Grid Status</div>
        <div class="stat-value" id="grid-state">--</div>
        <div class="stat-sub" id="grid-state-since" style="font-size: 0.75rem; margin-top: 0.25rem;"></div>
      </div>
      <div class="stat-card"><div class="stat-label">Today's Grid</div><div class="stat-value" id="grid-hours-day">--</div></div>
      <div class="stat-card"><div class="stat-label">This Week</div><div class="stat-value" id="grid-hours-week">--</div></div>
      <div class="stat-card"><div class="stat-label">This Month</div><div class="stat-value" id="grid-hours-month">--</div></div>
      <div class="stat-card"><div class="stat-label">This Year</div><div class="stat-value" id="grid-hours-year">--</div></div>
    </div>
    ${showTimeline ? '<div id="grid-timeline"></div>' : ''}
  `;
  return card;
}

export function updateGridCardFromState(state) {
  if (!state) return;
  const card = document.querySelector('.grid-card');
  if (!card) return;

  // Check if a local metric override is configured
  let metricsMap;
  try {
    metricsMap = JSON.parse(card.dataset.metricMap);
  } catch (e) {
    metricsMap = { grid_status: '' };
  }

  const gridStatusMetric = metricsMap.grid_status;
  let currentState, lastChangeTimestamp;

  if (gridStatusMetric && state.metrics && state.metrics[gridStatusMetric] !== undefined) {
    // Use configured metric for grid status
    const val = state.metrics[gridStatusMetric]?.value;
    currentState = val > 0;
    lastChangeTimestamp = null; // can't determine from single metric value
  } else if (state.gridStatus && state.gridStatus.configured) {
    // Fall back to backend grid status
    const gs = state.gridStatus;
    currentState = gs.current;
    lastChangeTimestamp = gs.current ? gs.lastOn : gs.lastOff;
  } else {
    document.getElementById('grid-state').textContent = 'Not configured';
    const sinceEl = document.getElementById('grid-state-since');
    if (sinceEl) sinceEl.textContent = '';
    return;
  }

  const displayState = currentState ? 'ON' : 'OFF';
  document.getElementById('grid-state').textContent = `⚡ ${displayState}`;
  document.getElementById('grid-state').style.color = currentState ? 'var(--battery)' : 'var(--grid)';

  const sinceEl = document.getElementById('grid-state-since');
  if (sinceEl) {
    if (lastChangeTimestamp) {
      sinceEl.textContent = `since ${formatTimestamp(lastChangeTimestamp)}`;
    } else {
      sinceEl.textContent = '';
    }
  }

  const gh = state.gridHours || {};
  document.getElementById('grid-hours-day').textContent = formatHoursToHM(gh.day || 0);
  document.getElementById('grid-hours-week').textContent = formatHoursToHM(gh.week || 0);
  document.getElementById('grid-hours-month').textContent = formatHoursToHM(gh.month || 0);
  document.getElementById('grid-hours-year').textContent = formatHoursToHM(gh.year || 0);
  updateGridDate();

  const timelineContainer = document.getElementById('grid-timeline');
  if (timelineContainer && state.gridTimeline && state.gridTimeline.segments) {
    renderTimelineBar(state.gridTimeline.segments, state.gridTimeline.windowStart, state.gridTimeline.windowEnd);
  }
}
