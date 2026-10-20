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
let chartJSLoaded = false;
/** True once Chart.js and its date adapter have both loaded. */
export function chartJSReady() { return chartJSLoaded; }
/** Ensure Chart.js + the date adapter are loaded (idempotent). */
export function ensureChartJS() {
  if (!chartJSLoading) {
    chartJSLoading = loadScript('/vendor/chartjs/chart.umd.js')
      .then(() => loadScript('/vendor/chartjs-adapter-date-fns/chartjs-adapter-date-fns.bundle.min.js'))
      .then(() => { chartJSLoaded = true; })
      .catch((e) => { chartJSLoading = null; throw e; });
  }
  return chartJSLoading;
}
