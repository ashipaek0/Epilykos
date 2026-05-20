export function buildMetricCards(block) {
  if (!block.cards || !block.cards.length) return document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  grid.dataset.blockId = block.id || '';

  block.cards.forEach(card => {
    const cardEl = document.createElement('div');
    cardEl.className = 'stat-card';
    cardEl.dataset.metric = card.metric || '';
    cardEl.innerHTML = `<div class="stat-label">${escapeHtml(card.title)}</div><div class="stat-value">-- ${escapeHtml(card.unit || '')}</div>`;
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
      const blocks = activeLayout.filter(b => b.type === 'metric-cards');
      blocks.forEach(block => {
        if (!block.cards) return;
        const grid = document.querySelector(`.stats-grid[data-block-id="${block.id}"]`);
        if (!grid) return;
        const cards = grid.querySelectorAll('.stat-card');
        block.cards.forEach((card, i) => {
          if (!card.metric) return;
          const data = state.metrics[card.metric];
          if (data && typeof data.value === 'number' && !isNaN(data.value)) {
            if (cards[i]) {
              const valEl = cards[i].querySelector('.stat-value');
              if (valEl) valEl.textContent = `${data.value.toFixed(1)} ${card.unit || ''}`;
            }
          }
        });
      });
    } catch (e) {
      console.error('Metric cards update error:', e);
    }
  }).catch(e => console.error('Metric cards import error:', e));
}
