export function buildChartEnergy() {
  const container = document.createElement('div');
  container.className = 'chart-container';
  container.innerHTML = `
    <div class="chart-header">
      <h3>Daily Energy</h3>
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
