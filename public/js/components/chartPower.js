export function buildChartPower() {
  const container = document.createElement('div');
  container.className = 'chart-container';
  container.innerHTML = `<div class="chart-header"><h3>Power Overview</h3></div><canvas id="powerChart"></canvas>`;
  return container;
}
