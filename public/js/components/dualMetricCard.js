import { normalizeDualMetricConfig, resolveDualMetricPane } from './dualMetricLogic.js';
import { icon as renderIcon } from '../editor-catalog.js';
import { markBreakdown, applyBreakdowns } from './breakdown.js';

const iconIds = new Set(['sun', 'sunLine', 'panel', 'battery', 'plug', 'flow', 'chartLine', 'chartArea', 'metricTrend']);
let sequence = 0;
const make = (tag, className, value) => {
  const el = document.createElement(tag);
  el.className = className;
  if (value != null) el.textContent = value;
  return el;
};
// Sizes left on Auto (null) fall back to the card's responsive defaults.
const variable = (el, name, value) => { if (value !== null && value !== undefined) el.style.setProperty(name, `${value}px`); };
function setColor(el, property, value) { if (value) el.style[property] = value; }
function makePane(side, config, preset) {
  const pane = make('section', `dual-metric-pane dual-metric-pane-${side}`);
  pane.dataset.side = side;
  pane.style.minWidth = '0';
  pane.style.textAlign = config.align;
  variable(pane, '--dual-value-size', config.valueFontSize);
  variable(pane, '--dual-label-size', config.labelFontSize);
  variable(pane, '--dual-unit-size', config.unitFontSize);
  const label = make('div', 'dual-metric-label', config.label || config.metric);
  setColor(label, 'color', config.labelColor);
  const readout = make('div', 'dual-metric-readout');
  readout.style.minWidth = '0';
  readout.style.justifyContent = ({ left: 'flex-start', center: 'center', right: 'flex-end' })[config.align] || 'center';
  const value = make('span', 'dual-metric-value', '—');
  setColor(value, 'color', config.valueColor);
  const unit = make('span', 'dual-metric-unit');
  setColor(unit, 'color', config.unitColor);
  const status = make('span', 'dual-metric-status');
  readout.append(value, unit);
  pane.append(label, readout, status);
  if (preset === 'split-fill') setColor(pane, 'backgroundColor', config.fillColor);
  return pane;
}
function applyConfig(root, c) {
  root.dataset.config = JSON.stringify(c);
  root.style.borderRadius = `${c.style.radius}px`;
  root.style.padding = '0';
  root.style.minWidth = '0';
  root.style.overflow = 'hidden';
  root.style.alignItems = 'stretch';
  variable(root, '--dual-padding', c.style.padding);
  variable(root, '--dual-pane-gap', c.style.paneGap);
  variable(root, '--dual-divider-width', c.preset === 'split-fill' ? c.style.dividerWidth : 0);
  setColor(root, 'borderColor', c.style.borderColor);
  if (c.style.borderWidth) { root.style.borderWidth = `${c.style.borderWidth}px`; root.style.borderStyle = 'solid'; }
  const header = root.querySelector('.dual-metric-header');
  if (header) {
    header.style.margin = '0';
    setColor(header, 'backgroundColor', c.style.headerColor);
    setColor(header, 'color', c.style.headerTextColor);
    const title = header.querySelector('.dual-metric-title');
    if (title) title.textContent = c.title;
    header.hidden = !c.title && !header.querySelector('.dual-metric-icon, .dual-metric-help');
  }
  const body = root.querySelector('.dual-metric-body');
  if (body) setColor(body, 'backgroundColor', c.preset === 'split-fill' ? c.style.dividerColor : '');
  for (const side of ['left', 'right']) {
    const pane = root.querySelector(`.dual-metric-pane-${side}`);
    if (!pane) continue;
    pane.dataset.metric = c.panes[side].metric;
    pane.style.textAlign = c.panes[side].align;
    setColor(pane.querySelector('.dual-metric-value'), 'color', c.panes[side].valueColor);
    const readout = pane.querySelector('.dual-metric-readout');
    if (readout) readout.style.justifyContent = ({ left: 'flex-start', center: 'center', right: 'flex-end' })[c.panes[side].align] || 'center';
    setColor(pane.querySelector('.dual-metric-label'), 'color', c.panes[side].labelColor);
    setColor(pane.querySelector('.dual-metric-unit'), 'color', c.panes[side].unitColor);
    if (c.preset === 'split-fill') setColor(pane, 'backgroundColor', c.panes[side].fillColor);
    else pane.style.backgroundColor = '';
  }
}
export function buildDualMetricCard(block = {}) {
  const c = normalizeDualMetricConfig(block.config);
  const root = document.createElement('article');
  root.className = `dual-metric-card stat-card dual-metric-${c.preset}`;
  root.dataset.blockId = block.id || '';
  markBreakdown(root, block.config);
  root.dataset.instanceId = `dual-metric-${++sequence}`;
  const header = make('header', 'dual-metric-header');
  const title = make('span', 'dual-metric-title', c.title);
  header.append(title);
  if (iconIds.has(c.icon)) {
    const markup = renderIcon(c.icon, 20);
    if (markup) { const iconNode = make('span', 'dual-metric-icon'); iconNode.innerHTML = markup; header.append(iconNode); }
  }
  if (c.helpText) {
    const helpId = `${root.dataset.instanceId}-help`;
    const button = make('button', 'dual-metric-help', '?');
    button.type = 'button'; button.setAttribute('aria-label', 'Show card help'); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-describedby', helpId);
    const help = make('span', 'dual-metric-help-text', c.helpText);
    help.id = helpId; help.hidden = true;
    button.addEventListener('click', () => { help.hidden = !help.hidden; button.setAttribute('aria-expanded', String(!help.hidden)); });
    button.addEventListener('keydown', event => { if (event.key === 'Escape' && !help.hidden) { help.hidden = true; button.setAttribute('aria-expanded', 'false'); button.focus(); } });
    header.append(button, help);
  }
  const body = make('div', 'dual-metric-body');
  body.append(makePane('left', c.panes.left, c.preset), makePane('right', c.panes.right, c.preset));
  // No title, icon or help: no empty header bar.
  header.hidden = !c.title && !header.querySelector('.dual-metric-icon, .dual-metric-help');
  root.append(header, body);
  applyConfig(root, c);
  return root;
}
export function updateDualMetricCards(state = {}) {
  document.querySelectorAll('.dual-metric-card').forEach(root => {
    let c;
    try { c = normalizeDualMetricConfig(JSON.parse(root.dataset.config || '{}')); }
    catch (_) { c = normalizeDualMetricConfig(); }
    applyBreakdowns(root, state, ['left', 'right'].map(side => ({ host: root.querySelector(`.dual-metric-pane-${side}`), title: c.panes[side].label || c.panes[side].metric, specs: [{ name: c.panes[side].metric, unit: c.panes[side].unit }], before: root.querySelector(`.dual-metric-pane-${side} .dual-metric-status`) })));
    for (const side of ['left', 'right']) {
      const pane = root.querySelector(`.dual-metric-pane-${side}`);
      if (!pane) continue;
      const result = resolveDualMetricPane(state, c.panes[side]);
      const value = pane.querySelector('.dual-metric-value');
      const unit = pane.querySelector('.dual-metric-unit');
      const status = pane.querySelector('.dual-metric-status');
      if (value) value.textContent = result.formatted?.value || '—';
      if (unit) unit.textContent = result.formatted?.unit || '';
      if (status) status.textContent = result.status;
      pane.dataset.status = result.status.toLowerCase();
    }
  });
}
