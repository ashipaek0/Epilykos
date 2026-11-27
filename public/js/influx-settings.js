/**
 * Settings → InfluxDB: the InfluxDB a user already keeps readings in. Epilykos reads each mapped metric's history from it
 * and writes new readings to it. Talks to /api/influx and saves nothing through the save bar (the cards have
 * data-own-save). Loaded after settings-shell.js. Everything is drawn with textContent.
 */
(function () {
  'use strict';

  var connRoot = document.getElementById('influx-conn-root');
  var mapRoot = document.getElementById('influx-map-root');
  var writeRoot = document.getElementById('influx-write-root');
  var importRoot = document.getElementById('influx-import-root');
  if (!connRoot || !mapRoot || !writeRoot || !importRoot) return;
  var shell = window.stShell || {};
  var data = null;
  var measurements = [];                 // from discovery, for the measurement suggestions
  var seriesInfo = {};                   // measurement → { fields, tagKeys }

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }
  function toast(msg, tone) { if (shell.toast) shell.toast(msg, tone ? { tone: tone } : undefined); }

  function api(path, body) {
    var opts = { headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' }, credentials: 'same-origin' };
    if (body !== undefined) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/api/influx' + path, opts).then(function (res) {
      if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
        return d;
      });
    });
  }

  function field(id, label, attrs, help) {
    var wrap = el('div', { class: 'st-field' });
    wrap.appendChild(el('label', { for: id }, label));
    wrap.appendChild(el('input', Object.assign({ id: id, class: 'input', autocomplete: 'off' }, attrs || {})));
    if (help) wrap.appendChild(el('p', { class: 'st-help' }, help));
    return wrap;
  }
  function datalist(id, values) {
    var old = document.getElementById(id);
    if (old) old.remove();
    var list = el('datalist', { id: id });
    (values || []).forEach(function (v) { list.appendChild(el('option', { value: v })); });
    document.body.appendChild(list);
  }
  var val = function (id) { var n = document.getElementById(id); return n ? n.value.trim() : ''; };

  // ── Connection ──────────────────────────────────────────────────────
  function drawConnection() {
    var c = data.connection;
    connRoot.textContent = '';
    var vf = el('div', { class: 'st-field' });
    vf.appendChild(el('label', { for: 'influx-version' }, 'Version'));
    var sel = el('select', { id: 'influx-version', class: 'input' });
    [['2', 'InfluxDB 2.x'], ['1', 'InfluxDB 1.x']].forEach(function (o) { var opt = el('option', { value: o[0] }, o[1]); if ((c.version || '2') === o[0]) opt.selected = true; sel.appendChild(opt); });
    vf.appendChild(sel);
    connRoot.appendChild(vf);
    connRoot.appendChild(field('influx-url', 'Server address', { type: 'url', value: c.url || '', placeholder: 'http://192.168.0.10:8086' },
      'The address of your InfluxDB on your network, with its port (usually 8086).'));
    var v2 = el('div', { id: 'influx-v2' });
    var g2 = el('div', { class: 'st-grid-2' });
    g2.appendChild(field('influx-org', 'Organisation', { type: 'text', value: c.org || '' }));
    g2.appendChild(field('influx-bucket', 'Bucket', { type: 'text', value: c.bucket || '' }));
    v2.appendChild(g2);
    v2.appendChild(field('influx-token', 'API token', { type: 'password', autocomplete: 'new-password', placeholder: c.hasToken ? 'Saved. Leave empty to keep it.' : '' },
      'A token that can read and write this bucket.'));
    var v1 = el('div', { id: 'influx-v1' });
    var g1 = el('div', { class: 'st-grid-2' });
    g1.appendChild(field('influx-db', 'Database', { type: 'text', value: c.database || '', placeholder: 'home_assistant' }));
    g1.appendChild(field('influx-rp', 'Retention policy', { type: 'text', value: c.retentionPolicy || '', placeholder: 'Leave empty for the default' }));
    v1.appendChild(g1);
    var g1b = el('div', { class: 'st-grid-2' });
    g1b.appendChild(field('influx-user', 'User name', { type: 'text', value: c.username || '', placeholder: 'Leave empty if there is no sign-in' }));
    g1b.appendChild(field('influx-pass', 'Password', { type: 'password', autocomplete: 'new-password', placeholder: c.hasPassword ? 'Saved. Leave empty to keep it.' : '' }));
    v1.appendChild(g1b);
    connRoot.appendChild(v2); connRoot.appendChild(v1);
    function showVersion() { v2.hidden = sel.value !== '2'; v1.hidden = sel.value !== '1'; }
    sel.addEventListener('change', showVersion); showVersion();

    var actions = el('div', { class: 'st-health-actions' });
    var save = el('button', { type: 'button', class: 'st-btn st-btn-primary' }, 'Save');
    var test = el('button', { type: 'button', class: 'st-btn' }, 'Test connection');
    var forget = el('button', { type: 'button', class: 'st-btn' }, 'Disconnect');
    forget.hidden = !data.configured;
    actions.appendChild(save); actions.appendChild(test); actions.appendChild(forget);
    connRoot.appendChild(actions);

    function values() {
      return sel.value === '1'
        ? { version: '1', url: val('influx-url'), database: val('influx-db'), retentionPolicy: val('influx-rp'), username: val('influx-user'), password: document.getElementById('influx-pass').value }
        : { version: '2', url: val('influx-url'), org: val('influx-org'), bucket: val('influx-bucket'), token: document.getElementById('influx-token').value };
    }
    function busy(on) { [save, test, forget].forEach(function (b) { b.disabled = on; }); }
    test.addEventListener('click', function () {
      busy(true);
      api('/test', values()).then(function () { toast('Connected to InfluxDB'); }).catch(function (e) { toast(e.message, 'error'); }).then(function () { busy(false); });
    });
    save.addEventListener('click', function () {
      busy(true);
      api('/test', values()).then(function () { return api('/connection', values()); })
        .then(function (d) { data = d; drawAll(); toast('Saved and connected'); loadMeasurements(); })
        .catch(function (e) { toast(e.message, 'error'); busy(false); });
    });
    forget.addEventListener('click', function () {
      if (!shell.openDialog) return;
      shell.openDialog({
        title: 'Disconnect InfluxDB?',
        body: el('p', {}, 'Epilykos stops reading from and writing to it. The readings already copied stay, and so does the metric list below.'),
        actions: [{ label: 'Cancel', value: null }, { label: 'Disconnect', value: 'ok', kind: 'danger' }]
      }).then(function (r) {
        if (!r || r.value !== 'ok') return;
        api('/disconnect', {}).then(function (d) { data = d; drawAll(); toast('Disconnected'); }).catch(function (e) { toast(e.message, 'error'); });
      });
    });
  }

  // ── Mapping ─────────────────────────────────────────────────────────
  var rowsBox = null;

  function tagsText(tags) { return Object.keys(tags || {}).map(function (k) { return k + '=' + tags[k]; }).join(', '); }
  function parseTags(text) {
    var out = {};
    String(text || '').split(',').forEach(function (part) {
      var i = part.indexOf('=');
      if (i < 0) { if (part.trim()) out[part.trim()] = ''; return; }
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    });
    return out;
  }

  function addRow(row) {
    var tr = el('tr');
    var cells = [
      ['metric', 'Epilykos metric', row.metric || '', 'influx-metric-list'],
      ['measurement', 'Measurement', row.measurement || '', 'influx-measurement-list'],
      ['field', 'Field', row.field || '', ''],
      ['tags', 'Tag filters, as name=value', tagsText(row.tags), ''],
      ['scale', 'Scale', row.scale != null ? String(row.scale) : '1', ''],
    ];
    cells.forEach(function (c) {
      var td = el('td');
      var input = el('input', { class: 'input', 'data-k': c[0], 'aria-label': c[1], value: c[2], autocomplete: 'off' });
      if (c[0] === 'scale') { input.type = 'number'; input.step = 'any'; input.style.width = '6em'; }
      if (c[3]) input.setAttribute('list', c[3]);
      td.appendChild(input);
      tr.appendChild(td);
    });
    // A tag value may hold a comma; the text box shows the filters as name=value, name=value, so an unedited box keeps
    // the filters exactly as they were.
    tr._tags = row.tags || {};
    tr._tagsText = tagsText(row.tags);
    var fieldInput = tr.querySelector('[data-k="field"]');
    var mInput = tr.querySelector('[data-k="measurement"]');
    function fillFields() {
      var m = mInput.value.trim();
      if (!m) return;
      var id = 'influx-fields-' + encodeURIComponent(m).replace(/[^A-Za-z0-9]/g, '_');
      fieldInput.setAttribute('list', id);
      if (seriesInfo[m]) return datalist(id, seriesInfo[m].fields.map(function (f) { return f.name; }));
      api('/discover', { measurement: m }).then(function (d) { seriesInfo[m] = d; datalist(id, d.fields.map(function (f) { return f.name; })); }).catch(function () {});
    }
    mInput.addEventListener('change', fillFields);
    var td = el('td');
    var rm = el('button', { type: 'button', class: 'st-btn', 'aria-label': 'Remove this metric' }, 'Remove');
    rm.addEventListener('click', function () { tr.remove(); });
    td.appendChild(rm); tr.appendChild(td);
    rowsBox.appendChild(tr);
  }

  function currentRows() {
    return Array.prototype.map.call(rowsBox.querySelectorAll('tr'), function (tr) {
      var get = function (k) { return tr.querySelector('[data-k="' + k + '"]').value.trim(); };
      var tagText = tr.querySelector('[data-k="tags"]').value;
      var tags = tagText === tr._tagsText ? tr._tags : parseTags(tagText);
      return { metric: get('metric'), measurement: get('measurement'), field: get('field'), tags: tags, scale: get('scale') };
    }).filter(function (r) { return r.metric || r.measurement || r.field; });
  }

  function drawMapping() {
    mapRoot.textContent = '';
    if (!data.configured) { mapRoot.appendChild(el('p', { class: 'st-help' }, 'Save a connection first.')); return; }
    mapRoot.appendChild(el('p', { class: 'st-help' }, 'Each row says where an Epilykos metric\'s history is in InfluxDB. Scale multiplies the stored value: 1000 turns kW into W.'));
    var wrap = el('div', { class: 'table-wrap st-table-scroll' });
    var table = el('table', { class: 'st-table' });
    var head = el('tr');
    ['Epilykos metric', 'Measurement', 'Field', 'Tag filters', 'Scale', ''].forEach(function (h) { head.appendChild(el('th', { scope: 'col' }, h)); });
    var thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
    rowsBox = el('tbody'); table.appendChild(rowsBox);
    wrap.appendChild(table); mapRoot.appendChild(wrap);
    data.mapping.forEach(addRow);

    var actions = el('div', { class: 'st-health-actions' });
    var add = el('button', { type: 'button', class: 'st-btn' }, '+ Add a metric');
    var browse = el('button', { type: 'button', class: 'st-btn' }, 'Browse series');
    var ha = el('button', { type: 'button', class: 'st-btn' }, 'Find Home Assistant sensors');
    var save = el('button', { type: 'button', class: 'st-btn st-btn-primary' }, 'Save metrics');
    actions.appendChild(save); actions.appendChild(add); actions.appendChild(browse); actions.appendChild(ha);
    mapRoot.appendChild(actions);
    var found = el('div', { id: 'influx-ha-found' });
    mapRoot.appendChild(found);

    add.addEventListener('click', function () { addRow({}); });
    save.addEventListener('click', function () {
      save.disabled = true;
      api('/mapping', { mapping: currentRows() }).then(function (d) { data = d; drawMapping(); drawImport(); toast('Saved'); })
        .catch(function (e) { toast(e.message, 'error'); save.disabled = false; });
    });
    browse.addEventListener('click', function () {
      browse.disabled = true;
      found.textContent = '';
      found.appendChild(el('p', { class: 'st-help' }, 'Reading what is in the database…'));
      api('/browse-series', {}).then(function (d) { drawBrowse(found, d); })
        .catch(function (e) { found.textContent = ''; toast(e.message, 'error'); })
        .then(function () { browse.disabled = false; });
    });
    ha.addEventListener('click', function () {
      ha.disabled = true;
      found.textContent = '';
      found.appendChild(el('p', { class: 'st-help' }, 'Looking…'));
      api('/suggest-ha', {}).then(function (d) { drawFound(found, d); })
        .catch(function (e) { found.textContent = ''; toast(e.message, 'error'); })
        .then(function () { ha.disabled = false; });
    });
  }

  function drawFound(box, d) {
    box.textContent = '';
    if (!d.rows.length) { box.appendChild(el('p', { class: 'st-help' }, d.message || 'Nothing found.')); return; }
    var have = {};
    currentRows().forEach(function (r) { have[r.metric] = true; });
    box.appendChild(el('p', { class: 'st-help' }, 'Home Assistant sensors in this database. Ticked ones match a metric Epilykos already has; rename any before adding.'));
    var list = el('div', { class: 'st-influx-found' });
    d.rows.forEach(function (r, i) {
      var l = el('label', { class: 'st-radio', style: 'display:block;margin:6px 0' });
      var cb = el('input', { type: 'checkbox', 'data-i': String(i) });
      cb.checked = !!r.known && !have[r.metric];
      cb.disabled = !!have[r.metric];
      l.appendChild(cb);
      l.appendChild(el('span', {}, ' ' + r.metric + ' '));
      l.appendChild(el('span', { class: 'st-help' }, r.measurement + ' · entity_id=' + r.tags.entity_id + (have[r.metric] ? ' · already listed' : '')));
      list.appendChild(l);
    });
    box.appendChild(list);
    var addSel = el('button', { type: 'button', class: 'st-btn' }, 'Add the ticked sensors');
    addSel.addEventListener('click', function () {
      var n = 0;
      list.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) { if (!cb.disabled) { addRow(d.rows[Number(cb.getAttribute('data-i'))]); n++; } });
      box.textContent = '';
      toast(n ? 'Added ' + n + '. Press Save metrics to keep them.' : 'Nothing ticked');
    });
    box.appendChild(addSel);
  }

  // Whether a mapping row already reads this series: same measurement and field, and every tag filter of the row
  // matches the series' tags (a row can filter on fewer tags than the series has).
  function rowCovers(row, r) {
    if (row.measurement !== r.measurement || row.field !== r.field) return false;
    var t = row.tags || {};
    return Object.keys(t).every(function (k) { return r.tags[k] === t[k]; });
  }
  function fmtValue(v) { return Math.abs(v) >= 1000 || Number.isInteger(v) ? String(Math.round(v * 100) / 100) : String(Math.round(v * 1000) / 1000); }

  /** Every series in the database: filter, tick, add. Works for any layout (Telegraf, Node-RED, scripts, Home Assistant). */
  function drawBrowse(box, d) {
    box.textContent = '';
    if (!d.series.length) { box.appendChild(el('p', { class: 'st-help' }, 'No series with a number in the last 30 days.')); return; }
    var rows = currentRows();
    var names = {};
    rows.forEach(function (r) { names[r.metric] = true; });
    box.appendChild(el('p', { class: 'st-help' }, d.series.length + ' series with a number in the last 30 days' + (d.truncated ? ' (the first ' + d.series.length + ')' : '') + ', with the latest reading. Ticked ones match a metric Epilykos already has. Tick the ones to read, then rename any in the table before saving.'));
    var filterWrap = el('div', { class: 'st-field' });
    filterWrap.appendChild(el('label', { for: 'influx-browse-filter' }, 'Filter'));
    var filter = el('input', { id: 'influx-browse-filter', class: 'input', type: 'search', autocomplete: 'off' });
    filterWrap.appendChild(filter);
    box.appendChild(filterWrap);
    var list = el('div', { class: 'st-influx-found' });
    var items = d.series.map(function (r, i) {
      var already = rows.some(function (row) { return rowCovers(row, r); });
      var l = el('label', { class: 'st-radio', style: 'display:block;margin:6px 0' });
      var cb = el('input', { type: 'checkbox', 'data-i': String(i) });
      cb.checked = !!r.known && !already && !names[r.metric];
      cb.disabled = already;
      l.appendChild(cb);
      l.appendChild(el('span', {}, ' ' + r.metric + ' '));
      var tags = Object.keys(r.tags).sort().map(function (k) { return k + '=' + r.tags[k]; }).join(', ');
      var where = r.measurement + ' · ' + r.field + (tags ? ' · ' + tags : '');
      l.appendChild(el('span', { class: 'st-help' }, where + ' · latest ' + fmtValue(r.last) + (already ? ' · already listed' : '')));
      list.appendChild(l);
      return { label: l, text: (r.metric + ' ' + where).toLowerCase() };
    });
    filter.addEventListener('input', function () {
      var q = filter.value.trim().toLowerCase();
      items.forEach(function (it) { it.label.hidden = !!q && it.text.indexOf(q) < 0; });
    });
    box.appendChild(list);
    var addSel = el('button', { type: 'button', class: 'st-btn' }, 'Add the ticked series');
    addSel.addEventListener('click', function () {
      var n = 0;
      list.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
        if (cb.disabled) return;
        var r = d.series[Number(cb.getAttribute('data-i'))];
        addRow({ metric: r.metric, measurement: r.measurement, field: r.field, tags: r.tags, scale: 1 });
        n++;
      });
      box.textContent = '';
      toast(n ? 'Added ' + n + '. Rename any you like, then press Save metrics.' : 'Nothing ticked');
    });
    box.appendChild(addSel);
  }

  // ── Import history ──────────────────────────────────────────────────
  var importTimer = null;
  function fmtDate(s) { return s ? new Date(s * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''; }
  function fmtBytes(n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? Math.max(1, Math.round(n / 1e6)) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' kB'; }
  function periods(n) { return n + (n === 1 ? ' period' : ' periods') + ' of 5 minutes'; }
  var STATE_TEXT = { running: 'Importing', done: 'Done', 'done-with-errors': 'Done, with problems', stopped: 'Stopped', error: 'Failed' };

  function drawImport() {
    clearTimeout(importTimer);
    importRoot.textContent = '';
    var badge = document.getElementById('influx-import-badge');
    var imp = data.import || { state: 'idle' };
    if (badge) {
      badge.hidden = imp.state === 'idle';
      badge.className = 'st-badge ' + (imp.state === 'done' ? 'is-ok' : imp.state === 'running' ? 'is-warn' : 'is-error');
      badge.textContent = STATE_TEXT[imp.state] || '';
    }
    if (!data.configured) { importRoot.appendChild(el('p', { class: 'st-help' }, 'Save a connection first.')); return; }
    if (!data.mapping.length) { importRoot.appendChild(el('p', { class: 'st-help' }, 'Add the metrics to read first.')); return; }
    importRoot.appendChild(el('p', { class: 'st-help' }, 'Copies each mapped metric\'s history into Epilykos at 5-minute detail, so charts, daily totals, reports and savings cover it. Readings Epilykos already has are never replaced, so running it again is safe. It runs in the background; you can leave this page.'));

    if (imp.state !== 'idle') {
      var line = el('p', { class: 'st-help', role: 'status' });
      var pct = Math.round((imp.progress || 0) * 100);
      line.textContent = imp.state === 'running' ? 'Importing… ' + pct + '%'
        : (STATE_TEXT[imp.state] || imp.state) + (imp.finishedAt ? ' on ' + fmtDate(imp.finishedAt) : '') + (imp.error ? ': ' + imp.error : '.');
      importRoot.appendChild(line);
      if (imp.state === 'running') {
        var bar = el('progress', { max: '100', 'aria-label': 'Import progress' }); bar.value = pct;
        importRoot.appendChild(bar);
      }
      var list = el('ul', { class: 'st-help' });
      (imp.metrics || []).forEach(function (m) {
        list.appendChild(el('li', {}, m.metric + ': ' + (m.error ? 'not imported (' + m.error + ')' : periods(m.buckets) + (m.skipped ? ', ' + m.skipped + ' already there' : '') + (m.done ? '' : ' so far'))));
      });
      importRoot.appendChild(list);
    }

    if (data.syncedThrough && imp.state !== 'running') {
      importRoot.appendChild(el('p', { class: 'st-help' }, 'Gaps are filled from InfluxDB after a restart and once a day: up to ' + new Date(data.syncedThrough * 1000).toLocaleString() + ' so far.'));
    }
    var actions = el('div', { class: 'st-health-actions' });
    if (imp.state === 'running') {
      var stop = el('button', { type: 'button', class: 'st-btn' }, 'Stop');
      stop.addEventListener('click', function () {
        stop.disabled = true;
        api('/import/stop', {}).then(function (d) { data = d; drawImport(); }).catch(function (e) { toast(e.message, 'error'); stop.disabled = false; });
      });
      actions.appendChild(stop);
      importTimer = setTimeout(function () { if (location.hash === '#influxdb') api('').then(function (d) { data = d; drawImport(); }).catch(function () {}); }, 3000);
    } else {
      var check = el('button', { type: 'button', class: 'st-btn st-btn-primary' }, imp.state === 'idle' ? 'Check what would be imported' : 'Import again');
      check.addEventListener('click', function () {
        check.disabled = true;
        api('/import/plan', {}).then(function (p) { drawPlan(p); }).catch(function (e) { toast(e.message, 'error'); }).then(function () { check.disabled = false; });
      });
      actions.appendChild(check);
    }
    importRoot.appendChild(actions);
    var planBox = el('div', { id: 'influx-plan' });
    importRoot.appendChild(planBox);
  }

  function drawPlan(p) {
    var box = document.getElementById('influx-plan');
    box.textContent = '';
    var list = el('ul', { class: 'st-help' });
    p.metrics.forEach(function (m) {
      list.appendChild(el('li', {}, m.metric + ': ' + (m.error ? 'cannot be read (' + m.error + ')' : m.from === null ? 'no readings' : 'from ' + fmtDate(m.from) + ', up to ' + periods(m.buckets))));
    });
    box.appendChild(list);
    box.appendChild(el('p', { class: 'st-help' }, 'Room needed in the Epilykos database: up to about ' + fmtBytes(p.bytes) + '.'));
    var go = el('button', { type: 'button', class: 'st-btn st-btn-primary' }, 'Start the import');
    go.disabled = !p.buckets;
    go.addEventListener('click', function () {
      go.disabled = true;
      api('/import/start', {}).then(function (d) { data = d; drawImport(); toast('Import started'); }).catch(function (e) { toast(e.message, 'error'); go.disabled = false; });
    });
    var actions = el('div', { class: 'st-health-actions' }); actions.appendChild(go); box.appendChild(actions);
  }

  // ── Writing new readings ────────────────────────────────────────────
  function drawWrite() {
    writeRoot.textContent = '';
    if (!data.configured) { writeRoot.appendChild(el('p', { class: 'st-help' }, 'Save a connection first.')); return; }
    var w = data.write;
    writeRoot.appendChild(el('p', { class: 'st-help' }, 'New readings go into one measurement, with the metric\'s name as its "metric" tag, so they never mix with series another program writes. A chart of a mapped metric shows its old series up to the day it was connected, and this one after.'));
    writeRoot.appendChild(field('influx-write-m', 'Measurement for new readings', { type: 'text', value: w.measurement }));
    var row = el('div', { class: 'st-toggle-row' });
    var tw = el('span', { class: 'toggle-wrap' });
    var tl = el('label', { class: 'toggle-switch' });
    var cb = el('input', { type: 'checkbox', id: 'influx-write-all' });
    cb.checked = !!w.all;
    tl.appendChild(cb); tl.appendChild(el('span', { class: 'slider' }));
    tw.appendChild(tl); tw.appendChild(el('label', { for: 'influx-write-all' }, 'Send every reading, not only the mapped metrics'));
    row.appendChild(tw); writeRoot.appendChild(row);
    var ws = data.writing || {};
    var since = data.connectedAt ? 'Readings from ' + new Date(data.connectedAt * 1000).toLocaleString() + ' on are written. ' : '';
    var stateLine = ws.state === 'error' ? 'Not writing just now: ' + (ws.lastError || 'InfluxDB did not answer') + '. Nothing is lost; it catches up once InfluxDB answers.'
      : ws.state === 'idle' ? 'Nothing to write: no metric is mapped, and "send every reading" is off.'
      : ws.state === 'ok' ? ws.written + (ws.written === 1 ? ' reading' : ' readings') + ' written' + (ws.through ? ', up to ' + new Date(ws.through * 1000).toLocaleString() : '') + '.' + (ws.lastError ? ' Some were refused: ' + ws.lastError : '')
      : 'Starting…';
    writeRoot.appendChild(el('p', { class: 'st-help', role: 'status', id: 'influx-write-status' }, since + stateLine));
    var save = el('button', { type: 'button', class: 'st-btn st-btn-primary' }, 'Save');
    save.addEventListener('click', function () {
      save.disabled = true;
      api('/write-settings', { measurement: val('influx-write-m'), all: cb.checked }).then(function (d) { data = d; drawWrite(); toast('Saved'); })
        .catch(function (e) { toast(e.message, 'error'); save.disabled = false; });
    });
    var actions = el('div', { class: 'st-health-actions' }); actions.appendChild(save); writeRoot.appendChild(actions);
  }

  function drawAll() {
    datalist('influx-metric-list', data.metrics);
    drawConnection(); drawMapping(); drawImport(); drawWrite();
    var badge = document.getElementById('influx-badge');
    if (badge) { badge.hidden = !data.configured; badge.className = 'st-badge is-ok'; badge.textContent = 'Set up'; }
  }

  function loadMeasurements() {
    if (!data || !data.configured) return;
    api('/discover', {}).then(function (d) { measurements = d.measurements || []; datalist('influx-measurement-list', measurements); }).catch(function () {});
  }

  function load() {
    return api('').then(function (d) { data = d; drawAll(); loadMeasurements(); })
      .catch(function (e) { connRoot.textContent = ''; connRoot.appendChild(el('p', { class: 'st-help' }, 'Could not load: ' + e.message)); });
  }

  if (location.hash === '#influxdb') load();
  window.addEventListener('hashchange', function () { if (location.hash === '#influxdb') load(); });
})();
