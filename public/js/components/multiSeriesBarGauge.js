import { normalizeGaugeSeries, gaugeValue, gaugeFillPercent, gaugeColor } from '../multiSeriesBarGauge.mjs';
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;}
export function buildMultiSeriesBarGauge(block={}){const cfg=block.config||{},root=el('section','multi-series-bar-gauge');root.dataset.blockId=block.id||'';root.dataset.chartConfig=JSON.stringify(cfg);root.dataset.qaFamily='multi-series-bar-gauge';root.append(el('h3','',cfg.title||'Multi-series bar gauge'));for(const s of normalizeGaugeSeries(cfg.series||[])){const row=el('div','msbg-row');row.append(el('div','msbg-label',s.label||s.binding.metric||'—'));const track=el('div','msbg-track');track.setAttribute('role','meter');track.setAttribute('aria-label',s.label||s.binding.metric);const fill=el('div','msbg-fill');fill.dataset.metric=s.binding.metric;track.append(fill);row.append(track,el('div','msbg-value','—'));root.append(row);}return root;}
/** Synchronous update from already-fetched dashboard state (matches sibling components' state-driven pattern — no per-card network calls). */
export function updateMultiSeriesBarGauge(state){
  const metrics=(state&&state.metrics)||{};
  for(const root of document.querySelectorAll('.multi-series-bar-gauge')){
    const cfg=JSON.parse(root.dataset.chartConfig||'{}'),series=normalizeGaugeSeries(cfg.series||[]);
    for(let i=0;i<series.length;i++){
      const s=series[i],row=root.children[i+1],valueNode=row?.querySelector('.msbg-value'),fill=row?.querySelector('.msbg-fill');
      if(!valueNode||!fill)continue;
      const v=gaugeValue(s,metrics);
      if(v.status!=='data'){valueNode.textContent='—';fill.style.width='0%';fill.style.backgroundColor='';row.dataset.status='no-data';continue;}
      valueNode.textContent=`${v.value.toFixed(s.decimals)}${s.unit?` ${s.unit}`:''}`;
      fill.style.width=`${gaugeFillPercent(v.value,s.min,s.max)}%`;
      fill.style.backgroundColor=gaugeColor(v.value,s.max,cfg.palette);
      row.dataset.status='data';
    }
  }
}
