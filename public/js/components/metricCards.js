export function buildMetricCards(block) {
  if (!block.cards || !block.cards.length) return document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  grid.id = 'dynamic-stats-grid';
  block.cards.forEach(card => {
    const cardEl = document.createElement('div');
    cardEl.className = 'stat-card';
    cardEl.id = `dynamic-card-${card.id}`;
    cardEl.dataset.metric = card.metric || '';
    cardEl.innerHTML = `<div class="stat-label">${escapeHtml(card.title)}</div><div class="stat-value" id="val-${card.id}">-- ${escapeHtml(card.unit || '')}</div>`;
    grid.appendChild(cardEl);
  });
  return grid;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function updateMetricCardsFromState(state) {
  if (!state || !state.metrics) return;
  import('../dashboard.js').then(({ dashboardConfig }) => {
    try {
      const activeLayout = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
      if (!activeLayout) return;
      const metricCardsBlock = activeLayout.find(b => b.type === 'metric-cards');
      if (!metricCardsBlock || !metricCardsBlock.cards) return;
      metricCardsBlock.cards.forEach(card => {
        const valEl = document.getElementById(`val-${card.id}`);
        if (!valEl) return;
        const data = state.metrics[card.metric];
        if (data && typeof data.value === 'number' && !isNaN(data.value)) {
          valEl.textContent = `${data.value.toFixed(1)} ${card.unit || ''}`;
        }
        // Leave "--" placeholder if no data — don't hide the card
      });
    } catch (e) {
      console.error('Metric cards update error:', e);
    }
  }).catch(e => console.error('Metric cards import error:', e));
}
