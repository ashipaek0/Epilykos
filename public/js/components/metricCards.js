export function buildMetricCards(block) {
  if (!block.cards || !block.cards.length) return document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  grid.id = 'dynamic-stats-grid';
  block.cards.forEach(card => {
    const cardEl = document.createElement('div');
    cardEl.className = 'stat-card';
    cardEl.id = `dynamic-card-${card.id}`;
    cardEl.innerHTML = `<div class="stat-label">${card.title}</div><div class="stat-value" id="val-${card.id}">-- ${card.unit || ''}</div>`;
    grid.appendChild(cardEl);
  });
  return grid;
}

export function updateMetricCardsFromState(state) {
  if (!state || !state.metrics) return;
  // Need access to dashboardConfig to find metric cards
  // We'll import dashboardConfig dynamically
  import('../dashboard.js').then(({ dashboardConfig }) => {
    const activeLayout = dashboardConfig.dashboards.find(db => db.id === dashboardConfig.activeDashboard)?.layout;
    if (!activeLayout) return;
    const metricCardsBlock = activeLayout.find(b => b.type === 'metric-cards');
    if (!metricCardsBlock || !metricCardsBlock.cards) return;
    metricCardsBlock.cards.forEach(card => {
      const data = state.metrics[card.metric];
      const cardEl = document.getElementById(`dynamic-card-${card.id}`);
      if (!cardEl) return;
      if (data) {
        cardEl.style.display = '';
        const valEl = document.getElementById(`val-${card.id}`);
        if (valEl) valEl.textContent = `${data.value.toFixed(1)} ${card.unit || ''}`;
      } else {
        cardEl.style.display = 'none';
      }
    });
  });
}
