export function buildChartPower(block = {}) {
  const config = block.config || {};
  const container = document.createElement('div');
  container.className = 'chart-container';
  container.innerHTML = `
    <div class="chart-header">
      <h3>${escapeHtml(config.title || 'Power Overview')}</h3>
      <div class="chart-controls" id="power-chart-controls">
        <button data-range="24h" class="active">24h</button>
        <button data-range="7d">7d</button>
        <button data-range="30d">30d</button>
        <button data-range="90d">90d</button>
      </div>
    </div>
    <canvas id="powerChart"></canvas>
  `;

  const controls = container.querySelector('#power-chart-controls');
  if (controls) {
    controls.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const range = btn.dataset.range;
      if (range) {
        controls.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        import('../charts.js').then(module => {
          module.setPowerRange(range, config.datasets);
        });
      }
    });
  }
  return container;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
