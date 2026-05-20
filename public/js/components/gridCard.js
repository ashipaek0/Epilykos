import { renderTimelineBar, formatHoursToHM, updateGridDate, formatTimestamp } from '../grid.js';
import { uid } from '../utils/uid.js';

export function buildGridCard(block = {}) {
  const id = block.id || '';
  const config = block.config || {};
  const showTimeline = config.showTimeline !== false;
  const metrics = config.metrics || {};
  const gridStatusMetric = metrics.grid_status || '';
  const card = document.createElement('div');
  card.className = 'grid-card';
  card.dataset.metricMap = JSON.stringify({ grid_status: gridStatusMetric });
  card.dataset.blockId = id;
  card.innerHTML = `<div class="grid-date" id="${uid('grid-date',id)}"></div><div class="grid-stats"><div class="stat-card"><div class="stat-label">Grid Status</div><div class="stat-value" id="${uid('grid-state',id)}">--</div><div class="stat-sub" id="${uid('grid-state-since',id)}" style="font-size:0.75rem;margin-top:0.25rem;"></div></div><div class="stat-card"><div class="stat-label">Today's Grid</div><div class="stat-value" id="${uid('grid-hours-day',id)}">--</div></div><div class="stat-card"><div class="stat-label">This Week</div><div class="stat-value" id="${uid('grid-hours-week',id)}">--</div></div><div class="stat-card"><div class="stat-label">This Month</div><div class="stat-value" id="${uid('grid-hours-month',id)}">--</div></div><div class="stat-card"><div class="stat-label">This Year</div><div class="stat-value" id="${uid('grid-hours-year',id)}">--</div></div></div>${showTimeline?`<div id="${uid('grid-timeline',id)}"></div>`:''}`;
  return card;
}

export function updateGridCardFromState(state) {
  if (!state) return;
  document.querySelectorAll('.grid-card').forEach(card => {
    const id = card.dataset.blockId || '';
    let mm; try{mm=JSON.parse(card.dataset.metricMap);}catch(e){mm={grid_status:''};}
    const gsm = mm.grid_status; let cs, lct;
    if (gsm && state.metrics && state.metrics[gsm] !== undefined) {
      cs = (state.metrics[gsm]?.value) > 0;
      lct = cs ? state.gridStatus?.lastOn : state.gridStatus?.lastOff;
    } else if (gsm) {
      const e = document.getElementById(uid('grid-state',id)); if (e) e.textContent = 'No data'; return;
    } else if (state.gridStatus && state.gridStatus.configured) {
      cs = state.gridStatus.current; lct = cs ? state.gridStatus.lastOn : state.gridStatus.lastOff;
    } else {
      const e = document.getElementById(uid('grid-state',id)); if (e) e.textContent = 'Not configured'; return;
    }
    const se = document.getElementById(uid('grid-state', id));
    if (se) { se.textContent = `⚡ ${cs?'ON':'OFF'}`; se.style.color = cs ? 'var(--battery)' : 'var(--grid)'; }
    const si = document.getElementById(uid('grid-state-since', id));
    if (si) si.textContent = lct ? `since ${formatTimestamp(lct)}` : '';
    const gh = state.gridHours || {};
    ['grid-hours-day','grid-hours-week','grid-hours-month','grid-hours-year'].forEach((k,i) => { const e = document.getElementById(uid(k,id)); if (e) e.textContent = formatHoursToHM(Object.values(gh)[i] || 0); });
    updateGridDate(id);
    const te = document.getElementById(uid('grid-timeline', id));
    if (te && state.gridTimeline && state.gridTimeline.segments) renderTimelineBar(state.gridTimeline.segments, state.gridTimeline.windowStart, state.gridTimeline.windowEnd, id);
  });
}
