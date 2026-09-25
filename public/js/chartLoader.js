/**
 * Lazy Chart.js loader shared by every card that draws a chart (power/energy/
 * metric charts, forecast sparklines, PV Today, weather mini-charts). Cards
 * await ensureChartJS() before `new Chart(...)`, so a dashboard with only
 * forecast/weather cards still gets its charts.
 *
 * @module chartLoader
 */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

let chartJSLoading = null;
/** Ensure Chart.js + the date adapter are loaded (idempotent). */
export function ensureChartJS() {
  if (!chartJSLoading) {
    chartJSLoading = loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js')
      .then(() => loadScript('https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js'))
      .catch((e) => { chartJSLoading = null; throw e; });
  }
  return chartJSLoading;
}
