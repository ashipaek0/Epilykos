/**
 * Power flow card (type key `power-flow`): where the power comes from on the left, where it goes on the right,
 * joined by animated lines through one junction.
 *
 *   sources (left)          Solar, always; the Battery while it discharges; the Grid while it imports; the
 *                           Generator while it runs. The last three appear only when they are active.
 *   destinations (right)    Home, always; the Battery while it charges (or idle, when it is not a source);
 *                           the Grid while it exports.
 *
 * Which of those can appear is set on the card (the show* options); a card with no battery or generator
 * metric never shows them. The card is a size container (cards.css): its rows share its height, its text and
 * icons follow the row height, and the lines are drawn in a 0-100 box from each node's slot centre, so they
 * stay attached to the nodes at any size.
 *
 * Block config: { title, metrics: { solar, consumption, battery_charge, battery_discharge, battery_soc,
 *   grid_import, grid_export, generator }, showGridSource, showGenerator, showBatterySource, showGridExport }
 * (the show* options are on unless false).
 *
 * @module components/powerFlow
 */
import { isNumericValue } from '../utils.js';
import { formatMetric } from './format.js';
import { mdiSvg } from './buttonIcons.js';

/** Power (W) above which a flow counts as active; a generator input idles at a few watts, so it needs more. */
export const ACTIVE_W = 10;
export const GENERATOR_ON_W = 20;

export const SLOTS = ['solar', 'consumption', 'battery_charge', 'battery_discharge', 'battery_soc', 'grid_import', 'grid_export', 'generator'];
export const DEFAULT_METRICS = Object.freeze({
  solar: 'solar', consumption: 'consumption', battery_charge: 'battery_charge', battery_discharge: 'battery_discharge',
  battery_soc: 'battery_soc', grid_import: 'grid_import', grid_export: 'grid_export', generator: 'generator'
});
/** What each node shows: its icon (a name from buttonIcons.js), label and colour. */
export const NODES = Object.freeze({
  'src-solar': { icon: 'solar-power', label: 'Solar', color: 'var(--solar)' },
  'src-battery': { icon: 'battery-50', label: 'Battery', color: 'var(--discharge)' },
  'src-grid': { icon: 'transmission-tower', label: 'Grid', color: 'var(--grid)' },
  'src-generator': { icon: 'generator-stationary', label: 'Generator', color: 'var(--generator, #f97316)' },
  'dst-home': { icon: 'home', label: 'Home', color: 'var(--home)' },
  'dst-battery': { icon: 'battery-charging', label: 'Battery', color: 'var(--battery)' },
  'dst-grid': { icon: 'transmission-tower', label: 'Grid', color: 'var(--export)' }
});
const SOURCE_ORDER = ['src-solar', 'src-battery', 'src-grid', 'src-generator'];
const DEST_ORDER = ['dst-home', 'dst-battery', 'dst-grid'];

/** The valid options of a card's config. */
export function powerFlowOptions(config = {}) {
  const metrics = { ...DEFAULT_METRICS };
  for (const slot of SLOTS) if (config.metrics && typeof config.metrics[slot] === 'string' && config.metrics[slot].trim()) metrics[slot] = config.metrics[slot].trim();
  return {
    metrics,
    showGridSource: config.showGridSource !== false, showGenerator: config.showGenerator !== false,
    showBatterySource: config.showBatterySource !== false, showGridExport: config.showGridExport !== false
  };
}

/**
 * Which nodes show, and with what power, from the powers in W. `w` has the slots (missing or text values are 0) and `present`
 * says which metrics the home has at all (a battery or generator that is not reported never shows).
 * @returns {{ sources: Array<{key,w,flowing}>, dests: Array<{key,w,flowing,soc?}> }}
 */
export function powerFlowModel(w, options, present = {}) {
  const num = v => (isNumericValue(v) ? Number(v) : 0);
  const solar = num(w.solar), load = num(w.consumption), bc = num(w.battery_charge), bd = num(w.battery_discharge);
  const gi = num(w.grid_import), ge = num(w.grid_export), gen = num(w.generator), soc = w.battery_soc;
  const hasBattery = !!present.battery;
  const batteryNet = bc - bd, gridNet = gi - ge;
  const sources = [{ key: 'src-solar', w: Math.max(0, solar) }];
  const batteryIsSource = options.showBatterySource && hasBattery && -batteryNet > ACTIVE_W;
  if (batteryIsSource) sources.push({ key: 'src-battery', w: -batteryNet });
  if (options.showGridSource && gridNet > ACTIVE_W) sources.push({ key: 'src-grid', w: gridNet });
  if (options.showGenerator && present.generator && gen > GENERATOR_ON_W) sources.push({ key: 'src-generator', w: gen });
  const dests = [{ key: 'dst-home', w: Math.max(0, load) }];
  if (hasBattery && !batteryIsSource) dests.push({ key: 'dst-battery', w: Math.max(0, batteryNet), soc: isNumericValue(soc) ? Number(soc) : null });
  if (options.showGridExport && -gridNet > ACTIVE_W) dests.push({ key: 'dst-grid', w: -gridNet });
  for (const n of [...sources, ...dests]) n.flowing = n.w > ACTIVE_W;
  if (batteryIsSource) { const b = sources.find(n => n.key === 'src-battery'); b.soc = isNumericValue(soc) ? Number(soc) : null; }
  sources.sort((a, b) => SOURCE_ORDER.indexOf(a.key) - SOURCE_ORDER.indexOf(b.key));
  dests.sort((a, b) => DEST_ORDER.indexOf(a.key) - DEST_ORDER.indexOf(b.key));
  return { sources, dests };
}

/**
 * The lines, in a 0-100 box: from each source's slot centre on the left to a junction in the middle, and from there to each
 * destination's slot centre on the right. Slots share the card's height equally, so a centre is (i + 0.5) / n of it.
 * @returns {{ src: string[], dst: string[] }} path data for each source and destination, in order
 */
export function flowPaths(sourceCount, destCount) {
  const y = (i, n) => Math.round(((i + 0.5) / n) * 1000) / 10;
  const src = Array.from({ length: sourceCount }, (_, i) => `M0 ${y(i, sourceCount)} C32 ${y(i, sourceCount)} 36 50 50 50`);
  const dst = Array.from({ length: destCount }, (_, i) => `M50 50 C64 50 68 ${y(i, destCount)} 100 ${y(i, destCount)}`);
  return { src, dst };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function nodeEl(key) {
  const def = NODES[key];
  const el = document.createElement('div');
  el.className = 'pf-node';
  el.dataset.key = key;
  el.style.setProperty('--pf-color', def.color);
  el.hidden = key !== 'src-solar' && key !== 'dst-home';
  const icon = document.createElement('span');
  icon.className = 'pf-icon'; icon.setAttribute('aria-hidden', 'true'); icon.innerHTML = mdiSvg(def.icon);   // built-in path data
  const text = document.createElement('span');
  text.className = 'pf-text';
  for (const [cls, content] of [['pf-label', def.label], ['pf-value', '—'], ['pf-sub', '']]) {
    const s = document.createElement('span'); s.className = cls; s.textContent = content; text.appendChild(s);
  }
  el.append(icon, text);
  return el;
}

export function buildPowerFlow(block = {}) {
  const config = block.config || {};
  const options = powerFlowOptions(config);
  const card = document.createElement('div');
  card.className = 'power-flow-card ep-card';
  card.dataset.blockId = block.id || '';
  card.dataset.metricMap = JSON.stringify(options);
  const title = config.title === undefined ? 'Power flow' : String(config.title || '').trim();
  if (title) { const h = document.createElement('div'); h.className = 'pf-title'; h.textContent = title; card.appendChild(h); }
  const body = document.createElement('div');
  body.className = 'pf-body';
  const sources = document.createElement('div'); sources.className = 'pf-col pf-sources';
  const dests = document.createElement('div'); dests.className = 'pf-col pf-dests';
  SOURCE_ORDER.forEach(k => sources.appendChild(nodeEl(k)));
  DEST_ORDER.forEach(k => dests.appendChild(nodeEl(k)));
  const mid = document.createElement('div'); mid.className = 'pf-mid';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'pf-lines'); svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
  for (const key of [...SOURCE_ORDER, ...DEST_ORDER]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'pf-line'); path.dataset.key = key; path.style.setProperty('--pf-color', NODES[key].color); path.style.display = 'none';
    svg.appendChild(path);
  }
  const dot = document.createElement('span'); dot.className = 'pf-dot';
  mid.append(svg, dot);
  body.append(sources, mid, dests);
  card.appendChild(body);
  return card;
}

const watts = w => formatMetric(w, 'W').text;

function valuesOf(state, metrics) {
  const m = (state && state.metrics) || {};
  const entry = slot => {
    const e = m[metrics[slot]];
    return e === undefined && slot === 'generator' ? m.generator_power : e;
  };
  const w = {};
  for (const slot of SLOTS) { const e = entry(slot); w[slot] = e ? e.value : undefined; }
  const present = { battery: ['battery_charge', 'battery_discharge', 'battery_soc'].some(s => entry(s) !== undefined), generator: entry('generator') !== undefined };
  return { w, present };
}

export function updatePowerFlow(state) {
  document.querySelectorAll('.power-flow-card').forEach(card => {
    let options; try { options = JSON.parse(card.dataset.metricMap); } catch (e) { return; }
    const { w, present } = valuesOf(state, options.metrics || DEFAULT_METRICS);
    const model = powerFlowModel(w, options, present);
    const shown = new Map([...model.sources, ...model.dests].map(n => [n.key, n]));
    card.querySelectorAll('.pf-node').forEach(el => {
      const n = shown.get(el.dataset.key);
      el.hidden = !n;
      if (!n) return;
      el.classList.toggle('is-flowing', n.flowing);
      el.querySelector('.pf-value').textContent = watts(n.w);
      el.querySelector('.pf-sub').textContent = n.soc != null ? Math.round(n.soc) + '%' : '';
    });
    card.style.setProperty('--pf-rows', String(Math.max(model.sources.length, model.dests.length, 1)));
    const paths = flowPaths(model.sources.length, model.dests.length);
    const set = (list, nodes) => nodes.forEach((n, i) => {
      const p = card.querySelector(`.pf-line[data-key="${n.key}"]`);
      if (!p) return;
      p.setAttribute('d', list[i]); p.style.display = ''; p.classList.toggle('is-flowing', n.flowing);
    });
    card.querySelectorAll('.pf-line').forEach(p => { p.style.display = 'none'; });
    set(paths.src, model.sources); set(paths.dst, model.dests);
    const dot = card.querySelector('.pf-dot');
    if (dot) dot.classList.toggle('is-flowing', [...shown.values()].some(n => n.flowing));
  });
}
