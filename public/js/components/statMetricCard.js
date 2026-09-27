import { normalizeStatConfig, resolveStat, formatStatValue, statPresentation } from '../stat-parity.mjs';
import { financialValue, formatCurrency, PERIODS, PERIOD_HISTORY_METRICS } from '../periodStat.mjs';
export function buildStatMetricCard(block={}) {
  const cfg=normalizeStatConfig(block.config || {}), root=document.createElement('div');
  root.className='stat-metric-card stat-card'; root.dataset.blockId=block.id || ''; root.dataset.statConfig=JSON.stringify(cfg); root.dataset.status='no-data';
  const label=document.createElement('div'); label.className='stat-label'; label.textContent=cfg.label || cfg.title || cfg.metric || 'Stat'; root.appendChild(label);
  const value=document.createElement('div'); value.className='stat-value'; value.dataset.role='value'; value.textContent='—'; root.appendChild(value);
  const status=document.createElement('div'); status.className='stat-fallback-label'; status.dataset.role='fallback'; status.hidden=true; root.appendChild(status);
  const spark=document.createElement('svg'); spark.className=cfg.sparkline==='none'?'stat-sparkline stat-sparkline-none':'stat-sparkline stat-sparkline-area'; spark.dataset.aggregation='none'; spark.dataset.role='sparkline'; spark.setAttribute('viewBox','0 0 100 24'); spark.setAttribute('aria-hidden','true'); root.appendChild(spark);
  return root;
}
export function updateStatMetricCards(state={}) {
  document.querySelectorAll('.stat-metric-card').forEach(root=>{let cfg={};try{cfg=JSON.parse(root.dataset.statConfig||'{}')}catch{}
    if (cfg.reducer === 'period-sum') return; // handled by updatePeriodStatCards (async, own fetch)
    const result=resolveStat(cfg.binding || {metric:cfg.metric},state.metrics || {},cfg.fallback);
    root.dataset.status=result.status; const value=root.querySelector('[data-role="value"]'), fallback=root.querySelector('[data-role="fallback"]');
    value.textContent=result.status==='no-data'?'—':formatStatValue(result.value,cfg.unit,cfg.precision);
    const presentation=statPresentation(result.value,cfg.thresholds,cfg.colorMode,cfg.fixedColor);
    if(cfg.colorMode==='value') value.style.color=presentation.color || '';
    if(cfg.colorMode==='background') root.style.backgroundColor=presentation.color || '';
    if(fallback){fallback.hidden=result.status!=='fallback';fallback.textContent=result.status==='fallback'?`Fallback${String(result.fallback.label || '').trim()?`: ${String(result.fallback.label).trim()}`:''}`:'';}
    const spark=root.querySelector('[data-role="sparkline"]');
    if(spark){
      spark.dataset.mode=cfg.sparkline;
      const supplied=state.history?.[cfg.binding?.metric || cfg.metric] ?? state.series?.[cfg.binding?.metric || cfg.metric];
      const samples=cfg.sparkline==='none'?[]:(Array.isArray(supplied)?supplied.map(x=>typeof x==='number'?x:Number(x?.value)).filter(Number.isFinite):[]);
      spark.replaceChildren();
      spark.dataset.samples=String(samples.length);
      if(samples.length){const lo=Math.min(...samples), hi=Math.max(...samples), span=hi-lo||1; const points=samples.map((n,i)=>`${samples.length===1?50:i*100/(samples.length-1)},${22-(n-lo)/span*20}`).join(' '); const line=document.createElementNS('http://www.w3.org/2000/svg','polyline'); line.setAttribute('points',points); line.setAttribute('fill','none'); line.setAttribute('vector-effect','non-scaling-stroke'); spark.appendChild(line);}
      else spark.dataset.empty='true';
    }
  });
}

/**
 * Async updater for period-sum stat cards (Phase 5): each card fetches its
 * own /api/period-sum, independent of the polled state.metrics snapshot —
 * same self-fetch pattern as updateMultiSeriesTimeseries(). Never uses
 * /api/metrics/history (7-day cap) for month/year/since-install windows.
 */
export async function updatePeriodStatCards() {
  const cards = Array.from(document.querySelectorAll('.stat-metric-card')).filter(root => {
    try { return JSON.parse(root.dataset.statConfig || '{}').reducer === 'period-sum'; } catch { return false; }
  });
  await Promise.all(cards.map(async root => {
    let cfg = {};
    try { cfg = JSON.parse(root.dataset.statConfig || '{}'); } catch { /* keep {} */ }
    const value = root.querySelector('[data-role="value"]');
    const fallback = root.querySelector('[data-role="fallback"]');
    if (!PERIODS.includes(cfg.period) || !PERIOD_HISTORY_METRICS.includes(cfg.historyMetric)) {
      root.dataset.status = 'no-data';
      if (value) value.textContent = '—';
      return;
    }
    let result;
    try {
      const response = await fetch(`/api/period-sum?period=${encodeURIComponent(cfg.period)}&metric=${encodeURIComponent(cfg.historyMetric)}`);
      if (!response.ok) throw new Error('period-sum request failed');
      result = await response.json();
    } catch {
      result = { status: 'no-data', value: null };
    }
    if (result.status !== 'complete' || result.value === null) {
      root.dataset.status = result.status === 'insufficient-history' ? 'insufficient-history' : 'no-data';
      if (value) value.textContent = result.status === 'insufficient-history' ? 'Insufficient history' : '—';
      if (fallback) {
        fallback.hidden = result.status !== 'insufficient-history' || !result.coverageStart;
        fallback.textContent = fallback.hidden ? '' : `Coverage from ${result.coverageStart}${result.coverageEnd ? ` to ${result.coverageEnd}` : ''}`;
      }
      return;
    }
    let displayValue = result.value;
    let unit = cfg.unit;
    if (cfg.formula) {
      try {
        displayValue = financialValue(cfg.formula, result.value, cfg.formulaParams || {});
      } catch {
        displayValue = null;
      }
    }
    root.dataset.status = displayValue === null ? 'no-data' : 'data';
    if (value) value.textContent = displayValue === null ? '—' : (cfg.formula ? formatCurrency(displayValue, cfg.currency, cfg.precision) : formatStatValue(displayValue, unit, cfg.precision));
    if (fallback) fallback.hidden = true;
  }));
}
