/**
 * Automations page: list, editor, test, take over, pause all and the run log.
 * The server checks everything again; this page explains it in plain words.
 *
 * @module automations
 */
const $ = id => document.getElementById(id);
const OPS = { gt: 'is above', gte: 'is at or above', lt: 'is below', lte: 'is at or below', eq: 'equals', neq: 'does not equal' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const REFRESH_MS = 10000;

let data = { automations: [], paused: false, unlockedUntil: null, unlockMinutes: 5 };
let catalog = { targets: [], metrics: [] };
let clockSkew = 0, countdown = null;
let draft = null, editingId = null;

async function api(method, path, body) {
  const res = await fetch('/api/automations' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  let json = {};
  try { json = await res.json(); } catch { /* empty */ }
  if (res.status === 423) setLock(null);
  return { ok: res.ok, status: res.status, data: json };
}

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  // Settings' field look (settings-datum.css) is keyed on these classes.
  if (tag === 'input' && !['checkbox', 'radio'].includes(el.type)) { el.classList.add('input'); if (!el.getAttribute('type')) el.type = 'text'; }
  if (tag === 'select') el.classList.add('select-input');
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const say = (id, text, bad) => { const el = $(id); el.textContent = text || ''; el.style.color = bad ? 'var(--st-danger, #c0392b)' : ''; };

function ask({ title, text, ok }) {
  const dlg = $('ct-dialog');
  $('ct-dialog-title').textContent = title; $('ct-dialog-text').textContent = text; $('ct-dialog-ok').textContent = ok;
  return new Promise(resolve => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.returnValue = 'cancel'; dlg.showModal(); $('ct-dialog-cancel').focus();
  });
}

// ── Lock ──
const unlocked = () => !!data.unlockedUntil && data.unlockedUntil + clockSkew > Date.now();
function setLock(until) {
  data.unlockedUntil = until;
  const on = unlocked();
  $('ct-unlock-form').hidden = on; $('ct-lock-now').hidden = !on;
  const badge = $('au-lock-badge');
  badge.textContent = on ? 'Unlocked' : 'Locked';
  badge.className = 'st-badge' + (on ? ' is-ok' : '');
  clearInterval(countdown);
  const tick = () => {
    if (!unlocked()) { clearInterval(countdown); if (on) setLock(null); return; }
    const left = Math.max(0, Math.round((data.unlockedUntil + clockSkew - Date.now()) / 1000));
    $('ct-lock-text').textContent = `Locks again in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  };
  if (on) { tick(); countdown = setInterval(tick, 1000); } else $('ct-lock-text').textContent = `Unlock for ${data.unlockMinutes} min to save or turn on an automation.`;
}
$('ct-unlock-form').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await fetch('/api/controls/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ password: $('ct-password').value }) });
  const j = await res.json().catch(() => ({}));
  $('ct-password').value = '';
  if (!res.ok) return say('ct-lock-msg', j.error || 'Could not unlock', true);
  say('ct-lock-msg', ''); clockSkew = Date.now() - j.now; setLock(j.unlockedUntil); render();
});
$('ct-lock-now').addEventListener('click', async () => {
  await fetch('/api/controls/lock', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  setLock(null); render();
});

// ── Plain-English summary ──
const targetOf = t => catalog.targets.find(c => c.source === t.source && c.device === t.device && c.entity === t.entity);
function condText(c) {
  if (c.type === 'time') return `it is between ${c.from} and ${c.to}${c.days ? ' on ' + c.days.map(d => DAYS[d]).join(', ') : ''}`;
  const m = catalog.metrics.find(x => x.name === c.metric);
  return `${c.metric} ${OPS[c.operator]} ${c.value}${m && m.unit ? ' ' + m.unit : ''}${c.hysteresis ? ` (margin ${c.hysteresis})` : ''}`;
}
function stepText(s) {
  const t = targetOf(s.target);
  const name = t ? `${t.label} (${t.device})` : s.target.entity;
  if (s.op === 'set') {
    const opt = t && t.options && t.options.find(o => o.value === String(s.value));
    return `set ${name} to ${opt ? opt.label : s.value}${t && t.unit && !opt ? ' ' + t.unit : ''}`;
  }
  return `turn ${name} ${s.op}`;
}
function forText(sec) { return sec >= 120 && sec % 60 === 0 ? `${sec / 60} minutes` : `${sec} seconds`; }
function sentence(a) {
  const when = a.when.map(condText).join(a.join === 'any' ? ' or ' : ' and ');
  const parts = [h('span', {}, 'When ', h('b', {}, when), a.for_s ? ` for ${forText(a.for_s)}` : '', ': ', h('b', {}, a.then.map(stepText).join('; then ')), '.')];
  if (a.else && a.else.length) parts.push(' Otherwise: ', h('b', {}, a.else.map(stepText).join('; then ')), '.');
  return parts;
}

// ── List ──
function statusOf(a) {
  if (!a.enabled) return { text: 'Off', cls: '' };
  if (data.paused) return { text: 'All paused', cls: '' };
  if (a.takenOver) return { text: a.paused_until === -1 ? 'Taken over' : 'Taken over until ' + new Date(a.paused_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), cls: '' };
  const s = a.status;
  if (!s) return { text: 'Starting', cls: 'is-warn' };
  if (s.note) return { text: s.pending ? 'Waiting' : 'Waiting for data', cls: 'is-warn' };
  return { text: s.active ? 'Conditions met' : 'Conditions not met', cls: 'is-ok' };
}
async function takeOver(a, how) {
  const r = await api('POST', `/${a.id}/takeover`, how);
  say('au-msg', r.ok ? `You have taken over from "${a.name}". It will not change anything until ${how.untilResumed ? 'you resume it' : 'the hour is up'}.` : r.data.error, !r.ok);
  load();
}
function card(a) {
  const st = statusOf(a);
  const needsUnlock = () => { if (!unlocked()) { say('au-msg', 'Unlock first (top of the page).', true); return true; } return false; };
  const actions = h('div', { class: 'au-actions' },
    a.enabled
      ? h('button', { type: 'button', class: 'st-btn', onclick: async () => { const r = await api('POST', `/${a.id}/disable`); say('au-msg', r.ok ? `"${a.name}" is off.` : r.data.error, !r.ok); load(); } }, 'Turn off')
      : h('button', { type: 'button', class: 'st-btn st-btn-primary', onclick: async () => {
        if (needsUnlock()) return;
        if (!await ask({ title: `Turn on "${a.name}"?`, text: 'It will change your devices by itself from now on, even when "Allow device changes" is off. Use "Test" first to see what it would do right now.', ok: 'Turn on' })) return;
        const r = await api('POST', `/${a.id}/enable`); say('au-msg', r.ok ? `"${a.name}" is on.` : r.data.error, !r.ok); load();
      } }, 'Turn on'),
    a.enabled && (a.takenOver
      ? h('button', { type: 'button', class: 'st-btn', onclick: async () => { await api('POST', `/${a.id}/resume`); load(); } }, 'Resume')
      : [h('button', { type: 'button', class: 'st-btn', title: 'Stop this automation for an hour so you can change its settings by hand', onclick: () => takeOver(a, { hours: 1 }) }, 'Take over for 1 h'),
        h('button', { type: 'button', class: 'st-btn', title: 'Stop this automation until you resume it', onclick: () => takeOver(a, { untilResumed: true }) }, 'Take over until I resume')]),
    h('button', { type: 'button', class: 'st-btn', onclick: () => testIt(a) }, 'Test'),
    h('button', { type: 'button', class: 'st-btn', onclick: () => openEditor(a) }, 'Edit'),
    h('button', { type: 'button', class: 'st-btn st-btn-danger', onclick: async () => {
      if (!await ask({ title: `Delete "${a.name}"?`, text: 'It stops at once. Devices stay as they are.', ok: 'Delete' })) return;
      await api('DELETE', `/${a.id}`); load();
    } }, 'Delete'));
  return h('article', { class: 'au-card' + (a.enabled ? '' : ' is-off') },
    h('div', { class: 'au-card-top' }, h('h3', { class: 'au-name' }, a.name), h('span', { class: 'st-badge ' + st.cls }, st.text)),
    h('p', { class: 'au-sentence' }, sentence(a)),
    a.enabled && a.status && a.status.note ? h('p', { class: 'au-note' }, a.status.note) : null,
    actions, h('div', { class: 'au-result', hidden: true, id: `au-test-${a.id}` }));
}
function render() {
  const list = $('au-list');
  list.replaceChildren(...(data.automations.length ? data.automations.map(card) : [h('p', { class: 'au-empty' }, 'No automations yet. Choose "New automation" to make one.')]));
  $('au-pause').checked = data.paused;
}
async function load() {
  const r = await api('GET', '');
  if (!r.ok) return;
  clockSkew = Date.now() - r.data.now;
  data = { ...r.data, unlockedUntil: data.unlockedUntil };
  if (r.data.unlockedUntil) setLock(r.data.unlockedUntil);
  if (!editingId || !$('au-editor').contains(document.activeElement)) render();
}
$('au-pause').addEventListener('change', async e => {
  const want = e.target.checked;
  e.target.checked = !want;   // the switch moves once the server agrees
  if (!want && !unlocked()) return say('au-msg', 'Unlock first (top of the page).', true);
  const r = await api('POST', '/pause-all', { paused: want });
  if (r.ok) { data = { ...data, ...r.data }; render(); say('au-msg', data.paused ? 'All automations are paused.' : 'Automations are running again.'); } else say('au-msg', r.data.error, true);
});

function showResult(el, res) {
  const parts = res.parts || [];
  const met = res.met === null ? 'cannot be decided yet' : res.met ? 'met' : 'not met';
  const why = parts.filter(p => p.met === null && p.reason).map(p => p.reason);
  el.hidden = false;
  el.replaceChildren(h('b', {}, `Right now the conditions are ${met}.`), why.length ? ` ${why.join('. ')}.` : '',
    res.branch ? h('ul', {}, ...(res.steps.length ? res.steps.map(s => h('li', {}, `${s.target} → ${s.wanted}: `, s.error ? s.error : s.wouldSend ? `would be sent${s.current === null ? '' : ' (now ' + s.current + ')'}` : 'already set'))
      : [h('li', {}, 'Nothing to do on this side.')])) : null,
    res.met && res.forSeconds ? h('p', { class: 'au-note' }, `It would wait ${forText(res.forSeconds)} first.`) : null,
    h('p', { class: 'au-note' }, 'Nothing was sent.'));
}
async function testIt(a) {
  const el = $(`au-test-${a.id}`);
  el.hidden = false; el.textContent = 'Checking…';
  const r = await api('POST', '/dry-run', a);
  if (!r.ok) { el.textContent = r.data.error || 'Could not test it'; return; }
  showResult(el, r.data);
}

// ── Editor ──
// Laid out as the sentence it makes: When (one line per condition), Then, Otherwise (one line per action).
const blankCond = () => ({ type: 'metric', metric: '', operator: 'gt', value: '' });
const blankStep = () => ({ target: null, op: 'on', value: '' });
function openEditor(a) {
  editingId = a ? a.id : null;
  draft = a ? JSON.parse(JSON.stringify({ name: a.name, enabled: a.enabled, join: a.join, for_s: a.for_s, max_age_s: a.max_age_s, when: a.when, then: a.then, else: a.else || [] }))
    : { name: '', enabled: false, join: 'all', for_s: 0, max_age_s: 900, when: [blankCond()], then: [blankStep()], else: [] };
  $('au-editor-title').textContent = a ? `Edit "${a.name}"` : 'New automation';
  $('au-editor').hidden = false;
  drawEditor();
  $('au-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closeEditor() { $('au-editor').hidden = true; draft = null; editingId = null; render(); }

const num = v => (v === '' || v === null || v === undefined ? '' : v);
function field(label, input, cls) { const id = 'au-f' + Math.random().toString(36).slice(2, 8); input.id = id; return h('div', { class: 'st-field ' + (cls || '') }, h('label', { for: id }, label), input); }

/** The sentence under the name, as far as the draft is filled in. */
function updateSummary() {
  const el = $('au-says');
  if (!el || !draft) return;
  const ready = draft.when.length && draft.when.every(c => c.type === 'time' || (c.metric && c.value !== '')) && draft.then.length && draft.then.every(x => x.target && (x.op !== 'set' || x.value !== ''));
  el.hidden = !ready;
  if (!ready) return;
  const d = { ...draft, for_s: Number(draft.for_s) || 0, else: draft.else.filter(x => x.target) };
  el.replaceChildren(h('small', {}, 'In plain words'), ...sentence(d));
}
const touch = fn => e => { fn(e); updateSummary(); };

function lineButtons(list, i, what) {
  const move = (dir, label) => h('button', { type: 'button', class: 'st-btn au-move', 'aria-label': label, onclick: () => { const j = i + dir; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; drawEditor(true); } }, dir < 0 ? '↑' : '↓');
  return [list.length > 1 && what === 'action' ? [move(-1, `Move action ${i + 1} up`), move(1, `Move action ${i + 1} down`)] : null,
    h('button', { type: 'button', class: 'st-btn st-btn-danger-text au-remove', 'aria-label': `Remove ${what} ${i + 1}`, onclick: () => { list.splice(i, 1); drawEditor(true); } }, 'Remove')];
}

/** Only a threshold with a number has a margin. */
const marginable = c => ['gt', 'gte', 'lt', 'lte'].includes(c.operator);
const trim = n => String(Math.round(n * 1e6) / 1e6);
/** The margin is kept as a distance; it is shown as the level the reading has to get back past. */
function marginLine(c, m) {
  const up = c.operator === 'gt' || c.operator === 'gte', v = Number(c.value);
  if (c.value === '' || !Number.isFinite(v)) return h('div', { class: 'au-sub' }, 'Set the value above first, then the margin.');
  const hasMargin = c.hysteresis !== undefined && c.hysteresis !== '' && Number.isFinite(Number(c.hysteresis));
  const level = hasMargin ? trim(up ? v - Number(c.hysteresis) : v + Number(c.hysteresis)) : '';
  return h('div', { class: 'au-sub' }, up ? 'Stays true until it drops below' : 'Stays true until it rises above',
    h('input', { class: 'au-num', 'aria-label': 'Level the reading has to get back past', value: level, inputmode: 'decimal', onchange: touch(e => {
      const x = Number(e.target.value);
      c.hysteresis = e.target.value === '' || !Number.isFinite(x) ? '' : String(Math.max(0, Math.abs(v - x)));
    }) }), m && m.unit ? h('span', {}, m.unit) : null, h('span', { class: 'au-hint' }, '· a margin, so it does not flap'));
}

function condRow(c, i) {
  const lab = h('span', { class: 'au-lab' }, i === 0 ? 'IF' : draft.join === 'any' ? 'OR' : 'AND');
  // One list for what the condition looks at: a reading, or the time of day.
  const names = catalog.metrics.map(m => m.name);
  if (c.type === 'metric' && c.metric && !names.includes(c.metric)) names.unshift(c.metric);
  const type = h('select', { class: 'au-type', 'aria-label': 'Reading or time of day', onchange: e => {
    const v = e.target.value;
    if (v === '\u0000time') draft.when[i] = { type: 'time', from: '09:00', to: '16:00' };
    else if (c.type === 'metric') c.metric = v;
    else draft.when[i] = { ...blankCond(), metric: v };
    drawEditor(true); updateSummary();
  } }, c.type === 'metric' && !c.metric ? h('option', { value: '' }, 'Choose a reading…') : null,
  names.map(n => h('option', { value: n, selected: c.type === 'metric' && c.metric === n }, n)),
  h('option', { value: '\u0000time', selected: c.type === 'time' }, 'Time of day'));
  if (c.type === 'time') {
    const days = h('span', { class: 'au-days' }, DAYS.map((d, n) => {
      const on = !c.days || c.days.includes(n);
      return h('button', { type: 'button', class: 'au-day', 'aria-pressed': String(on), onclick: e => {
        const set = new Set(c.days || [0, 1, 2, 3, 4, 5, 6]); on ? set.delete(n) : set.add(n);
        c.days = set.size === 7 || set.size === 0 ? undefined : [...set].sort(); e.currentTarget.setAttribute('aria-pressed', String(!on)); drawEditor(true);
      } }, d);
    }));
    return h('div', { class: 'au-cond' },
      h('div', { class: 'au-line' }, lab, type, h('span', { class: 'au-t' }, 'between'),
        h('input', { type: 'time', 'aria-label': 'From', value: c.from, onchange: touch(e => { c.from = e.target.value; }) }), h('span', { class: 'au-t' }, 'and'),
        h('input', { type: 'time', 'aria-label': 'To', value: c.to, onchange: touch(e => { c.to = e.target.value; }) }),
        h('span', { class: 'au-sp' }), lineButtons(draft.when, i, 'condition')),
      h('div', { class: 'au-sub' }, 'On these days', days));
  }
  const m = catalog.metrics.find(x => x.name === c.metric);
  const more = marginable(c) ? h('button', { type: 'button', class: 'st-btn au-more', 'aria-expanded': String(!!c._more), onclick: () => { c._more = !c._more; drawEditor(true); } }, 'More') : null;
  const showMargin = c._more || (c.hysteresis !== undefined && c.hysteresis !== '');
  return h('div', { class: 'au-cond' },
    h('div', { class: 'au-line' }, lab, type,
      h('select', { 'aria-label': 'Is', onchange: e => { c.operator = e.target.value; drawEditor(true); updateSummary(); } }, Object.entries(OPS).map(([k, v]) => h('option', { value: k, selected: c.operator === k }, v))),
      h('input', { class: 'au-num', 'aria-label': 'Value', value: num(c.value), inputmode: 'decimal', onchange: touch(e => { c.value = e.target.value; }) }),
      m && m.unit ? h('span', { class: 'au-t' }, m.unit) : null,
      c.metric ? h('span', { class: 'au-now' }, m ? `now ${typeof m.value === 'number' ? m.value.toLocaleString() : m.value}${m.unit ? ' ' + m.unit : ''}${m.ageS >= 90 ? ` (${Math.round(m.ageS / 60)} min ago)` : ''}` : 'no reading yet') : null,
      h('span', { class: 'au-sp' }), more, lineButtons(draft.when, i, 'condition')),
    showMargin && marginable(c) ? marginLine(c, m) : null);
}

function valueInput(entry, s) {
  if (s.op !== 'set' || !entry) return null;
  if (entry.kind === 'number') return [
    h('input', { class: 'au-num', type: 'number', 'aria-label': 'Value', min: entry.min, max: entry.max, step: entry.step || 'any', value: num(s.value), onchange: touch(e => { s.value = e.target.value; }) }),
    entry.unit ? h('span', { class: 'au-t' }, entry.unit) : null,
    h('span', { class: 'au-hint' }, `${entry.min}–${entry.max}, step ${entry.step}`)];
  if (entry.kind === 'select') return h('select', { 'aria-label': 'Value', onchange: touch(e => { s.value = e.target.value; }) }, h('option', { value: '' }, 'Choose…'), entry.options.map(o => h('option', { value: o.value, selected: String(s.value) === o.value }, o.label)));
  return h('input', { class: 'au-num', 'aria-label': 'Value', value: num(s.value), onchange: touch(e => { s.value = e.target.value; }) });
}
function stepRow(list, s, i) {
  const entry = s.target && targetOf(s.target);
  const groups = [...new Set(catalog.targets.map(t => t.group))];
  const sel = h('select', { class: 'au-device', 'aria-label': 'Device or setting', onchange: e => {
    const t = catalog.targets.find(x => x.key === e.target.value);
    s.target = t ? { source: t.source, device: t.device, entity: t.entity } : null;
    s.op = t ? t.ops[0] : 'on'; s.value = ''; drawEditor(true); updateSummary();
  } }, h('option', { value: '' }, 'Choose a device or setting…'),
  groups.map(g => h('optgroup', { label: g }, catalog.targets.filter(t => t.group === g).map(t => h('option', { value: t.key, selected: !!entry && entry.key === t.key }, t.label)))));
  const opSel = entry ? h('select', { 'aria-label': 'Action', onchange: e => { s.op = e.target.value; drawEditor(true); updateSummary(); } },
    entry.ops.map(o => h('option', { value: o, selected: s.op === o }, o === 'set' ? 'Set to' : o === 'on' ? 'Turn on' : 'Turn off'))) : null;
  return h('div', { class: 'au-line' }, h('span', { class: 'au-idx' }, String(i + 1)), sel, opSel, valueInput(entry, s), h('span', { class: 'au-sp' }), lineButtons(list, i, 'action'));
}

/** "True for" is kept in seconds; shown in minutes when it is a whole number of them. */
function forShown() { const sec = Number(draft.for_s) || 0; return sec >= 60 && sec % 60 === 0 ? { n: sec / 60, unit: 'minutes' } : { n: sec, unit: 'seconds' }; }
function setFor(n, unit) { const x = Number(n); draft.for_s = Number.isFinite(x) && x >= 0 ? Math.round(x * (unit === 'minutes' ? 60 : 1)) : 0; }

function drawEditor(keepFocus) {
  const f = $('au-form');
  const stepBlock = (key, n, title, help, addLabel) => h('section', { class: 'au-step' },
    h('h3', {}, h('span', { class: 'au-n' }, n), title, key === 'else' ? h('span', { class: 'au-opt' }, 'optional') : null), h('p', { class: 'st-help' }, help),
    draft[key].map((s, i) => stepRow(draft[key], s, i)),
    h('button', { type: 'button', class: 'st-btn au-add', onclick: () => { draft[key].push(blankStep()); drawEditor(true); } }, addLabel));
  const choice = (value, label) => h('button', { type: 'button', 'aria-pressed': String(draft.join === value), onclick: () => { draft.join = value; drawEditor(true); updateSummary(); } }, label);
  f.replaceChildren(
    h('datalist', { id: 'au-metrics' }, catalog.metrics.map(m => h('option', { value: m.name }))),
    field('Name', h('input', { value: draft.name, maxlength: 80, required: true, onchange: touch(e => { draft.name = e.target.value; }) })),
    h('p', { class: 'au-says', id: 'au-says', hidden: true }),
    h('section', { class: 'au-step' },
      h('h3', {}, h('span', { class: 'au-n' }, '1'), 'When'),
      h('p', { class: 'st-help au-checked' }, 'Checked about every 15 seconds. ', h('span', { class: 'au-choice', role: 'group', 'aria-label': 'How the conditions combine' }, choice('all', 'All of these'), choice('any', 'Any of these'))),
      draft.when.map((c, i) => condRow(c, i)),
      h('button', { type: 'button', class: 'st-btn au-add', onclick: () => { draft.when.push(blankCond()); drawEditor(true); } }, '+ Add a condition'),
      h('div', { class: 'au-inline au-first' }, 'Act only once it has been true for', h('input', { class: 'au-num', type: 'number', min: 0, step: 1, 'aria-label': 'How long the conditions must hold', value: forShown().n, onchange: touch(e => { setFor(e.target.value, $('au-for-unit').value); }) }),
        h('select', { id: 'au-for-unit', 'aria-label': 'Unit', onchange: touch(e => { setFor($('au-for-unit').previousSibling.value, e.target.value); }) }, h('option', { value: 'seconds', selected: forShown().unit === 'seconds' }, 'seconds'), h('option', { value: 'minutes', selected: forShown().unit === 'minutes' }, 'minutes'))),
      h('div', { class: 'au-inline' }, 'Ignore a reading older than', h('input', { class: 'au-num', type: 'number', min: 1, step: 1, value: Math.round(draft.max_age_s / 60), 'aria-label': 'Minutes after which a reading is ignored', onchange: e => { draft.max_age_s = Number(e.target.value) * 60; } }), 'minutes. If a reading is older, nothing happens.')),
    stepBlock('then', '2', 'Then', 'Kept like this while the conditions hold. Several actions run in order.', '+ Add another action'),
    stepBlock('else', '3', 'Otherwise', 'Kept like this when the conditions stop holding.', '+ Add an action'),
    h('div', { class: 'au-result', id: 'au-editor-result', hidden: true }),
    h('div', { class: 'au-bar' },
      h('button', { type: 'submit', class: 'st-btn st-btn-primary' }, editingId ? 'Save changes' : 'Save (turned off)'),
      h('button', { type: 'button', class: 'st-btn', onclick: async () => {
        const r = await api('POST', '/dry-run', clean()); if (!r.ok) return say('au-editor-msg', r.data.error, true); say('au-editor-msg', ''); showResult($('au-editor-result'), r.data);
      } }, 'Test now'),
      h('button', { type: 'button', class: 'st-btn', onclick: closeEditor }, 'Cancel'),
      h('span', { class: 'st-help au-bar-msg', id: 'au-editor-msg', role: 'status', 'aria-live': 'polite' }),
      h('span', { class: 'st-help au-bar-hint' }, 'Test reads your devices and sends nothing.')));
  updateSummary();
  if (!keepFocus) $('au-form').querySelector('input')?.focus();
}
function clean() {
  const c = JSON.parse(JSON.stringify(draft));
  c.for_s = c.for_s === '' ? 0 : Number(c.for_s);
  c.when = c.when.map(x => { const y = { ...x, hysteresis: x.hysteresis === '' ? undefined : x.hysteresis }; delete y._more; return y; });
  for (const k of ['then', 'else']) c[k] = c[k].filter(s => s.target).map(s => (s.op === 'set' ? s : { target: s.target, op: s.op }));
  return c;
}
$('au-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!unlocked()) return say('au-editor-msg', 'Unlock first (top of the page).', true);
  const r = editingId ? await api('PUT', `/${editingId}`, clean()) : await api('POST', '', clean());
  if (!r.ok) return say('au-editor-msg', r.data.error || 'Could not save', true);
  say('au-msg', editingId ? 'Saved.' : 'Saved. It is turned off: use "Test", then "Turn on".');
  closeEditor(); load();
});
$('au-new').addEventListener('click', () => openEditor(null));

// ── Log ──
async function loadLog() {
  const r = await api('GET', '/runs?limit=50');
  const tb = $('au-log').querySelector('tbody');
  const rows = (r.data.runs || []).map(x => h('tr', {}, h('td', {}, new Date(x.ts).toLocaleString()), h('td', {}, x.name || ''), h('td', {}, `${x.target || ''} → ${x.wanted || ''}`), h('td', {}, x.outcome === 'done' ? (x.detail || 'Done') : `${x.outcome}: ${x.detail || ''}`)));
  tb.replaceChildren(...(rows.length ? rows : [h('tr', {}, h('td', { colspan: 4 }, 'Nothing yet.'))]));
}
$('au-log-refresh').addEventListener('click', loadLog);

// ── Theme and menu (the same behaviour as Settings) ──
const mql = window.matchMedia('(prefers-color-scheme: dark)');
const storedTheme = () => { try { return localStorage.getItem('theme') || localStorage.getItem('epilykos-theme'); } catch { return null; } };
function applyTheme(choice) {
  document.documentElement.setAttribute('data-theme', choice === 'auto' ? (mql.matches ? 'dark' : 'light') : choice);
  document.querySelectorAll('[data-theme-choice]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.themeChoice === choice)));
}
function setTheme(choice) {
  try {
    if (choice === 'auto') { localStorage.removeItem('theme'); localStorage.removeItem('epilykos-theme'); }
    else { localStorage.setItem('theme', choice); localStorage.setItem('epilykos-theme', choice); }
  } catch { /* private mode */ }
  applyTheme(choice);
}
{
  const t = storedTheme();
  applyTheme(t === 'light' || t === 'dark' ? t : 'auto');
  mql.addEventListener('change', () => { if (!storedTheme()) applyTheme('auto'); });
  $('st-theme').addEventListener('click', e => { const b = e.target.closest('[data-theme-choice]'); if (b) setTheme(b.dataset.themeChoice); });
}
function openNav() { document.body.classList.add('st-nav-open'); $('st-scrim').hidden = false; $('st-nav-open').setAttribute('aria-expanded', 'true'); }
function closeNav() {
  if (!document.body.classList.contains('st-nav-open')) return;
  document.body.classList.remove('st-nav-open'); $('st-scrim').hidden = true; $('st-nav-open').setAttribute('aria-expanded', 'false');
}
$('st-nav-open').addEventListener('click', openNav);
$('st-nav-close').addEventListener('click', closeNav);
$('st-scrim').addEventListener('click', closeNav);
$('st-nav-list').addEventListener('click', closeNav);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNav(); });
(async () => {
  const c = await api('GET', '/catalog');
  if (c.ok) catalog = c.data;
  await load(); loadLog();
  setInterval(() => { load(); loadLog(); }, REFRESH_MS);
})();
