/**
 * Controls page: unlock, safety switches, the dashboards' switch and
 * selector cards, device settings (read → check → change → read back), expert
 * register writes and the change log. The server enforces every rule; this
 * page only explains them and asks before each change.
 *
 * @module controls
 */
import { controlBuilders } from '/js/components/index.js';
import { updateCards } from '/js/cards-update.js';
import { initTheme, toggleTheme } from '/js/theme.js';

const $ = id => document.getElementById(id);
const STATE_REFRESH_MS = 10000;

async function api(path, body) {
  const res = await fetch('/api/controls' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body)
  });
  if (res.status === 401 && !path.startsWith('/unlock')) { location.href = '/login'; throw new Error('Signed out'); }
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 423) setStatus({ ...status, unlockedUntil: null });
  return { ok: res.ok, status: res.status, data };
}

// ── Dialog ────────────────────────────────────────────────────────────────

function ask({ title, text, ok, danger = false, check = '' }) {
  const dlg = $('ct-dialog');
  $('ct-dialog-title').textContent = title;
  $('ct-dialog-text').textContent = text;
  const okBtn = $('ct-dialog-ok');
  okBtn.textContent = ok;
  okBtn.className = 'ct-btn ' + (danger ? 'ct-btn-danger' : 'ct-btn-primary');
  const wrap = $('ct-dialog-check-wrap'), box = $('ct-dialog-check');
  wrap.hidden = !check; box.checked = false; $('ct-dialog-check-text').textContent = check;
  okBtn.disabled = !!check;
  box.onchange = () => { okBtn.disabled = !box.checked; };
  return new Promise(resolve => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.returnValue = 'cancel';
    dlg.showModal();
    $('ct-dialog-cancel').focus();
  });
}

// ── Lock and switches ─────────────────────────────────────────────────────

let status = { unlockedUntil: null, writesEnabled: false, expertEnabled: false, unlockMinutes: 5 };
let clockSkew = 0, countdown = null;
const unlocked = () => !!status.unlockedUntil && status.unlockedUntil + clockSkew > Date.now();

function setStatus(s) {
  status = { ...status, ...s };
  if (s.now) clockSkew = Date.now() - s.now;
  const on = unlocked();
  $('ct-lock').classList.toggle('is-unlocked', on);
  $('ct-unlock-form').hidden = on;
  $('ct-lock-now').hidden = !on;
  $('ct-lock-title').textContent = on ? 'Changes are unlocked' : 'Changes are locked';
  clearInterval(countdown);
  const tick = () => {
    if (!unlocked()) { clearInterval(countdown); if (on) setStatus({ unlockedUntil: null }); return; }
    const left = Math.max(0, Math.round((status.unlockedUntil + clockSkew - Date.now()) / 1000));
    $('ct-lock-text').textContent = `They lock again in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}, or when you sign out.`;
  };
  if (on) { tick(); countdown = setInterval(tick, 1000); }
  else $('ct-lock-text').textContent = `Enter your password to unlock changes for ${status.unlockMinutes} minutes. Reading values doesn't need it.`;
  for (const [id, value] of [['ct-allow', status.writesEnabled], ['ct-expert', status.expertEnabled]]) {
    const b = $(id);
    b.setAttribute('aria-checked', String(!!value));
    b.textContent = value ? 'On' : 'Off';
    b.disabled = !on || (id === 'ct-expert' && !status.writesEnabled);
  }
  $('ct-expert-section').hidden = !status.expertEnabled;
  document.querySelectorAll('[data-needs-unlock]').forEach(el => { el.disabled = !on || !status.writesEnabled; });
  $('ct-cards').toggleAttribute('inert', !on);
  $('ct-cards').classList.toggle('is-locked', !on);
}

$('ct-unlock-form').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = $('ct-password');
  const r = await api('/unlock', { password: pw.value });
  pw.value = '';
  if (r.ok) { setStatus(r.data); $('ct-lock-msg').textContent = ''; loadLog(); }
  else $('ct-lock-msg').textContent = r.data.error || 'Could not unlock.';
});
$('ct-lock-now').addEventListener('click', async () => { const r = await api('/lock', {}); setStatus(r.data); });

async function flip(which) {
  const isAllow = which === 'enabled';
  const now = isAllow ? status.writesEnabled : status.expertEnabled;
  const yes = await ask(isAllow
    ? (now ? { title: 'Turn off device changes?', text: 'Nothing will be able to change an inverter or battery setting until you turn this on again.', ok: 'Turn off' }
      : { title: 'Allow device changes?', text: 'Settings in each device\'s list can then be changed on this page, and the switch and selector cards will work.', ok: 'Allow', danger: true })
    : (now ? { title: 'Turn off expert register writes?', text: 'Only the settings in each device\'s list can be changed after this.', ok: 'Turn off' }
      : { title: 'Turn on expert register writes?', text: 'This allows writing any value to any register. A wrong register or value can stop an inverter or battery working, or damage it.', ok: 'Turn on', danger: true, check: 'I will only write registers I have checked in my device\'s manual' }));
  if (!yes) return;
  const r = await api('/switches', { [which]: !now });
  $('ct-switch-msg').textContent = r.ok ? '' : (r.data.error || 'Could not change it.');
  if (r.ok) { setStatus(r.data); loadLog(); }
}
$('ct-allow').addEventListener('click', () => flip('enabled'));
$('ct-expert').addEventListener('click', () => flip('expert'));

// ── Switch and selector cards ─────────────────────────────────────────────

let cardTypes = new Set();
async function loadCards() {
  const box = $('ct-cards');
  let config;
  try { config = await (await fetch('/api/dashboard-config')).json(); } catch { config = null; }
  const blocks = [];
  for (const dash of (config && config.dashboards) || []) {
    for (const b of dash.layout || []) if (b && controlBuilders[b.type] && b.enabled !== false) blocks.push({ dash: dash.name || dash.id, block: b });
  }
  box.replaceChildren();
  if (!blocks.length) {
    const p = document.createElement('p'); p.className = 'ct-empty';
    p.textContent = 'No switch or selector cards yet. Add a "Toggle switch" or "State select" block in the layout editor and it shows here.';
    box.appendChild(p); return;
  }
  cardTypes = new Set(blocks.map(x => x.block.type));
  for (const { dash, block } of blocks) {
    const item = document.createElement('div');
    item.className = 'ct-card';
    const where = document.createElement('div');
    where.className = 'ct-card-where'; where.textContent = dash;
    const content = controlBuilders[block.type](block);
    item.append(where, content);
    box.appendChild(item);
  }
  refreshState();
}
async function refreshState() {
  if (!cardTypes.size) return;
  try { updateCards(await (await fetch('/api/dashboard-state')).json(), cardTypes); } catch { /* keep the last values */ }
}

// ── Device settings ───────────────────────────────────────────────────────

const fmt = (v, unit) => (v === null || v === undefined ? '—' : `${v}${unit ? ' ' + unit : ''}`);
let devices = [];

function settingRow(dev, s) {
  const row = document.createElement('tr');
  const id = `ct-${dev.name}-${s.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  row.innerHTML = `<th scope="row"><div class="ct-set-name"></div><div class="ct-help"></div></th>
    <td class="ct-current" aria-live="polite">—</td>
    <td><label class="pv-visually-hidden" for="${id}"></label><input type="number" id="${id}" class="ct-input"></td>
    <td class="ct-row-actions"><button type="button" class="ct-btn ct-read">Read</button> <button type="button" class="ct-btn ct-btn-primary ct-change" data-needs-unlock>Change</button></td>`;
  row.querySelector('.ct-set-name').textContent = s.label;
  row.querySelector('.ct-help').textContent = `${s.description} Range ${s.min}–${s.max}${s.unit ? ' ' + s.unit : ''}.`;
  row.querySelector('label').textContent = `New value for ${s.label}`;
  const input = row.querySelector('input');
  Object.assign(input, { min: s.min, max: s.max, step: s.step });
  const cur = row.querySelector('.ct-current');
  const msg = document.createElement('tr');
  msg.className = 'ct-row-msg'; msg.innerHTML = '<td colspan="4" role="status" aria-live="polite"></td>';
  const say = (text, bad = false) => { msg.firstChild.textContent = text; msg.classList.toggle('is-bad', bad); };
  let shown = null;
  const read = async () => {
    cur.textContent = 'Reading…';
    const r = await api('/read', { device: dev.name, setting: s.name });
    if (!r.ok) { cur.textContent = '—'; say(r.data.error || 'Could not read it.', true); return null; }
    shown = r.data.value;
    cur.textContent = fmt(shown, s.unit);
    if (!r.data.inRange) say(`The device reports a value outside ${s.min}–${s.max}${s.unit ? ' ' + s.unit : ''}. This setting can't be changed here until that's checked.`, true);
    else say('');
    if (input.value === '') input.value = shown;
    return shown;
  };
  row.querySelector('.ct-read').addEventListener('click', read);
  row.querySelector('.ct-change').addEventListener('click', async () => {
    const value = input.value.trim();
    if (value === '' || !input.checkValidity()) { say(`Enter a value from ${s.min} to ${s.max}${s.unit ? ' ' + s.unit : ''}, in steps of ${s.step}.`, true); input.focus(); return; }
    if (shown === null && (await read()) === null) return;
    if (Number(value) === shown) { say('That is already the current value.'); return; }
    const yes = await ask({ title: `Change ${s.label}?`, text: `${dev.name}: from ${fmt(shown, s.unit)} to ${fmt(Number(value), s.unit)}. The inverter starts using it straight away.`, ok: 'Change', danger: true });
    if (!yes) return;
    say('Changing…');
    const r = await api('/change', { device: dev.name, setting: s.name, value: Number(value), expected: shown });
    if (r.ok) { shown = r.data.value; cur.textContent = fmt(shown, s.unit); say(r.data.unchanged ? 'It was already set to that.' : `Done. The device now reports ${fmt(shown, s.unit)}.`); }
    else {
      if (r.data.current !== undefined) { shown = r.data.current; cur.textContent = fmt(shown, s.unit); }
      if (r.data.value !== undefined) { shown = r.data.value; cur.textContent = fmt(shown, s.unit); }
      say(r.data.error || 'The change failed.', true);
    }
    loadLog();
  });
  return [row, msg, read];
}

async function loadDevices() {
  const box = $('ct-devices');
  const r = await api('/devices');
  devices = (r.data && r.data.devices) || [];
  if (r.data) setStatus(r.data);
  box.replaceChildren();
  const withSettings = devices.filter(d => d.settings.length);
  for (const dev of withSettings) {
    const card = document.createElement('div');
    card.className = 'ct-device';
    const head = document.createElement('div');
    head.className = 'ct-section-head';
    head.innerHTML = '<h3></h3><button type="button" class="ct-btn">Read all</button>';
    head.querySelector('h3').textContent = `${dev.name} · ${dev.profileName}`;
    const table = document.createElement('table');
    table.className = 'ct-table ct-settings';
    table.innerHTML = '<thead><tr><th scope="col">Setting</th><th scope="col">Now</th><th scope="col">New value</th><th scope="col"><span class="pv-visually-hidden">Actions</span></th></tr></thead><tbody></tbody>';
    const reads = [];
    for (const s of dev.settings) { const [row, msg, read] = settingRow(dev, s); table.tBodies[0].append(row, msg); reads.push(read); }
    head.querySelector('button').addEventListener('click', async () => { for (const read of reads) await read(); });
    const wrap = document.createElement('div'); wrap.className = 'ct-table-wrap'; wrap.appendChild(table);
    card.append(head, wrap);
    box.appendChild(card);
  }
  const without = devices.filter(d => !d.settings.length);
  const p = document.createElement('p');
  p.className = 'ct-empty';
  p.textContent = withSettings.length
    ? (without.length ? `No settings list yet for: ${without.map(d => d.name).join(', ')}.` : '')
    : (devices.length ? `None of your devices has a settings list yet (${devices.map(d => d.name).join(', ')}).` : 'No inverters or batteries are set up yet.');
  if (p.textContent) box.appendChild(p);
  const sel = $('ct-raw-device');
  sel.replaceChildren(...devices.filter(d => d.rawWrites).map(d => new Option(`${d.name} (${d.kind === 'modbus' ? 'Modbus' : d.profileName})`, `${d.kind}:${d.name}`)));
  setStatus({});
}

// ── Expert register writes ────────────────────────────────────────────────

function rawTarget() {
  const v = $('ct-raw-device').value, i = v.indexOf(':');
  return { kind: v.slice(0, i), device: v.slice(i + 1), register: $('ct-raw-register').value.trim() };
}
$('ct-raw-read').addEventListener('click', async () => {
  const t = rawTarget();
  const r = await api('/raw-read', t);
  $('ct-raw-msg').textContent = r.ok ? `Register ${t.register} reads ${r.data.value}.` : (r.data.error || 'Could not read it.');
});
$('ct-raw-form').addEventListener('submit', async e => {
  e.preventDefault();
  const t = rawTarget(), value = $('ct-raw-value').value.trim();
  const yes = await ask({ title: `Write ${value} to register ${t.register}?`, text: `${t.device}. This is not checked against any list of settings.`, ok: 'Write', danger: true, check: `I have checked register ${t.register} in my device's manual` });
  if (!yes) return;
  const r = await api('/raw-write', { ...t, value });
  $('ct-raw-msg').textContent = r.ok
    ? (r.data.after !== null && r.data.after !== undefined ? `Done: ${r.data.before} → ${r.data.after}, read back.` : 'Sent. This connection can\'t read it back, so check it on the device.')
    : (r.data.error || 'The write failed.');
  loadLog();
});

// ── Change log ────────────────────────────────────────────────────────────

const OUTCOME = { done: 'Done', refused: 'Refused', failed: 'Failed', unverified: 'Sent, not checked' };
function whatOf(e) {
  if (e.source === 'unlock') return 'Unlock changes';
  if (e.source === 'expert') return `Register ${e.target} (expert write)`;
  if (String(e.source).startsWith('action:')) return `${e.target || e.label || 'Control'} (switch or selector card)`;
  return e.label || e.target || e.source;
}
async function loadLog() {
  const r = await api('/log?limit=50');
  const body = $('ct-log').tBodies[0];
  body.replaceChildren();
  const entries = (r.data && r.data.entries) || [];
  if (!entries.length) { body.innerHTML = '<tr><td colspan="5" class="ct-empty">Nothing yet.</td></tr>'; return; }
  for (const e of entries) {
    const tr = document.createElement('tr');
    const cells = [
      new Date(e.ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }),
      whatOf(e),
      e.device || '—',
      e.old_value !== null || e.new_value !== null ? `${e.old_value ?? '?'} → ${e.new_value ?? '?'}` : '—',
      `${OUTCOME[e.outcome] || e.outcome}${e.detail ? ': ' + e.detail : ''}`
    ];
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
    tr.classList.add('ct-log-' + e.outcome);
    body.appendChild(tr);
  }
}
$('ct-log-refresh').addEventListener('click', loadLog);

// ── Start ─────────────────────────────────────────────────────────────────

initTheme();
$('theme-toggle')?.addEventListener('click', toggleTheme);
(async () => {
  const s = await api('/status');
  setStatus(s.data);
  await Promise.all([loadDevices(), loadCards(), loadLog()]);
  setInterval(refreshState, STATE_REFRESH_MS);
})();
