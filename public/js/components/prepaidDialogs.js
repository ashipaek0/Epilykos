/**
 * The two dialogs of the prepaid meter, opened from the card or the Grid card strip by a signed-in user. They only RECORD
 * what the owner has done by hand: Epilykos cannot buy a token, load one or read the meter.
 *   Record recharge   the units on a token already bought and loaded, and optionally what was paid (the price per unit is worked out);
 *   Correct balance   what the meter shows now, read off it by hand, at any time, with the choice to learn from the difference.
 * A small modal with a focus trap, closed by Esc, the backdrop or Cancel. Nothing is sent until the form is submitted.
 *
 * @module components/prepaidDialogs
 */
import { prepaidAction } from './prepaidClient.js';

/** The dialogs' stylesheet, added once, so any page that opens one has it. */
function ensureStyles() {
  if (document.querySelector('link[data-prepaid-dialog]')) return;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/prepaid-dialog.css'; link.dataset.prepaidDialog = '1';
  document.head.appendChild(link);
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const num = v => { const n = Number(String(v).replace(',', '.')); return String(v).trim() !== '' && Number.isFinite(n) ? n : null; };
const fmt = (n, d = 1) => new Intl.NumberFormat(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }).format(n);

function field(id, label, unit, attrs = {}) {
  const wrap = el('label', 'pm-field'); wrap.htmlFor = id;
  wrap.appendChild(el('span', 'pm-field-label', label));
  const row = el('span', 'pm-input');
  const input = el('input'); input.id = id; input.type = 'text'; input.inputMode = 'decimal'; input.autocomplete = 'off';
  Object.assign(input, attrs);
  row.appendChild(input);
  if (unit) row.appendChild(el('em', '', unit));
  wrap.appendChild(row);
  return { wrap, input };
}

/** Open a modal with `title`, the given fields, and a primary button; `onSubmit(values)` returns a promise. */
function modal({ title, fields, note, primary, extra, onSubmit }) {
  ensureStyles();
  const previous = document.activeElement;
  const backdrop = el('div', 'pm-backdrop');
  const dialog = el('form', 'pm-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.noValidate = true;
  const heading = el('h3', 'pm-dialog-title', title); heading.id = 'pm-dialog-title'; dialog.setAttribute('aria-labelledby', heading.id);
  dialog.appendChild(heading);
  if (note) dialog.appendChild(el('p', 'pm-lead', note));
  fields.forEach(f => dialog.appendChild(f.wrap));
  const noteEl = el('div', 'pm-note'); noteEl.setAttribute('aria-live', 'polite'); dialog.appendChild(noteEl);
  if (extra) dialog.appendChild(extra);
  const errorEl = el('div', 'pm-error'); errorEl.setAttribute('role', 'alert'); errorEl.hidden = true; dialog.appendChild(errorEl);
  const buttons = el('div', 'pm-buttons');
  const ok = el('button', 'pm-btn pm-primary', primary); ok.type = 'submit';
  const cancel = el('button', 'pm-btn', 'Cancel'); cancel.type = 'button';
  buttons.append(ok, cancel); dialog.appendChild(buttons);
  backdrop.appendChild(dialog); document.body.appendChild(backdrop);

  const close = () => { document.removeEventListener('keydown', onKey, true); backdrop.remove(); if (previous && previous.focus) previous.focus(); };
  const onKey = ev => {
    if (ev.key === 'Escape') { ev.stopPropagation(); close(); return; }
    if (ev.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll('input, button')].filter(x => !x.disabled);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('mousedown', ev => { if (ev.target === backdrop) close(); });
  cancel.addEventListener('click', close);
  dialog.addEventListener('submit', async ev => {
    ev.preventDefault();
    errorEl.hidden = true; ok.disabled = true;
    try { await onSubmit(); close(); }
    catch (e) { errorEl.textContent = e.message; errorEl.hidden = false; ok.disabled = false; }
  });
  if (fields[0]) fields[0].input.focus();
  return { noteEl, close };
}

/** Recharge: units on the token, what was paid (optional). `data.currency` is the money symbol. */
export function openRechargeDialog(data = {}) {
  const cur = data.currency || '';
  const units = field('pm-units', 'Units on the token', 'kWh'), paid = field('pm-paid', 'Amount paid (optional)', cur);
  const { noteEl } = modal({
    title: 'Record a recharge', fields: [units, paid], primary: 'Record recharge', note: 'This only records a token you have already bought and loaded. It does not buy or send one.',
    onSubmit: () => {
      const u = num(units.input.value);
      if (u === null || u <= 0) throw new Error('Enter the units the token gave, more than 0.');
      const a = num(paid.input.value);
      return prepaidAction('recharge', { units: u, amount: a !== null && a > 0 ? a : undefined });
    }
  });
  const update = () => {
    const u = num(units.input.value), a = num(paid.input.value);
    const parts = [];
    if (u !== null && u > 0 && a !== null && a > 0) parts.push(`Price per unit ${cur} ${fmt(a / u, 2)}.`);
    if (u !== null && u > 0 && data.balance != null) parts.push(`New balance ${fmt(data.balance + u)} kWh.`);
    noteEl.textContent = parts.join(' ');
  };
  units.input.addEventListener('input', update); paid.input.addEventListener('input', update); update();
}

/** Correct balance: what the meter shows now. Allowed at any time, whether or not the estimate has drifted. */
export function openCorrectDialog(data = {}) {
  const started = data.started === true && data.balance != null;
  const reading = field('pm-reading', started ? 'The meter shows' : 'The meter shows (to start the count)', 'kWh');
  const learnWrap = el('label', 'pm-learn'); const learn = el('input'); learn.type = 'checkbox'; learn.id = 'pm-learn'; learn.checked = true;
  learnWrap.append(learn, el('span', '', ' Use this to improve later estimates'));
  const { noteEl } = modal({
    title: started ? 'Correct balance' : 'Set the balance', fields: [reading], note: 'Read the number off the meter, then type it here. Nothing is sent to the meter.', primary: started ? 'Set balance' : 'Start counting', extra: started ? learnWrap : null,
    onSubmit: () => {
      const v = num(reading.input.value);
      if (v === null || v < 0) throw new Error('Enter what the meter shows, 0 or more.');
      return prepaidAction('correct', { units: v, learn: started && learn.checked });
    }
  });
  const update = () => {
    const v = num(reading.input.value);
    if (!started) { noteEl.textContent = 'Epilykos will count down from this reading.'; return; }
    if (v === null || v < 0) { noteEl.textContent = `Epilykos has ${fmt(data.balance)} kWh.`; return; }
    const diff = data.balance - v;
    noteEl.textContent = Math.abs(diff) < 0.05 ? `Epilykos had ${fmt(data.balance)} kWh: no difference.`
      : `Epilykos had ${fmt(data.balance)} kWh. It was ${fmt(Math.abs(diff))} kWh ${diff > 0 ? 'high' : 'low'}.`;
  };
  reading.input.addEventListener('input', update); update();
}
