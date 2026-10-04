import { normalizeMetricTrendConfig, trendValueFromState, formatTrendValue, historyTrendPath, historyTrendAreaPath, historyUrl, forecastValue, forecastGraphPoints, serverForecastDate } from './metricTrendLogic.js';
import { getSharedForecastData } from '../forecast.js';
import { icon as renderIcon } from '../editor-catalog.js';

const NS = 'http://www.w3.org/2000/svg';
const REQUEST_TTL = 30_000;
const historyRequests = new Map();
const forecastRequests = new Map();
let sequence = 0;
const set = (root, selector, value) => { const el = root.querySelector(selector); if (el) el.textContent = value; };
function requestForecast(source, restMap) {
  source=source==='default'?'auto':source||'auto';
  const key=JSON.stringify([source,restMap||{}]), now=Date.now(), cached=forecastRequests.get(key);
  if(cached&&(cached.promise||now-cached.time<REQUEST_TTL))return cached;
  const record={time:now,data:null,promise:null};
  record.promise=getSharedForecastData(source||'auto',restMap||{}).then(data=>{record.data=data;record.time=Date.now();return data;}).catch(error=>{if(forecastRequests.get(key)===record)forecastRequests.delete(key);throw error;}).finally(()=>{record.promise=null;});
  forecastRequests.set(key,record);while(forecastRequests.size>16)forecastRequests.delete(forecastRequests.keys().next().value);return record;
}
function requestHistory(metric, window) {
  const key = `${metric}|${window}`, now = Date.now(), cached = historyRequests.get(key);
  if (cached && (cached.promise || now - cached.time < REQUEST_TTL)) return cached;
  const record = { time: now, data: null, promise: null };
  record.promise = fetch(historyUrl(metric, window)).then(r => { if (!r.ok) throw new Error(`history ${r.status}`); return r.json(); }).then(data => { record.data = Array.isArray(data) ? data : []; record.time = Date.now(); return record.data; }).catch(error => { if(historyRequests.get(key)===record)historyRequests.delete(key); throw error; }).finally(()=>{record.promise=null;});
  historyRequests.set(key,record); while(historyRequests.size>32)historyRequests.delete(historyRequests.keys().next().value); return record;
}
function setStyle(el, property, value) { if (value !== '' && value != null) el.style[property] = value; }
function makeNode(tag, className, text) { const el=document.createElement(tag); el.className=className; if(text!=null)el.textContent=text; return el; }
export function buildMetricTrendCard(block = {}) {
  const c=normalizeMetricTrendConfig(block.config), root=document.createElement('article');
  root.className='metric-trend-card stat-card'; root.dataset.blockId=block.id||''; root.dataset.config=JSON.stringify(c); root.dataset.instanceId=`metric-trend-${++sequence}`;
  root.style.minWidth='0'; root.style.overflow='hidden'; root.style.boxSizing='border-box'; root.style.borderRadius=`${c.style.radius}px`; root.style.padding='0'; root.style.display='flex'; root.style.flexDirection='column';
  if(c.style.padding)root.style.setProperty('--metric-trend-padding',`${c.style.padding}px`);
  if(c.style.borderColor&&c.style.borderWidth){root.style.borderColor=c.style.borderColor;root.style.borderWidth=`${c.style.borderWidth}px`;root.style.borderStyle='solid';}
  if(c.preset==='subtle-area')root.classList.add('metric-trend-subtle-area');else root.classList.add('metric-trend-filled-body');
  const header=makeNode('header','metric-trend-header'); setStyle(header,'backgroundColor',c.style.headerColor); setStyle(header,'color',c.style.headerTextColor); header.style.padding=`${c.style.padding}px`; header.style.display='flex'; header.style.alignItems='center'; header.style.gap='8px';
  if(c.icon){const icon=makeNode('span','metric-trend-icon'); icon.innerHTML=renderIcon(c.icon,20); header.append(icon);}
  const title=makeNode('span','metric-trend-title',c.title||c.value.metric||'Metric'); header.append(title);
  const body=makeNode('div','metric-trend-body'); body.style.padding=`${c.style.padding}px`; body.style.flex='1'; body.style.minHeight='0';
  if(c.style.bodyFill){body.style.backgroundColor=c.style.bodyFill;if(c.style.bodyFillEnd)body.style.backgroundImage=`linear-gradient(${c.style.gradientAngle}deg, ${c.style.bodyFill}, ${c.style.bodyFillEnd})`;}
  const readout=makeNode('div','metric-trend-readout'); readout.style.textAlign=c.display.align; if(c.display.compact)readout.classList.add('is-compact');
  const value=makeNode('span','metric-trend-value','—'); value.style.fontSize=`${c.display.valueFontSize}px`; setStyle(value,'color',c.style.valueColor);
  const unit=makeNode('span','metric-trend-unit'); unit.style.fontSize=`${c.display.unitFontSize}px`; setStyle(unit,'color',c.style.unitColor);
  const status=makeNode('span','metric-trend-status',''); readout.append(value,unit,status);
  const context=makeNode('div','metric-trend-context');
  const graphWrap=makeNode('div','metric-trend-graph-wrap'); graphWrap.hidden=!(c.graph.enabled&&c.graph.source!=='none');
  const svg=document.createElementNS(NS,'svg'); svg.setAttribute('viewBox','0 0 100 50'); svg.setAttribute('preserveAspectRatio','none'); svg.setAttribute('role','img'); svg.classList.add('metric-trend-graph');
  const area=document.createElementNS(NS,'path'); area.classList.add('metric-trend-area'); const line=document.createElementNS(NS,'path'); line.classList.add('metric-trend-line'); const marker=document.createElementNS(NS,'circle'); marker.classList.add('metric-trend-marker'); marker.setAttribute('r','1.8'); marker.setAttribute('display','none'); svg.append(area,line,marker); graphWrap.append(svg,makeNode('span','metric-trend-graph-unit'));
  body.append(readout,context,graphWrap); root.append(header,body); root._metricTrendGeneration=0; root._metricTrendKey=''; return root;
}
function paint(root,c,points,unit,meaning){
  const svg=root.querySelector('.metric-trend-graph'), line=root.querySelector('.metric-trend-line'), area=root.querySelector('.metric-trend-area'), marker=root.querySelector('.metric-trend-marker');
  if(!svg||!line||!area)return;
  const range=c.graph.scale==='manual'&&c.graph.validScale?{min:c.graph.min,max:c.graph.max}:null;
  const d=historyTrendPath(points,100,50,range); line.setAttribute('d',d); line.setAttribute('fill','none'); line.setAttribute('stroke-width',String(c.graph.lineWidth));
  if(c.style.graphLineColor)line.setAttribute('stroke',c.style.graphLineColor); else line.removeAttribute('stroke');
  area.setAttribute('d',c.graph.lineStyle==='area'?historyTrendAreaPath(d):''); if(c.style.graphFillColor)area.setAttribute('fill',c.style.graphFillColor); else area.removeAttribute('fill'); area.setAttribute('fill-opacity',String(c.style.graphFillOpacity));
  if(marker){const endpoint=[...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].at(-1);if(c.graph.marker&&endpoint){marker.setAttribute('cx',endpoint[1]);marker.setAttribute('cy',endpoint[2]);marker.setAttribute('display','');}else marker.setAttribute('display','none');}
  const label=root.querySelector('.metric-trend-context'); label.textContent=meaning==='forecast'?'Forecast':'Historical'; const unitNode=root.querySelector('.metric-trend-graph-unit'); if(unitNode)unitNode.textContent=unit||'';
  svg.setAttribute('aria-label',`${meaning==='forecast'?'Forecast':'Historical'} graph${unit?` in ${unit}`:''}`);
}
async function refreshGraph(root,c,graphUnit=''){
  if(!c.graph.enabled||c.graph.source==='none'||!root.isConnected)return;
  const key=c.graph.source==='metric-history'?`${c.graph.metric}|${c.graph.window}`: `forecast|${c.graph.forecastSource}|${c.graph.forecastPeriod}|${JSON.stringify(c.graph.restMap)}`;
  if(root._metricTrendKey!==key){root._metricTrendKey=key;root._metricTrendGeneration++;paint(root,c,[], '',c.graph.source==='solar-forecast'?'forecast':'historical');}
  const generation=root._metricTrendGeneration;
  try{
    if(c.graph.source==='metric-history'){
      if(!c.graph.metric)return; const record=requestHistory(c.graph.metric,c.graph.window), points=record.promise?await record.promise:record.data||[];
      if(root.isConnected&&root._metricTrendGeneration===generation)paint(root,c,points,graphUnit, 'historical');
    } else if(c.graph.source==='solar-forecast'){
      const record=requestForecast(c.graph.forecastSource,c.graph.restMap), data=record.promise?await record.promise:record.data; const day=serverForecastDate(data);
      if(!day)return; const points=forecastGraphPoints(data,c.graph.forecastPeriod,day);
      if(root.isConnected&&root._metricTrendGeneration===generation)paint(root,c,points,'kWh','forecast');
    }
  }catch(_){if(root.isConnected&&root._metricTrendGeneration===generation)paint(root,c,[],'',c.graph.source==='solar-forecast'?'forecast':'historical');}
}
export function updateMetricTrendCards(state = {}) {
  document.querySelectorAll('.metric-trend-card').forEach(root=>{
    let c;try{c=normalizeMetricTrendConfig(JSON.parse(root.dataset.config||'{}'));}catch(_){c=normalizeMetricTrendConfig();}
    const valueNode=root.querySelector('.metric-trend-value'),unitNode=root.querySelector('.metric-trend-unit'),statusNode=root.querySelector('.metric-trend-status');
    if(c.value.source==='metric'){
      if(root._metricTrendValueKey!=='metric'){root._metricTrendValueKey='metric';root._metricTrendValueGeneration=(root._metricTrendValueGeneration||0)+1;}
      const entry=state?.metrics?.[c.value.metric], raw=trendValueFromState(state,c), shown=raw===null?null:formatTrendValue(raw,c.value.unit||entry?.unit||'',c.display.precision,c.display.compact);
      if(valueNode)valueNode.textContent=shown?.value||'—';if(unitNode)unitNode.textContent=shown?.unit||'';
      if(statusNode)statusNode.textContent=raw===null?(entry?.quality==='stale'?'Stale':'Unavailable'):'';
    } else {
      const key=`value|${c.value.forecastSource}|${c.value.forecastValue}|${JSON.stringify(c.value.restMap)}`;
      if(root._metricTrendValueKey!==key){root._metricTrendValueKey=key;root._metricTrendValueGeneration=(root._metricTrendValueGeneration||0)+1;}
      const generation=root._metricTrendValueGeneration;
      if(statusNode)statusNode.textContent='Loading';if(valueNode)valueNode.textContent='—';if(unitNode)unitNode.textContent='';
      const record=requestForecast(c.value.forecastSource,c.value.restMap);
      Promise.resolve(record.promise||record.data).then(data=>{
        if(!root.isConnected||root._metricTrendValueGeneration!==generation)return;
        const date=serverForecastDate(data), raw=forecastValue(data,c.value.forecastValue,date);
        const formatted=raw===null?null:formatTrendValue(raw,'kWh',c.display.precision,c.display.compact);
        if(valueNode)valueNode.textContent=formatted?.value||'—';if(unitNode)unitNode.textContent=formatted?.unit||'';if(statusNode)statusNode.textContent=formatted?'': 'Unavailable';
      }).catch(()=>{if(root.isConnected&&root._metricTrendValueGeneration===generation&&statusNode)statusNode.textContent='Unavailable';});
    }
    if(c.graph.enabled&&c.graph.source!=='none'&&(root._metricTrendKey!== (c.graph.source==='metric-history'?`${c.graph.metric}|${c.graph.window}`:`forecast|${c.graph.forecastSource}|${c.graph.forecastPeriod}|${JSON.stringify(c.graph.restMap)}`)||Date.now()-(root._metricTrendRefreshAt||0)>=REQUEST_TTL)){root._metricTrendRefreshAt=Date.now();const graphMetric=state?.metrics?.[c.graph.metric];refreshGraph(root,c,graphMetric?.unit||'');}
    if(!c.graph.enabled||c.graph.source==='none'){root._metricTrendGeneration++;root._metricTrendKey='';}
  });
}
