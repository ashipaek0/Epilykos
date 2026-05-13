export function formatHoursToHM(hours) {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h.toString().padStart(2, '0')}h:${m.toString().padStart(2, '0')}m`;
}

export function formatTimestamp(ts) {
  if (!ts) return 'never';
  const date = new Date(ts);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
           date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}

export function updateGridDate() {
  const dateEl = document.getElementById('grid-date');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
  }
}

export function renderTimelineBar(segments, windowStart, windowEnd) {
  const container = document.getElementById('grid-timeline');
  if (!container) return;
  container.innerHTML = '';
  if (!segments.length) return;
  const totalMs = windowEnd - windowStart;
  if (totalMs <= 0) return;

  const tooltip = document.createElement('div');
  tooltip.className = 'tl-tooltip';
  tooltip.style.display = 'none';
  container.appendChild(tooltip);

  const bar = document.createElement('div');
  bar.className = 'tl-bar';

  segments.forEach(seg => {
    const segStart = Math.max(seg.start, windowStart);
    const segEnd = Math.min(seg.end, windowEnd);
    if (segEnd <= segStart) return;
    const duration = segEnd - segStart;
    const pct = (duration / totalMs) * 100;

    const el = document.createElement('div');
    el.className = 'tl-segment' + (seg.state === 1 ? ' on' : ' off');
    el.style.flexGrow = duration;
    el.style.flexBasis = '0px';
    if (pct >= 4) el.textContent = seg.state === 1 ? 'ON' : 'OFF';

    el.addEventListener('mouseenter', () => {
      tooltip.style.display = 'block';
      tooltip.textContent = `${seg.state === 1 ? 'ON' : 'OFF'} since ${new Date(seg.start).toLocaleString()} until ${segEnd < windowEnd ? new Date(segEnd).toLocaleString() : 'Now'}`;
      const barRect = bar.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      tooltip.style.left = (elRect.left - barRect.left + elRect.width / 2) + 'px';
      tooltip.style.top = (-tooltip.offsetHeight - 8) + 'px';
    });
    el.addEventListener('mouseleave', () => tooltip.style.display = 'none');
    bar.appendChild(el);
  });
  container.appendChild(bar);

  const labelRow = document.createElement('div');
  labelRow.className = 'tl-labels';
  const tickInterval = 4 * 60 * 60 * 1000;
  const firstTick = Math.ceil(windowStart / 3600000) * 3600000;
  for (let t = firstTick; t <= windowEnd; t += tickInterval) {
    const pct = ((t - windowStart) / totalMs) * 100;
    const tick = document.createElement('div');
    tick.className = 'tl-tick';
    tick.style.left = pct + '%';
    const d = new Date(t);
    const timeSpan = document.createElement('span');
    timeSpan.className = 'tl-time';
    timeSpan.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    tick.appendChild(timeSpan);
    if (d.getHours() === 0) {
      const dateSpan = document.createElement('span');
      dateSpan.className = 'tl-date';
      dateSpan.textContent = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
      tick.appendChild(dateSpan);
    }
    labelRow.appendChild(tick);
  }
  container.appendChild(labelRow);
}
