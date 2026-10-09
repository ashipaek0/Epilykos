/**
 * Card showcase: one of every dashboard card, drawn by the dashboard's own
 * card code and fed by the made-up home in showcase-data.js. Each card has a
 * few options to try; changes stay on this page and are never saved.
 *
 * showcase-api.js is imported first so it is in place before any card asks
 * for data.
 *
 * @module showcase
 */
import './showcase-api.js';
import { dashboardState } from './showcase-data.js';
import { SHOWCASE_BLOCKS } from './showcase-layout.js';
import { getBuilder, controlBuilders } from '/js/components/index.js';
import { GROUPS, blockInfo } from '/js/editor-catalog.js';
import { updateCards } from '/js/cards-update.js';
import { ensureChartJS } from '/js/chartLoader.js';
import { initPowerChart, initEnergyChart, initMetricChart } from '/js/charts.js';
import { updateDailyTable, updateMonthlyTable } from '/js/tables.js';
import { applyBlockStyle } from '/js/components/blockStyle.js';
import { initTheme, toggleTheme } from '/js/theme.js';

const ROW_HEIGHT = 50;          // the dashboard's row height (dashboard.js)
const REFRESH_MS = 5000;

const SIZE = [
  { path: 'gridW', label: 'Width', kind: 'select', choices: [[3, '3 of 12 columns'], [4, '4 of 12 columns'], [6, '6 of 12 columns'], [8, '8 of 12 columns'], [12, 'Full width']], block: true },
  { path: 'gridH', label: 'Height (rows)', kind: 'number', min: 2, max: 14, block: true }
];
const yes = (path, label) => ({ path, label, kind: 'check' });
const text = (path, label) => ({ path, label, kind: 'text' });
const num = (path, label, min, max) => ({ path, label, kind: 'number', min, max });
const pick = (path, label, choices) => ({ path, label, kind: 'select', choices });
const RANGE = pick('range', 'Period', [['24h', 'Last 24 hours'], ['7d', 'Last 7 days']]);
const BUCKET = pick('bucket', 'Bar size', [['15m', '15 minutes'], ['1h', '1 hour'], ['1d', '1 day']]);

/** Options to try, per card type (config paths unless marked block). */
const OPTIONS = {
  'flow-card': [yes('showGauge', 'Show the solar gauge')],
  'system-overview': [text('title', 'Title'), yes('showWeather', 'Show the weather')],
  'metric-trend': [text('title', 'Title'), pick('preset', 'Look', [['subtle-area', 'Subtle'], ['filled-body', 'Filled']]),
    yes('graph.enabled', 'Show a graph'), pick('graph.window', 'Graph period', [['1h', '1 hour'], ['6h', '6 hours'], ['24h', '24 hours'], ['7d', '7 days']]),
    pick('graph.lineStyle', 'Graph style', [['area', 'Area'], ['line', 'Line']])],
  'dual-metric': [text('title', 'Title'), pick('preset', 'Look', [['neutral', 'Plain'], ['split-fill', 'Split colour']])],
  'text-metric': [text('label', 'Label')],
  'grid-card': [yes('showTimeline', 'Show the 24-hour timeline')],
  'savings-summary': [text('title', 'Title')],
  'gauge-card': [text('title', 'Title'), num('min', 'Lowest', -10000, 10000), num('max', 'Highest', -10000, 10000)],
  'configurable-gauge': [text('title', 'Title'), pick('preset', 'Arc', [['continuous', 'Continuous'], ['segmented', 'Segmented']]),
    pick('style', 'Style', [['flat', 'Flat'], ['gradient', 'Gradient'], ['glow', 'Glow']]), yes('band.show', 'Show the colour bands'),
    num('opening', 'Arc size (degrees)', 30, 300)],
  'half-gauge': [text('title', 'Title'), num('min', 'Lowest', -10000, 10000), num('max', 'Highest', -10000, 10000)],
  'half-gauge-2': [text('title', 'Title'), num('min', 'Lowest', -10000, 10000), num('max', 'Highest', -10000, 10000)],
  'bar-single': [text('title', 'Title'), RANGE, BUCKET],
  'bar-stacked': [text('title', 'Title'), RANGE, BUCKET],
  'bar-threshold': [text('title', 'Title'), pick('valueAgg', 'Value', [['last', 'Latest'], ['avg', 'Average']])],
  'chart-power': [text('title', 'Title')],
  'energy-day': [yes('showForecast', 'Show the forecast'), yes('showBattery', 'Show battery charge')],
  'energy-flows': [yes('showForecast', 'Show the forecast')],
  'energy-costs': [yes('showForecast', 'Show the forecast')],
  'weather-block': [text('title', 'Title')],
  'switch-block': [text('label', 'Label')],
  'state-select': [text('label', 'Label')],
  'text-card': [{ path: 'content', label: 'Text', kind: 'textarea' }]
};

const CHART_TYPES = new Set(['chart-power', 'chart-energy', 'chart-metric']);

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, path, value) {
  const keys = path.split('.'), last = keys.pop();
  let o = obj;
  for (const k of keys) { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
  o[last] = value;
}

const items = SHOWCASE_BLOCKS.map((b, i) => {
  const info = blockInfo(b.type);
  const { type, config, ...extra } = b;
  return { info, block: { id: 'sc-' + i, type, enabled: true, gridX: 0, gridY: 0, gridW: info.w, gridH: info.h, ...extra, config: structuredClone(config || {}) } };
});

let state = dashboardState();
const typesShown = () => new Set(items.map(it => it.block.type));

function drawCard(item) {
  const frame = item.frame;
  frame.replaceChildren();
  frame.style.setProperty('--sc-cols', String(item.block.gridW));
  frame.style.setProperty('--sc-height', item.block.gridH * ROW_HEIGHT + 'px');
  let content;
  const build = controlBuilders[item.block.type] || getBuilder(item.block.type);
  try { content = build(structuredClone(item.block)); }
  catch (e) { content = document.createElement('div'); content.className = 'block-error'; content.textContent = 'This card could not be drawn.'; console.error(e); }
  if (!content) return;
  applyBlockStyle(content, item.block);
  frame.appendChild(content);
}

let pending = null;
/**
 * Push the current made-up state into every card. After a card is (re)drawn
 * (full = true) charts are started and the tables filled too; the regular
 * refresh only updates live values, so an open table or chart isn't redrawn.
 */
function refreshCards(full = true) {
  if (pending) return pending;
  pending = (async () => {
    const types = typesShown();
    if (full && [...CHART_TYPES].some(t => types.has(t))) {
      try { await ensureChartJS(); initPowerChart(); initEnergyChart(); initMetricChart(); } catch { /* charts stay empty offline */ }
    }
    try { updateCards(state, types); } catch (e) { console.warn('Showcase update failed:', e); }
    if (full) {
      updateDailyTable().catch(() => {});
      updateMonthlyTable().catch(() => {});
    }
  })().finally(() => { pending = null; });
  return pending;
}

function optionField(item, opt, n) {
  const id = `${item.block.id}-opt-${n}`;
  const wrap = document.createElement('div');
  wrap.className = 'sc-field' + (opt.kind === 'check' ? ' sc-field-check' : '');
  const source = opt.block ? item.block : item.block.config;
  const current = getPath(source, opt.path);
  let input;
  if (opt.kind === 'select') {
    input = document.createElement('select');
    for (const [value, label] of opt.choices) input.add(new Option(label, String(value), false, String(current) === String(value)));
    if (current === undefined) input.selectedIndex = 0;
  } else if (opt.kind === 'textarea') {
    input = document.createElement('textarea'); input.rows = 2; input.value = current ?? '';
  } else {
    input = document.createElement('input');
    input.type = opt.kind === 'check' ? 'checkbox' : opt.kind === 'number' ? 'number' : 'text';
    if (opt.kind !== 'check') input.value = current ?? '';
    if (opt.min != null) input.min = opt.min;
    if (opt.max != null) input.max = opt.max;
  }
  if (opt.kind === 'check') input.checked = current === undefined ? defaultOn(item.block.type, opt.path) : current === true;
  input.id = id;
  const label = document.createElement('label');
  label.htmlFor = id; label.textContent = opt.label;
  const apply = () => {
    let value = opt.kind === 'check' ? input.checked : input.value;
    if (opt.kind === 'number' || (opt.block && opt.kind === 'select')) {
      value = Number(value);
      if (!Number.isFinite(value)) return;
      if (opt.min != null) value = Math.max(opt.min, value);
      if (opt.max != null) value = Math.min(opt.max, value);
    }
    setPath(source, opt.path, value);
    drawCard(item);
    refreshCards();
  };
  input.addEventListener(opt.kind === 'text' || opt.kind === 'textarea' ? 'input' : 'change', apply);
  if (opt.kind === 'check') wrap.append(input, label); else wrap.append(label, input);
  return wrap;
}

/** Checkbox options that are on when the config leaves them out. */
function defaultOn(type, path) {
  return (type === 'flow-card' && path === 'showGauge') || (type === 'grid-card' && path === 'showTimeline') ||
    (type === 'energy-day' && path === 'showForecast');
}

function renderItem(item) {
  const el = document.createElement('article');
  el.className = 'sc-item';
  el.id = 'card-' + item.block.type;
  el.setAttribute('aria-labelledby', el.id + '-name');
  const head = document.createElement('div');
  head.className = 'sc-item-head';
  head.innerHTML = `<div><h3 id="${el.id}-name"></h3><p></p></div>`;
  head.querySelector('h3').textContent = item.info.name;
  head.querySelector('p').textContent = item.info.desc;
  const opts = document.createElement('details');
  opts.className = 'sc-options';
  opts.innerHTML = '<summary>Try options</summary>';
  const form = document.createElement('div');
  form.className = 'sc-options-body';
  [...(OPTIONS[item.block.type] || []), ...SIZE].forEach((opt, n) => form.appendChild(optionField(item, opt, n)));
  const reset = document.createElement('button');
  reset.type = 'button'; reset.className = 'sc-reset'; reset.textContent = 'Reset';
  const original = structuredClone(item.block);
  reset.addEventListener('click', () => {
    item.block = structuredClone(original);
    form.replaceChildren(...[...(OPTIONS[item.block.type] || []), ...SIZE].map((opt, n) => optionField(item, opt, n)), reset);
    drawCard(item); refreshCards();
  });
  form.appendChild(reset);
  opts.appendChild(form);
  head.appendChild(opts);
  const stage = document.createElement('div');
  stage.className = 'sc-stage';
  item.frame = document.createElement('div');
  item.frame.className = 'dashboard-block sc-frame';
  item.frame.dataset.blockId = item.block.id;
  stage.appendChild(item.frame);
  el.append(head, stage);
  return el;
}

function render() {
  const main = document.getElementById('sc-main');
  const nav = document.getElementById('sc-nav');
  for (const group of GROUPS) {
    const groupItems = items.filter(it => it.info.group === group.id);
    if (!groupItems.length) continue;
    const section = document.createElement('section');
    section.className = 'sc-group';
    section.id = 'group-' + group.id;
    section.setAttribute('aria-labelledby', section.id + '-title');
    const h2 = document.createElement('h2');
    h2.id = section.id + '-title';
    h2.textContent = group.label;
    section.appendChild(h2);
    const list = document.createElement('div');
    list.className = 'sc-list';
    for (const it of groupItems) list.appendChild(renderItem(it));
    section.appendChild(list);
    main.appendChild(section);
    const a = document.createElement('a');
    a.href = '#' + section.id;
    a.textContent = `${group.label} (${groupItems.length})`;
    nav.appendChild(a);
  }
  for (const it of items) drawCard(it);
}

initTheme();
document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
render();
refreshCards();
setInterval(() => { if (document.hidden) return; state = dashboardState(); refreshCards(false); }, REFRESH_MS);
