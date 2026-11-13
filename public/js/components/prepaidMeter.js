/**
 * Prepaid meter card (type key `prepaid-meter`): the units (kWh) left on a prepaid electricity meter, in big type, with a
 * segmented bar against the last recharge, the days left at the recent average, a few facts, and (for a signed-in user) the
 * buttons to add a recharge or correct the balance by hand, and the latest entries. It also draws the optional strip on the
 * Grid card. The figures come from modules/prepaidMeter.js through /api/prepaid (shared by every card on the page).
 *
 * The colour follows the level: green, amber from a warning level you set in Settings, red when the meter is out.
 * Every word is a setting with an English default, so none is tied to a language: the labels, the "days left" line (which
 * can hold {days}, {avg} and {date}), and the messages. The history shows symbols and numbers only: + for a recharge, = for
 * a correction.
 *
 * Block config: { title, showFacts, showHistory, segments, decimals, words: { left, daysText, outText, startText, recharge,
 *   correct, undo, factUsedToday, factAvg, factSince, factPrice, hiddenText, offText } }
 *
 * @module components/prepaidMeter
 */
import { isNumericValue } from '../utils.js';
import { decimalsOption, fillWords, num, word } from './cardText.js';
import { litSegments } from './meterCard.js';
import { getPrepaid, onPrepaid, prepaidAction } from './prepaidClient.js';
import { openCorrectDialog, openRechargeDialog } from './prepaidDialogs.js';

export const DEFAULT_WORDS = Object.freeze({
  left: 'kWh left', daysText: '≈ {days} days at {avg} kWh a day · empty about {date}', outText: 'Out of units', startText: 'Enter what the meter shows to start counting.',
  recharge: 'Record recharge', correct: 'Correct balance', undo: 'Undo last',
  factUsedToday: 'Used today', factAvg: 'Average a day', factSince: 'Used since recharge', factPrice: 'Last recharge price',
  hiddenText: 'Sign in to see the balance.', offText: 'Prepaid meter tracking is off. Switch it on in Settings.'
});
export const WORD_KEYS = Object.keys(DEFAULT_WORDS);
export const MAX_SEGMENTS = 40;

/** The valid words of a config: each is the setting, or the English default when empty. */
export function prepaidWords(raw) {
  const out = {};
  for (const k of WORD_KEYS) out[k] = word(raw && raw[k], DEFAULT_WORDS[k], 120);
  return out;
}

/** The valid options of a card's config. */
export function prepaidOptions(config = {}) {
  return {
    title: config.title === undefined ? 'Prepaid meter' : word(config.title, '', 60), showFacts: config.showFacts !== false, showHistory: config.showHistory === true,
    segments: Math.max(0, Math.min(MAX_SEGMENTS, Math.round(num(config.segments, 12)))), decimals: decimalsOption(config.decimals), words: prepaidWords(config.words)
  };
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmt = (n, d) => new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const decimalsFor = (n, o) => (o.decimals != null ? o.decimals : Math.abs(n) >= 100 ? 0 : 1);

/** The "days left" words: the template with {days}, {avg} and {date}, or '' when there are no days to show. */
export function daysLine(data, template, o = {}) {
  if (!data || data.daysLeft == null) return '';
  const date = data.emptyOn ? new Date(data.emptyOn).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const days = data.daysLeft < 10 ? fmt(Math.round(data.daysLeft * 10) / 10, data.daysLeft % 1 === 0 ? 0 : 1) : fmt(Math.round(data.daysLeft), 0);
  // A part of the words that needs the date ("· empty about {date}") is left out when there is none.
  const parts = String(template).split('·');
  const kept = date ? parts : parts.filter(p => !p.includes('{date}'));
  return fillWords(kept.join('·'), { days, avg: data.avgDaily != null ? fmt(data.avgDaily, 1) : '—', date }).trim();
}

const when = ts => new Date(ts * 1000).toLocaleDateString([], { day: 'numeric', month: 'short' });
function ledgerRow(e, data, o) {
  const row = el('div', 'pm-ledger-row');
  const money = e.amount ? ` · ${data.currency ? data.currency + ' ' : ''}${fmt(e.amount, 0)}` : '';
  const value = e.type === 'recharge' ? `+ ${fmt(e.units, decimalsFor(e.units, o))}` : `= ${fmt(e.units, decimalsFor(e.units, o))}`;
  const note = e.type === 'recharge' ? `${money.replace(/^ · /, '')}`
    : e.errorKwh != null && e.errorKwh !== 0 ? `${e.errorKwh > 0 ? '+' : '−'}${fmt(Math.abs(e.errorKwh), 1)}${e.errorPct != null ? ` (${fmt(Math.abs(e.errorPct), 1)}%)` : ''}` : '';
  row.append(el('span', 'pm-ledger-date', when(e.ts)), el('span', 'pm-ledger-note', note), el('b', 'pm-ledger-value ' + (e.type === 'recharge' ? 'pm-plus' : 'pm-fix'), value + ' kWh'));
  return row;
}

export function buildPrepaidMeter(block = {}) {
  const o = prepaidOptions(block.config || {});
  const card = el('div', 'prepaid-card ep-card');
  card.dataset.blockId = block.id || '';
  card.dataset.prepaidCfg = JSON.stringify(o);
  card.dataset.level = 'unknown';
  if (o.title) card.appendChild(el('div', 'pm-title', o.title));
  card.appendChild(el('div', 'pm-msg'));
  const body = el('div', 'pm-body');
  const big = el('div', 'pm-big'); big.append(el('span', 'pm-num', '—'), el('span', 'pm-unit', o.words.left));
  body.appendChild(big);
  const bar = el('div', o.segments ? 'pm-bar pm-segmented' : 'pm-bar');
  if (o.segments) { bar.style.setProperty('--pm-n', String(o.segments)); for (let i = 0; i < o.segments; i++) bar.appendChild(el('i', 'pm-seg')); } else bar.appendChild(el('i', 'pm-fill'));
  body.append(bar, el('div', 'pm-days'));
  card.appendChild(body);
  if (o.showFacts) card.appendChild(el('div', 'pm-facts'));
  if (o.showHistory) card.appendChild(el('div', 'pm-ledger'));
  const actions = el('div', 'pm-actions');
  for (const [key, cls] of [['recharge', 'pm-primary'], ['correct', ''], ['undo', 'pm-quiet']]) {
    const b = el('button', 'pm-btn ' + cls, o.words[key]); b.type = 'button'; b.dataset.action = key; actions.appendChild(b);
  }
  card.appendChild(actions);
  card.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-action]');
    if (!b || !card.contains(b)) return;
    const data = card._prepaid || {};
    if (b.dataset.action === 'recharge') openRechargeDialog(data);
    else if (b.dataset.action === 'correct') openCorrectDialog(data);
    else if (b.dataset.action === 'undo') { b.disabled = true; prepaidAction('undo').catch(() => {}).finally(() => { b.disabled = false; }); }
  });
  return card;
}

/** Draw one card from the figures (or from nothing: not enabled, hidden from this viewer, or not yet answered). */
export function renderPrepaidCard(card, data) {
  let o; try { o = JSON.parse(card.dataset.prepaidCfg); } catch (e) { return; }
  card._prepaid = data || null;
  const w = o.words;
  const msg = card.querySelector('.pm-msg'), body = card.querySelector('.pm-body'), actions = card.querySelector('.pm-actions');
  const show = text => { msg.textContent = text; msg.hidden = !text; body.hidden = !!text; };
  const facts = card.querySelector('.pm-facts'), ledger = card.querySelector('.pm-ledger');
  const hideExtras = hide => { if (facts) facts.hidden = hide; if (ledger) ledger.hidden = hide; };
  card.dataset.level = 'unknown';
  if (!data) { show(''); body.hidden = false; hideExtras(true); actions.hidden = true; return; }
  if (data.enabled === false) { show(data.canEdit ? w.offText : ''); hideExtras(true); actions.hidden = true; return; }
  if (data.hidden) { show(w.hiddenText); hideExtras(true); actions.hidden = true; return; }
  const canEdit = data.canEdit === true;
  if (!data.started) { show(data.problem || (canEdit ? w.startText : '')); hideExtras(true); card.dataset.level = 'unknown'; }
  else show('');
  actions.hidden = !canEdit;
  const [rechargeBtn, correctBtn, undoBtn] = actions.querySelectorAll('button');
  rechargeBtn.hidden = !data.started;
  undoBtn.hidden = !(Array.isArray(data.ledger) && data.ledger.length);
  if (!data.started) return;
  hideExtras(false);
  card.dataset.level = data.level || 'ok';
  const dec = decimalsFor(data.balance, o);
  card.querySelector('.pm-num').textContent = data.level === 'out' ? '0' : fmt(data.balance, dec);
  card.querySelector('.pm-unit').textContent = data.level === 'out' ? w.outText : w.left;
  const lit = litSegments(data.fill, o.segments);
  card.querySelectorAll('.pm-seg').forEach((s, i) => { s.dataset.on = i < lit ? '1' : '0'; });
  const solid = card.querySelector('.pm-fill'); if (solid) solid.style.width = ((data.fill || 0) * 100).toFixed(1) + '%';
  card.querySelector('.pm-days').textContent = data.level === 'out' ? '' : daysLine(data, w.daysText, o);
  if (facts) {
    const cell = (value, label) => { const f = el('div', 'pm-fact'); f.append(el('b', '', value), document.createTextNode(label)); return f; };
    const cur = data.currency ? data.currency + ' ' : '';
    const kwh = n => (isNumericValue(n) ? `${fmt(n, decimalsFor(n, o))} kWh` : '—');
    facts.replaceChildren(
      cell(kwh(data.usedToday), w.factUsedToday), cell(kwh(data.avgDaily), w.factAvg), cell(kwh(data.usedSinceRecharge), w.factSince),
      cell(data.lastRecharge && data.lastRecharge.price ? `${cur}${fmt(data.lastRecharge.price, 2)} / kWh` : '—', w.factPrice));
  }
  if (ledger) ledger.replaceChildren(...(Array.isArray(data.ledger) ? data.ledger.slice(0, 4).map(e => ledgerRow(e, data, o)) : []));
}

let subscribed = false;
const allCards = () => document.querySelectorAll('.prepaid-card');

/** Refresh every Prepaid meter card (and Grid card strip) from the shared figures. Called with each dashboard state. */
export function updatePrepaidMeter(state) {
  if (!subscribed) {
    subscribed = true;
    onPrepaid(data => { allCards().forEach(c => renderPrepaidCard(c, data)); document.querySelectorAll('.pm-strip').forEach(s => renderPrepaidStrip(s, data)); });
  }
  return getPrepaid(state).then(data => { allCards().forEach(c => renderPrepaidCard(c, data)); document.querySelectorAll('.pm-strip').forEach(s => renderPrepaidStrip(s, data)); });
}

// ── The strip on the Grid card ───────────────────────────────────────────

/** The optional strip: the balance, the days left and a bar. `words` are the Grid card's own (templates, English by default). */
export function buildPrepaidStrip(words = {}) {
  const w = { left: word(words.left, '{balance} kWh left', 60), days: word(words.days, '≈ {days} days at {avg} kWh a day', 80), out: word(words.out, DEFAULT_WORDS.outText, 40) };
  const strip = el('div', 'pm-strip'); strip.hidden = true; strip.dataset.stripWords = JSON.stringify(w);
  const row = el('div', 'pm-strip-row'); row.append(el('span', 'pm-strip-main'), el('span', 'pm-strip-sub'));
  const bar = el('div', 'pm-strip-bar'); bar.appendChild(el('i'));
  strip.append(row, bar);
  return strip;
}

export function renderPrepaidStrip(strip, data) {
  let w; try { w = JSON.parse(strip.dataset.stripWords); } catch (e) { return; }
  if (!data || data.enabled === false || data.hidden || !data.started) { strip.hidden = true; return; }
  strip.hidden = false;
  strip.dataset.level = data.level || 'ok';
  const dec = decimalsFor(data.balance, {});
  strip.querySelector('.pm-strip-main').textContent = data.level === 'out' ? w.out : fillWords(w.left, { balance: fmt(data.balance, dec) });
  strip.querySelector('.pm-strip-sub').textContent = data.level === 'out' ? '' : daysLine(data, w.days).replace(/\s*·.*$/, '');
  strip.querySelector('.pm-strip-bar i').style.width = ((data.fill || 0) * 100).toFixed(1) + '%';
}
