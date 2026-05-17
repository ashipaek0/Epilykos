function normalizeDatasets(datasets) {
  if (!datasets || !datasets.length) {
    return [
      { label: 'Solar Generated', metric: 'daily_solar', color: '#d97706' },
      { label: 'Grid Imported', metric: 'daily_grid_import', color: '#dc2626' },
      { label: 'Energy Consumed', metric: 'daily_consumption', color: '#7c3aed' }
    ];
  }
  if (typeof datasets[0] === 'string') {
    const legacyMap = {
      solar: { label: 'Solar Generated', color: '#d97706' },
      grid_import: { label: 'Grid Imported', color: '#dc2626' },
      consumption: { label: 'Energy Consumed', color: '#7c3aed' },
      battery_charge: { label: 'Battery Charge', color: '#059669' },
      battery_discharge: { label: 'Battery Discharge', color: '#10b981' },
      grid_export: { label: 'Grid Export', color: '#f59e0b' }
    };
    return datasets.map(ds => {
      const base = legacyMap[ds] || { label: ds, color: '#888' };
      return { label: base.label, metric: ds, color: base.color };
    });
  }
  return datasets.map(ds => ({
    label: ds.label || ds.metric || 'Unknown',
    metric: ds.metric || '',
    color: ds.color || '#888'
  }));
}

export function buildChartEnergy(block = {}) {
  const config = block.config || {};
  const datasets = normalizeDatasets(config.datasets);
  block.config.datasets = datasets;

  const container = document.createElement('div');
  container.className = 'chart-container';
  container.dataset.chartDatasets = JSON.stringify(datasets);

  container.innerHTML = `
    <div class="chart-header">
      <h3>${escapeHtml(config.title || 'Daily Energy')}</h3>
      <div class="chart-controls" id="energy-chart-controls">
        <button data-range="7d" class="active">7d</button>
        <button data-range="30d">30d</button>
        <button data-range="90d">90d</button>
      </div>
    </div>
    <canvas id="energyBarChart"></canvas>
  `;

  const controls = container.querySelector('#energy-chart-controls');
  if (controls) {
    controls.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const range = btn.dataset.range;
      if (range) {
        controls.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        import('../charts.js').then(module => {
          module.setEnergyRange(range);
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
