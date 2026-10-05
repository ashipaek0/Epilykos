import { formatMetric } from './format.js';
const STAT_KEYS = ['mean', 'max', 'min', 'last'];
const DEFAULT_COLUMNS = STAT_KEYS.map(key => ({ key, visible: true, label: key[0].toUpperCase() + key.slice(1), precision: null, ...(key === 'last' ? { showTimestamp: true, staleAfterSeconds: 900 } : {}) }));
const ALLOWED_FIELDS = new Set(['pv_power', 'grid_power', 'grid_export_power', 'load_power', 'battery_charge_power', 'battery_discharge_power', 'battery_power']);
const finite = (v, fallback, min, max) => v !== '' && v != null && Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback;
export function normalizePowerStatsConfig(config = {}) {
  const raw = config.stats && typeof config.stats === 'object' ? config.stats : (('enabled' in config || 'columns' in config || 'format' in config) ? config : {});
  const source = Array.isArray(raw.columns) ? raw.columns : DEFAULT_COLUMNS, seen = new Set();
  const columns = source.filter(c => c && STAT_KEYS.includes(c.key) && !seen.has(c.key) && seen.add(c.key)).map(c => ({ ...c, visible: c.visible !== false, label: String(c.label ?? c.key).slice(0, 80), precision: c.precision == null || c.precision === '' ? null : finite(c.precision, null, 0, 6), showTimestamp: c.key === 'last' && c.showTimestamp !== false, staleAfterSeconds: finite(c.staleAfterSeconds, 900, 0, 604800) }));
  const format = { locale: 'auto', grouping: true, zeroDisplay: '0', noData: '—', ...(raw.format || {}) };
  const style = { headerAlign: 'start', labelAlign: 'start', valueAlign: 'end', fontSizePx: 14, fontWeight: 'normal', textColor: 'theme', border: 'subtle', rowSpacingPx: 8, showSwatches: true, tooltip: true, ...(raw.tableStyle || {}) };
  style.fontSizePx = finite(style.fontSizePx, 14, 10, 24); style.rowSpacingPx = finite(style.rowSpacingPx, 8, 0, 32);
  for (const k of ['headerAlign','labelAlign','valueAlign']) if (!['start','center','end'].includes(style[k])) style[k] = k === 'valueAlign' ? 'end' : 'start';
  if (!['normal','bold','500','600','700'].includes(String(style.fontWeight))) style.fontWeight = 'normal';
  style.textColor = style.textColor === 'theme' || /^#[\da-f]{6}$/i.test(style.textColor) ? style.textColor : 'theme';
  if (!['none','subtle','strong'].includes(style.border)) style.border = 'subtle';
  return { ...raw, enabled: raw.enabled === true, titleVisible: raw.titleVisible !== false, title: String(raw.title ?? 'Statistics').slice(0,80), headerVisible: raw.headerVisible !== false, density: ['comfortable','compact'].includes(raw.density) ? raw.density : 'comfortable', overflow: 'local-scroll', columns, includeHiddenSeries: raw.includeHiddenSeries === true, series: raw.series && typeof raw.series === 'object' ? raw.series : {}, format, tableStyle: style };
}
export function formatPowerStat(value, field, options = {}) {
  if (!Number.isFinite(value)) return options.noData || '—';
  const from = field?.unit === 'kW' ? 1000 : 1, to = options.unit === 'kW' ? 1000 : 1, precision = finite(options.precision, 1, 0, 6);
  if (value === 0) return options.zeroDisplay ?? '0';
  try { return new Intl.NumberFormat(options.locale === 'auto' ? undefined : options.locale, { minimumFractionDigits: precision, maximumFractionDigits: precision, useGrouping: options.grouping !== false }).format(value * from / to); } catch { return (value * from / to).toFixed(precision); }
}
const fieldFor = metric => { const m=String(metric||'').toLowerCase(); if (/grid.?export/.test(m)) return 'grid_export_power'; if (/solar|pv/.test(m)) return 'pv_power'; if (/consumption|load/.test(m)) return 'load_power'; if (/grid/.test(m)) return 'grid_power'; if (/battery.?charg/.test(m)) return 'battery_charge_power'; if (/battery.?discharg/.test(m)) return 'battery_discharge_power'; if (/battery/.test(m)) return 'battery_power'; return null; };
const WARNING_LABELS={numeric_overflow:'A statistic exceeded the numeric range and is unavailable.',partial_edge_bucket:'Part of this range is only stored as 5-minute averages, so some figures are left out.',legacy_rollup_lacks_last:'The latest reading for part of this range is not stored.',legacy_rollup_lacks_net_aggregates:'Older battery data has no combined power figures.'};
// Bookkeeping notes from the server that don't need the person's attention.
const QUIET_WARNINGS=new Set(['legacy_missing_zero_possible','no_valid_observations','unsupported_series']);
function humanizeWarning(w){return WARNING_LABELS[w?.code]||String(w?.message||w?.code||'Data quality warning').replace(/_/g,' ');}
function el(tag, text, cls) { const n=document.createElement(tag); if(text!=null)n.textContent=text; if(cls)n.className=cls; return n; }
export function buildPowerStatsSection(config) {
  const cfg=normalizePowerStatsConfig(config), root=el('section',null,'power-stats'); root.hidden=!cfg.enabled; root.setAttribute('aria-label',cfg.title||'Statistics');
  const title=el('h4',cfg.title); title.hidden=!cfg.titleVisible; root.append(title);
  const table=el('table'); table.className=`power-stats-table density-${cfg.density}`; table.setAttribute('aria-label',cfg.title||'Power statistics');
  const head=el('thead'),hr=el('tr'),blank=el('th','Series'); blank.scope='col'; blank.style.textAlign=cfg.tableStyle.labelAlign; hr.append(blank);
  cfg.columns.filter(c=>c.visible).forEach(c=>{const th=el('th',c.label);th.scope='col';th.style.textAlign=cfg.tableStyle.valueAlign;hr.append(th);});head.append(hr);head.hidden=!cfg.headerVisible;table.append(head,el('tbody'));root.append(table);
  const s=cfg.tableStyle; root.style.fontSize=`${s.fontSizePx}px`;root.style.fontWeight=s.fontWeight;root.style.color=s.textColor==='theme'?'':s.textColor;root.style.setProperty('--power-stats-header-align',s.headerAlign);root.style.setProperty('--power-stats-label-align',s.labelAlign);root.style.setProperty('--power-stats-value-align',s.valueAlign);root.style.setProperty('--power-stats-row-spacing',`${s.rowSpacingPx}px`);root.dataset.border=s.border;root.dataset.density=cfg.density;root._config=cfg;return root;
}
export function updatePowerStatsSection(root,response,series,range,options={}) {
  if(!root||!root._config?.enabled)return false;
  const cfg=root._config,body=root.querySelector('tbody');
  const unavailable=message=>{body?.replaceChildren();root.hidden=false;let notice=root.querySelector('.power-stats-unavailable');if(!notice){notice=el('p',null,'power-stats-unavailable');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');root.append(notice);}notice.textContent=message;return false;};
  if(!response||response.schemaVersion!==1||response.range?.from!==range?.from||response.range?.to!==range?.to)return unavailable('Statistics unavailable: response schema or range did not match the selected chart range.');
  root.querySelector('.power-stats-unavailable')?.remove();root.querySelector('.power-stats-warning')?.remove();body?.replaceChildren();const cols=cfg.columns.filter(c=>c.visible),warnings=new Set();
  for(const [index,item] of (series||[]).map((item,index)=>({item,index})).sort((a,b)=>finite(cfg.series[String(a.item.metric||'')]?.order,a.index,-100000,100000)-finite(cfg.series[String(b.item.metric||'')]?.order,b.index,-100000,100000)).map(({item,index})=>[index,item])){
    const identity=String(item.metric||''),f=fieldFor(identity),opts=cfg.series[identity]||{};if(!f||!ALLOWED_FIELDS.has(f)||opts.visible===false||(!cfg.includeHiddenSeries&&options.isHidden?.(index)))continue;
    const datum=response.fields?.[f]||{status:'unsupported',unit:item.unit||'kW'};const tr=el('tr');tr.dataset.datasetIndex=String(index);tr.tabIndex=0;tr.setAttribute('role','button');tr.setAttribute('aria-pressed',String(!options.isHidden?.(index)));tr.setAttribute('aria-label',`${opts.label??item.label??identity}, toggle chart series`);
    tr.addEventListener('click',()=>options.toggleSeries?.(index));tr.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();options.toggleSeries?.(index);}});
    const unit=opts.unit||item.unit||datum.unit||'kW',autoFormat=!opts.unit&&!item.unit&&(opts.precision==null||opts.precision===''),label=el('th',autoFormat?String(opts.label??item.label??identity).slice(0,80):`${String(opts.label??item.label??identity).slice(0,80)} (${unit})`);label.scope='row';label.style.textAlign=cfg.tableStyle.labelAlign;label.style.paddingBlock=`${cfg.tableStyle.rowSpacingPx/2}px`;label.style.borderBottom=cfg.tableStyle.border==='none'?'none':`1px solid ${cfg.tableStyle.border==='strong'?'currentColor':'var(--border, #ddd)'}`;
    if(cfg.tableStyle.showSwatches){const sw=el('span','● ');sw.setAttribute('aria-hidden','true');sw.style.color=options.resolveColor?.(index,item)||item.color||'#777777';label.prepend(sw);}tr.append(label);
    for(const c of cols){const td=el('td');td.style.textAlign=cfg.tableStyle.valueAlign;td.style.paddingBlock=`${cfg.tableStyle.rowSpacingPx/2}px`;td.style.borderBottom=cfg.tableStyle.border==='none'?'none':`1px solid ${cfg.tableStyle.border==='strong'?'currentColor':'var(--border, #ddd)'}`;const value=c.key==='last'?datum.last?.value:datum[c.key];const missing=datum.status==='unsupported'||datum.status==='no_data'||!Number.isFinite(value);let display=missing?cfg.format.noData:(autoFormat&&c.precision==null?(value===0?`${cfg.format.zeroDisplay??'0'} ${datum.unit||'W'}`:formatMetric(value*(datum.unit==='kW'?1000:1),'W').text):`${formatPowerStat(value,datum,{...cfg.format,precision:c.precision ?? (opts.precision == null || opts.precision === '' ? 1 : finite(opts.precision,1,0,6)),unit})} ${unit}`);
      const isStale=c.key==='last'&&Number.isFinite(datum.last?.timestamp)&&c.staleAfterSeconds>0&&(Date.now()/1000-datum.last.timestamp)>c.staleAfterSeconds;const age=Math.max(0,Math.floor(Date.now()/1000-datum.last.timestamp));if(isStale)display+=` (stale, ${age}s old)`;td.textContent=display;
      if(c.key==='last'&&Number.isFinite(datum.last?.timestamp)){const stamp=new Date(datum.last.timestamp*1000).toISOString(),time=el('time',c.showTimestamp?` (${new Date(datum.last.timestamp*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})})`:null);time.dateTime=stamp;time.title=stamp;if(!c.showTimestamp)time.setAttribute('aria-hidden','true');td.append(time);td.title=`Last sample: ${stamp}, ${age} seconds ago${isStale?'; stale':''}`;td.setAttribute('aria-label',`${display}; last sample ${stamp}, ${age} seconds ago${isStale?', stale':''}`);}
      const ws=(datum.fidelity?.warnings||[]).filter(w=>!QUIET_WARNINGS.has(w?.code)).map(humanizeWarning);if(ws.length){ws.forEach(w=>warnings.add(w));td.title=[td.title,`Statistics warning: ${ws.join('; ')}`].filter(Boolean).join('. ');td.setAttribute('aria-label',`${td.getAttribute('aria-label')||td.textContent}; Warning: ${ws.join('; ')}`);}tr.append(td);
    }body.append(tr);
  }
  { let note=root.querySelector('.power-stats-warning'); if(warnings.size){if(!note){note=el('p',null,'power-stats-warning');note.setAttribute('role','status');note.setAttribute('aria-live','polite');root.append(note);}note.textContent=`Data quality: ${[...warnings].join('; ')}`;}else note?.remove(); }
  root.hidden=false;return true;
}
export function createPowerStatsRequestGate(){let revision=0;return{capture(snapshot){return Object.freeze({...snapshot,revision:++revision});},isCurrent(request){return request?.revision===revision;}};}
export {fieldFor as resolvePowerStatsField};
