import { normalizeStatConfig, resolveStat, formatStatValue, statPresentation } from '../stat-parity.mjs';
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
