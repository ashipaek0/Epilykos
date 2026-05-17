function normalizeDatasets(datasets) {
  if (!datasets || !datasets.length) {
    return [
      { label: 'Load', metric: 'consumption', color: '#7c3aed' },
      { label: 'Solar', metric: 'solar', color: '#d97706' },
      { label: 'Battery Charge', metric: 'battery_charge', color: '#059669' },
      { label: 'Grid Import', metric: 'grid_import', color: '#dc2626' }
    ];
  }
  // Legacy string array → convert to object format
  if (typeof datasets[0] === 'string') {
    const legacyMap = {
      load: { label: 'Load', color: '#7c3aed' },
      solar: { label: 'Solar', color: '#d97706' },
      battery_charge: { label: 'Battery Charge', color: '#059669' },
      grid_import: { label: 'Grid Import', color: '#dc2626' },
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

export function buildChartPower(block = {}) {
  const config = block.config || {};
  const datasets = normalizeDatasets(config.datasets);
  block.config.datasets = datasets;

  const container = document.createElement('div');
  container.className = 'chart-container';
  container.dataset.chartDatasets = JSON.stringify(datasets);

  container.innerHTML = `
    <div class="chart-header">
      <h3>${escapeHtml(config.title || 'Power Overview')}</h3>
      <div class="chart-controls" id="power-chart-controls">
        <button data-range="24h" class="active">24h</button>
        <button data-range="3d">3d</button>
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
          module.setPowerRange(range, datasets);
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
