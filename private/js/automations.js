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

function condRow(c, i) {
  const del = h('button', { type: 'button', class: 'st-btn', 'aria-label': `Remove condition ${i + 1}`, onclick: () => { draft.when.splice(i, 1); drawEditor(); } }, 'Remove');
  const type = h('select', { onchange: e => { draft.when[i] = e.target.value === 'time' ? { type: 'time', from: '09:00', to: '16:00' } : blankCond(); drawEditor(); } },
    h('option', { value: 'metric', selected: c.type === 'metric' }, 'A reading'), h('option', { value: 'time', selected: c.type === 'time' }, 'Time of day'));
  if (c.type === 'time') {
    const days = h('div', { class: 'au-days' }, DAYS.map((d, n) => h('label', {}, h('input', { type: 'checkbox', checked: !c.days || c.days.includes(n), onchange: e => {
      const set = new Set(c.days || [0, 1, 2, 3, 4, 5, 6]); e.target.checked ? set.add(n) : set.delete(n);
      c.days = set.size === 7 || set.size === 0 ? undefined : [...set].sort();
    } }), d)));
    return h('div', { class: 'au-row' }, field('Type', type, 'au-narrow'),
      field('From', h('input', { type: 'time', value: c.from, onchange: e => { c.from = e.target.value; } })), field('To', h('input', { type: 'time', value: c.to, onchange: e => { c.to = e.target.value; } })),
      h('div', { class: 'st-field' }, h('label', {}, 'Days'), days), del);
  }
  const listId = 'au-metrics';
  return h('div', { class: 'au-row' }, field('Type', type, 'au-narrow'),
    field('Reading', h('input', { list: listId, value: c.metric, onchange: e => { c.metric = e.target.value.trim(); drawEditor(true); } })),
    field('Is', h('select', { onchange: e => { c.operator = e.target.value; } }, Object.entries(OPS).map(([k, v]) => h('option', { value: k, selected: c.operator === k }, v))), 'au-narrow'),
    field('Value', h('input', { value: num(c.value), inputmode: 'decimal', onchange: e => { c.value = e.target.value; } }), 'au-narrow'),
    field('Margin (optional)', h('input', { value: num(c.hysteresis), inputmode: 'decimal', title: 'Once true, it stays true until the reading is this far back past the value (stops flapping)', onchange: e => { c.hysteresis = e.target.value; } }), 'au-narrow'),
    (() => { const m = catalog.metrics.find(x => x.name === c.metric); return h('p', { class: 'au-note', style: 'flex-basis:100%;margin:0' }, c.metric ? (m ? `Now: ${m.value}${m.unit ? ' ' + m.unit : ''} (updated ${m.ageS < 90 ? m.ageS + ' s' : Math.round(m.ageS / 60) + ' min'} ago)` : 'No reading with that name yet.') : ''); })(),
    del);
}

function valueInput(entry, s) {
  if (s.op !== 'set' || !entry) return null;
  if (entry.kind === 'number') return field(`Value${entry.unit ? ' (' + entry.unit + ')' : ''}`, h('input', { type: 'number', min: entry.min, max: entry.max, step: entry.step || 'any', value: num(s.value), onchange: e => { s.value = e.target.value; } }), 'au-narrow');
  if (entry.kind === 'select') return field('Value', h('select', { onchange: e => { s.value = e.target.value; } }, h('option', { value: '' }, 'Choose…'), entry.options.map(o => h('option', { value: o.value, selected: String(s.value) === o.value }, o.label))));
  return field('Value', h('input', { value: num(s.value), onchange: e => { s.value = e.target.value; } }), 'au-narrow');
}
function stepRow(list, s, i) {
  const entry = s.target && targetOf(s.target);
  const groups = [...new Set(catalog.targets.map(t => t.group))];
  const sel = h('select', { onchange: e => {
    const t = catalog.targets.find(x => x.key === e.target.value);
    s.target = t ? { source: t.source, device: t.device, entity: t.entity } : null;
    s.op = t ? t.ops[0] : 'on'; s.value = ''; drawEditor(true);
  } }, h('option', { value: '' }, 'Choose a device or setting…'),
  groups.map(g => h('optgroup', { label: g }, catalog.targets.filter(t => t.group === g).map(t => h('option', { value: t.key, selected: !!entry && entry.key === t.key }, t.label)))));
  const ops = entry ? entry.ops : [];
  const opSel = h('select', { onchange: e => { s.op = e.target.value; drawEditor(true); } }, ops.map(o => h('option', { value: o, selected: s.op === o }, o === 'set' ? 'Set to' : o === 'on' ? 'Turn on' : 'Turn off')));
  const move = (d, label) => h('button', { type: 'button', class: 'st-btn', 'aria-label': label, onclick: () => { const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; drawEditor(true); } }, d < 0 ? '↑' : '↓');
  return h('div', { class: 'au-row' }, field('Device or setting', sel), entry ? field('Action', opSel, 'au-narrow') : null, valueInput(entry, s),
    list.length > 1 ? [move(-1, `Move action ${i + 1} up`), move(1, `Move action ${i + 1} down`)] : null,
    h('button', { type: 'button', class: 'st-btn', 'aria-label': `Remove action ${i + 1}`, onclick: () => { list.splice(i, 1); drawEditor(true); } }, 'Remove'));
}

function drawEditor(keepFocus) {
  const f = $('au-form');
  const stepsBlock = (key, title, help) => h('div', { class: 'au-block' }, h('h3', {}, title), help ? h('p', { class: 'st-help' }, help) : null,
    draft[key].map((s, i) => stepRow(draft[key], s, i)),
    h('div', {}, h('button', { type: 'button', class: 'st-btn', onclick: () => { draft[key].push(blankStep()); drawEditor(true); } }, key === 'then' ? 'Add another action' : 'Add an action')));
  f.replaceChildren(
    h('datalist', { id: 'au-metrics' }, catalog.metrics.map(m => h('option', { value: m.name }))),
    h('div', { class: 'au-form-grid' },
      field('Name', h('input', { value: draft.name, maxlength: 80, required: true, onchange: e => { draft.name = e.target.value; } })),
      h('div', { class: 'au-block' }, h('h3', {}, 'When'),
        h('div', { class: 'au-inline' }, 'These must be true:', h('select', { onchange: e => { draft.join = e.target.value; } },
          h('option', { value: 'all', selected: draft.join === 'all' }, 'All of them'), h('option', { value: 'any', selected: draft.join === 'any' }, 'Any one of them'))),
        draft.when.map((c, i) => condRow(c, i)),
        h('div', {}, h('button', { type: 'button', class: 'st-btn', onclick: () => { draft.when.push(blankCond()); drawEditor(true); } }, 'Add a condition')),
        h('div', { class: 'au-inline' }, 'and have held for at least', h('input', { type: 'number', min: 0, step: 1, value: draft.for_s, 'aria-label': 'Seconds the conditions must hold', onchange: e => { draft.for_s = e.target.value; } }), 'seconds.'),
        h('div', { class: 'au-inline' }, 'Ignore readings older than', h('input', { type: 'number', min: 1, step: 1, value: Math.round(draft.max_age_s / 60), 'aria-label': 'Minutes after which a reading is ignored', onchange: e => { draft.max_age_s = Number(e.target.value) * 60; } }), 'minutes.'),
        h('p', { class: 'st-help' }, 'If a reading is older than this, the automation does nothing.')),
      stepsBlock('then', 'Then', 'Kept like this while the conditions hold. Several actions run in order, e.g. the settings that together switch grid charging on.'),
      stepsBlock('else', 'Otherwise (optional)', 'Kept like this when the conditions do not hold. Leave empty to leave things as they are.'),
      h('div', { class: 'au-result', id: 'au-editor-result', hidden: true }),
      h('p', { class: 'st-help', id: 'au-editor-msg', role: 'status', 'aria-live': 'polite' }),
      h('div', { class: 'au-form-actions' },
        h('button', { type: 'button', class: 'st-btn', onclick: async () => {
          const r = await api('POST', '/dry-run', clean()); if (!r.ok) return say('au-editor-msg', r.data.error, true); say('au-editor-msg', ''); showResult($('au-editor-result'), r.data);
        } }, 'Test now'),
        h('button', { type: 'submit', class: 'st-btn st-btn-primary' }, editingId ? 'Save changes' : 'Save (turned off)'),
        h('button', { type: 'button', class: 'st-btn', onclick: closeEditor }, 'Cancel'))));
  if (!keepFocus) $('au-form').querySelector('input')?.focus();
}
function clean() {
  const c = JSON.parse(JSON.stringify(draft));
  c.for_s = c.for_s === '' ? 0 : Number(c.for_s);
  c.when = c.when.map(x => (x.type === 'metric' ? { ...x, value: x.value === '' ? x.value : x.value, hysteresis: x.hysteresis === '' ? undefined : x.hysteresis } : x));
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
