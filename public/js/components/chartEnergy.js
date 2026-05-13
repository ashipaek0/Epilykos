export function buildChartEnergy() {
  const container = document.createElement('div');
  container.className = 'chart-container';
  container.innerHTML = `<div class="chart-header"><h3>Daily Energy</h3></div><canvas id="energyBarChart"></canvas>`;
  return container;
}
