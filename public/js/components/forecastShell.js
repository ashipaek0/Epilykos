/**
 * Shared markup for the solar forecast cards (banner, info, sparkline).
 * Everything is addressed by class inside the card (no page-global ids), so
 * any number of instances can live on one dashboard. forecast.js fills it.
 */
import { escapeHtml } from '../utils.js';

/**
 * @param {object} block dashboard block
 * @param {{ kind: string, instanceClass: string, summary: boolean, chart: boolean, defaultTitle: string }} opts
 */
export function buildForecastShell(block, opts) {
  const id = block.id || '';
  const config = block.config || {};
  const metrics = config.metrics || {};
  const card = document.createElement('div');
  card.className = `fc-card fc-${opts.kind} ${opts.instanceClass}`;
  card.dataset.blockId = id;
  card.dataset.metricMap = JSON.stringify({ actual_energy: metrics.actual_energy || 'solar_kw' });
  const title = config.title && config.title.trim() ? config.title : opts.defaultTitle;

  card.innerHTML = `
    <header class="fc-head">
      <h3 class="fc-title">${escapeHtml(title)}</h3>
      <span class="fc-when"><span class="fc-date"></span><span class="fc-clock"></span></span>
    </header>
    <div class="forecast-inline-error fc-error" role="alert" hidden></div>
    <div class="fc-body">
      ${opts.summary ? `
      <section class="fc-today">
        <div class="fc-today-label">Today</div>
        <div class="fc-today-value">-- kWh</div>
        <div class="fc-today-sub"></div>
        <div class="fc-progress" hidden><span></span></div>
      </section>
      <section class="fc-now" hidden>
        <span class="fc-now-icon"></span>
        <div class="fc-now-text">
          <div class="fc-now-temp">--°</div>
          <div class="fc-now-desc"></div>
          <div class="fc-now-extra"></div>
        </div>
      </section>
      <section class="fc-days"></section>` : ''}
      ${opts.chart ? `
      <section class="fc-chart">
        <canvas aria-label="Actual vs forecast solar power today"></canvas>
        <div class="fc-chart-empty" hidden>No forecast for today</div>
      </section>` : ''}
    </div>
    <span class="forecast-source fc-source"></span>
  `;
  return card;
}
