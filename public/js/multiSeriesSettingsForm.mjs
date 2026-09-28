import { normalizeMultiSeriesSettings } from './multiSeriesTimeseriesSettings.mjs';
import { normalizeBarGaugeSettings } from './multiSeriesBarGaugeSettings.mjs';
import { clone, getField, setField, timeseriesFields, gaugeFields, timeseriesGlobals, gaugeGlobals, axisFields, thresholdFields, calculations } from './multiSeriesSchema.mjs';

// Pure serialization also used by the DOM reader. An untouched optional field
// stays absent (or null), and nested future fields survive every edit.
export function serializeFields(original, values, fields) {
  const result=clone(original);
  for (const [key, raw] of Object.entries(values)) {
    const field=fields[key];
    if (!field) continue;
    let value=field.type==='select' && raw==='' ? null : raw;
    if (field.type==='number') {
      if (raw === '' && field.default === undefined) value=null;
      else if (String(raw).trim()==='' || !Number.isFinite(Number(raw))) throw new Error(`${key} must be finite numeric input`);
      else value=Number(raw);
    }
    if (field.type==='dash') {
      value=String(raw).trim()===''?[]:String(raw).split(',').map(n=>{
        if (!n.trim() || !Number.isFinite(Number(n)) || Number(n)<0) throw new Error('Threshold dash must contain finite non-negative numbers');
        return Number(n);
      });
    }
    setField(result,key,value);
  }
  return result;
}
export function editRows(rows, action, index, value={}) {
  const result=clone(rows);
  if (action==='add') result.push(clone(value));
  else if (action==='remove') result.splice(index,1);
  else {
    const next=index+(action==='up'?-1:1);
    if (index>=0 && index<result.length && next>=0 && next<result.length) [result[index],result[next]]=[result[next],result[index]];
  }
  return result;
}
function fieldsForm(document, parent, original, fields, display=original) {
  const controls=[];
  for (const [key,field] of Object.entries(fields)) {
    const label=document.createElement('label'); label.textContent=field.label;
    const input=document.createElement(field.type==='select'?'select':'input');
    input.dataset.msField=key;
    input.style.minHeight='44px';
    const value=getField(display,key) ?? field.default;
    if (field.type==='select') {
      for (const option of ['',...field.options]) {
        const node=document.createElement('option'); node.value=option; node.textContent=option || 'Default'; input.appendChild(node);
      }
    } else input.type=field.type==='checkbox'?'checkbox':field.type==='number'?'number':'text';
    if (field.type==='number') input.step=field.integer?'1':'any';
    if (field.type==='checkbox') input.checked=value ?? false;
    else input.value=field.type==='dash'?(value ?? [6,4]).join(', '):value ?? '';
    const read=()=>field.type==='checkbox'?input.checked:input.value;
    const initial=read();
    controls.push({key,read,initial}); label.appendChild(input); parent.appendChild(label);
  }
  return ()=>serializeFields(original,Object.fromEntries(controls.filter(c=>c.read()!==c.initial).map(c=>[c.key,c.read()])),fields);
}
function button(document, text, action) {
  const node=document.createElement('button'); node.type='button'; node.textContent=text;
  node.setAttribute('aria-label',text); node.style.minHeight='44px'; node.style.minWidth='44px';
  node.addEventListener('click',action); return node;
}
export function mountMultiSeriesForm(document, host, config, gauge=false) {
  const original=clone(config);
  const normalized=gauge ? normalizeBarGaugeSettings(config) : normalizeMultiSeriesSettings(config);
  host.replaceChildren();
  const readGlobals=fieldsForm(document,host,original,gauge?gaugeGlobals:timeseriesGlobals,normalized);
  function rowsSection(name, rows, fields, initial, displayRows=rows) {
    const section=document.createElement('fieldset'), title=document.createElement('legend'); title.textContent=name; section.appendChild(title);
    const list=document.createElement('div'); section.appendChild(list);
    function add(value, display=value) {
      const row=document.createElement('div'); row.dataset.msRow=name;
      row.readSettings=fieldsForm(document,row,clone(value),fields,display);
      row.appendChild(button(document,`Move up ${name} row`,()=>{if(row.previousElementSibling) list.insertBefore(row,row.previousElementSibling);}));
      row.appendChild(button(document,`Move down ${name} row`,()=>{if(row.nextElementSibling) list.insertBefore(row.nextElementSibling,row);}));
      row.appendChild(button(document,`Remove ${name} row`,()=>row.remove()));
      list.appendChild(row);
    }
    rows.forEach((row,i)=>add(row,displayRows[i]));
    section.appendChild(button(document,`Add ${name} row`,()=>add(initial)));
    host.appendChild(section);
    return ()=>Array.from(list.children,row=>row.readSettings());
  }
  const readSeries=rowsSection('Series',original.series ?? [],gauge?gaugeFields:timeseriesFields,gauge?{binding:{metric:''},max:100}:{binding:{metric:''}},normalized.series);
  let readAxis, readThresholds, readLegend;
  if (!gauge) {
    const axis=document.createElement('fieldset'), heading=document.createElement('legend'); heading.textContent='Axis'; axis.appendChild(heading); host.appendChild(axis);
    readAxis=fieldsForm(document,axis,original.axis ?? {},axisFields);
    const legend=document.createElement('fieldset'), title=document.createElement('legend'); title.textContent='Legend'; legend.appendChild(title); host.appendChild(legend);
    const readPosition=fieldsForm(document,legend,original.legend ?? {},{position:{label:'Position',type:'select',options:['bottom','right']}});
    const boxes=calculations.map(key=>{
      const label=document.createElement('label'); label.textContent=key;
      const input=document.createElement('input'); input.type='checkbox'; input.checked=(original.legend?.calculations ?? []).includes(key); input.dataset.msCalculation=key;
      label.appendChild(input); legend.appendChild(label); return {key,input};
    });
    readLegend=()=>{
      const result=readPosition();
      const selected=boxes.filter(b=>b.input.checked).map(b=>b.key);
      // Retain original calculation order, appending only newly selected entries.
      const previous=original.legend?.calculations ?? [];
      if (selected.length!==previous.length || selected.some(k=>!previous.includes(k))) result.calculations=[...previous.filter(k=>selected.includes(k)),...selected.filter(k=>!previous.includes(k))];
      return result;
    };
    readThresholds=rowsSection('Thresholds',original.thresholds ?? [],thresholdFields,{value:0,color:'#ef4444',dash:[6,4]});
  }
  host.readSettings=()=>{
    const value=readGlobals(); value.series=readSeries();
    if (!gauge) { value.axis=readAxis(); value.legend=readLegend(); value.thresholds=readThresholds(); }
    return value;
  };
}
