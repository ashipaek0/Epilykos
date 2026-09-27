import { normalizeSegmentedGauge, segmentedGaugeColor, segmentedGaugeSegmentColors } from '../segmented-gauge-logic.mjs';
const MARKS=[0,15,30,50];
export function buildSegmentedGauge(block={}){
 const cfg=normalizeSegmentedGauge(block.config||{}),root=document.createElement('div');root.className='segmented-gauge-card stat-card';root.dataset.blockId=block.id||'';root.dataset.gaugeConfig=JSON.stringify(cfg);root.dataset.status='no-data';
 const title=document.createElement('div');title.className='stat-label';title.textContent=cfg.label||cfg.binding?.metric||cfg.metric||'State of charge';root.appendChild(title);
 const track=document.createElement('div');track.className='segmented-gauge-track';track.setAttribute('role','meter');track.setAttribute('aria-valuemin',String(cfg.min));track.setAttribute('aria-valuemax',String(cfg.max));
 for(let i=0;i<cfg.segments;i++){const seg=document.createElement('span');seg.className='segmented-gauge-segment';seg.dataset.segment=String(i);seg.style.marginInlineEnd=(i===cfg.segments-1?0:cfg.spacing)+'px';track.appendChild(seg);}
 if(cfg.markers)for(const mark of MARKS){const marker=document.createElement('span');marker.className='segmented-gauge-marker';marker.dataset.marker=String(mark);marker.style.left=`${mark}%`;track.appendChild(marker);}
 if(cfg.endpoint==='point'){const point=document.createElement('span');point.className='segmented-gauge-endpoint';point.dataset.role='endpoint';track.appendChild(point);}
 root.appendChild(track);const value=document.createElement('div');value.className='segmented-gauge-value';value.dataset.role='value';value.textContent='—';root.appendChild(value);
 const fallback=document.createElement('div');fallback.className='segmented-gauge-fallback';fallback.dataset.role='fallback';fallback.hidden=true;root.appendChild(fallback);
 const spark=document.createElement('svg');spark.className=cfg.sparkline==='none'?'segmented-gauge-sparkline-none':'segmented-gauge-sparkline';spark.dataset.role='sparkline';spark.setAttribute('viewBox','0 0 100 24');root.appendChild(spark);return root;
}
export function updateSegmentedGauges(state={}) {
  document.querySelectorAll('.segmented-gauge-card').forEach(root => {
    let cfg={}; try { cfg=JSON.parse(root.dataset.gaugeConfig||'{}'); } catch {}
    const metric=cfg.binding?.metric||cfg.metric;
    const entry=state.metrics?.[metric];
    const raw=entry&&typeof entry==='object'?entry.value:entry;
    const ok=typeof raw==='number'&&Number.isFinite(raw);
    const hasFallback=cfg.fallback?.enabled===true&&Number.isFinite(cfg.fallback.value);
    const value=root.querySelector('.segmented-gauge-value');
    const fallback=root.querySelector('[data-role="fallback"]');
    const meter=root.querySelector('.segmented-gauge-track');
    const point=root.querySelector('[data-role="endpoint"]');
    root.dataset.status=ok?'data':hasFallback?'fallback':'no-data';
    root.dataset.measured=String(ok);
    value.textContent=ok?`${raw} ${cfg.unit||'%'}`:hasFallback?`${cfg.fallback.value} ${cfg.unit||'%'}`:'—';
    fallback.hidden=ok||!hasFallback;
    fallback.textContent=!ok&&hasFallback?'Fallback'+(String(cfg.fallback.label||'').trim()?': '+String(cfg.fallback.label).trim():''):'';
    if(ok) meter.setAttribute('aria-valuenow',String(raw)); else meter.removeAttribute('aria-valuenow');
    const clamped=ok?Math.max(cfg.min,Math.min(cfg.max,raw)):cfg.min;
    const pct=(clamped-cfg.min)/(cfg.max-cfg.min||1)*100;
    if(point){point.hidden=!ok;point.style.left=`${pct}%`;}
    const colors=segmentedGaugeSegmentColors(cfg.min,cfg.max,cfg.segments,cfg.thresholds);
    [...meter.querySelectorAll('.segmented-gauge-segment')].forEach((seg,i)=>{
      const n=cfg.min+(i+1)/cfg.segments*(cfg.max-cfg.min),filled=ok&&n<=clamped;
      seg.dataset.thresholdColor=colors[i]||'neutral'; seg.dataset.filled=String(filled);
      seg.style.backgroundColor=filled?(colors[i]||'var(--amber-400)'):'var(--border)';
    });
    const spark=root.querySelector('[data-role="sparkline"]');
    if(spark){spark.replaceChildren();const series=state.history?.[metric]??state.series?.[metric],samples=cfg.sparkline==='none'?[]:(Array.isArray(series)?series.map(x=>typeof x==='number'?x:Number(x?.value)).filter(Number.isFinite):[]);spark.dataset.samples=String(samples.length);if(samples.length){const lo=Math.min(...samples),hi=Math.max(...samples),span=hi-lo||1,line=document.createElementNS('http://www.w3.org/2000/svg','polyline');line.setAttribute('points',samples.map((n,i)=>`${samples.length===1?50:i*100/(samples.length-1)},${22-(n-lo)/span*20}`).join(' '));line.setAttribute('fill','none');spark.appendChild(line);}}
  });
}
