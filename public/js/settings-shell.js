/**
 * Settings page shell: navigation and URLs, per-section saving with a
 * Save / Discard bar, unsaved-change tracking and the leave guard, the
 * Sources overview (status per device), the add-source picker, search across
 * every field, dialogs and toasts.
 *
 * Classic script loaded after settings.js, which owns the device editors and
 * the payload builders (buildSourcesPayload, buildUploadsPayload,
 * saveRoleMetrics) and exposes window.settingsReady.
 */
(function () {
  'use strict';

  // ── Icons ──────────────────────────────────────────────────────────────
  var ICONS = {
    back: '<path d="M15 18l-6-6 6-6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    home: '<path d="M3 11l9-7 9 7v9H3z"/><path d="M10 20v-6h4v6"/>',
    plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 01-10 0V8zM12 16v5"/>',
    list: '<path d="M4 7h16M4 12h16M4 17h10"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
    coin: '<circle cx="12" cy="12" r="8"/><path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 010 3h-3a1.5 1.5 0 000 3h4"/>',
    monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
    wifi: '<path d="M2 9a15 15 0 0120 0M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0"/><circle cx="12" cy="19.5" r="1"/>',
    database: '<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01"/>',
    pin: '<path d="M12 21s7-6.2 7-12a7 7 0 00-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    // source types
    register: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>',
    serial: '<path d="M4 9h16v6H4z"/><path d="M8 9V6M16 9V6M8 15v3M16 15v3"/>',
    dongle: '<path d="M5 12a7 7 0 0114 0M9 12a3 3 0 016 0"/><circle cx="12" cy="12" r="1"/><path d="M12 13v7"/>',
    mqtt: '<path d="M4 12a8 8 0 0116 0M8 12a4 4 0 018 0"/><circle cx="12" cy="12" r="1.5"/>',
    battery: '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M10 3V1.5h4V3M9 9h6M9 13h6"/>',
    bank: '<rect x="3" y="6" width="7" height="14" rx="1.5"/><rect x="14" y="6" width="7" height="14" rx="1.5"/><path d="M6 6V4M17 6V4"/>',
    rest: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
    tuya: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 12h6M12 9v6"/>'
  };
  function icon(name, size) {
    var s = size || 20;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (ICONS[name] || ICONS.list) + '</svg>';
  }
  function hydrateIcons(root) {
    root.querySelectorAll('[data-icon]').forEach(function (el) {
      el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, parseInt(el.dataset.size, 10) || 20));
      el.removeAttribute('data-icon');
    });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function $(id) { return document.getElementById(id); }
  function isNarrow() { return window.matchMedia('(max-width: 900px)').matches; }

  // ── Toasts and dialogs ─────────────────────────────────────────────────
  var toastTimer = null;
  function toast(message, opts) {
    opts = opts || {};
    var region = $('st-toast-region');
    clearTimeout(toastTimer);
    region.innerHTML = '';
    var t = document.createElement('div');
    t.className = 'st-toast' + (opts.tone ? ' is-' + opts.tone : '');
    var msg = document.createElement('span');
    msg.className = 'st-toast-msg';
    msg.textContent = message;
    t.appendChild(msg);
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'st-toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = icon('close', 16);
    close.addEventListener('click', function () { region.innerHTML = ''; });
    t.appendChild(close);
    region.appendChild(t);
    if (opts.timeout !== 0) toastTimer = setTimeout(function () { region.innerHTML = ''; }, opts.timeout || 5000);
  }

  /**
   * Modal dialog on native <dialog>. `actions`: [{ label, value, kind }] where
   * kind is 'primary' | 'danger' | undefined. Resolves with the chosen value
   * (null when dismissed) and the dialog's form.
   */
  function openDialog(opts) {
    return new Promise(function (resolve) {
      var returnFocus = document.activeElement;
      var dlg = document.createElement('dialog');
      dlg.className = 'st-dialog';
      if (opts.alert) dlg.setAttribute('role', 'alertdialog');
      var titleId = 'st-dlg-' + Math.random().toString(36).slice(2, 8);
      dlg.setAttribute('aria-labelledby', titleId);
      var form = document.createElement('form');
      form.method = 'dialog';
      form.className = 'st-dialog-form';
      form.noValidate = false;
      var h = document.createElement('h2');
      h.id = titleId;
      h.className = 'st-dialog-title';
      h.textContent = opts.title;
      form.appendChild(h);
      var body = document.createElement('div');
      body.className = 'st-dialog-body';
      if (typeof opts.body === 'string') body.innerHTML = opts.body; else if (opts.body) body.appendChild(opts.body);
      form.appendChild(body);
      var actions = document.createElement('div');
      actions.className = 'st-dialog-actions';
      var chosen = null;
      var buttons = (opts.actions || [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', kind: 'primary' }]).map(function (a) {
        var b = document.createElement('button');
        b.type = a.kind === 'primary' || a.kind === 'danger' ? 'submit' : 'button';
        b.className = 'st-btn' + (a.kind === 'primary' ? ' st-btn-primary' : a.kind === 'danger' ? ' st-btn-danger' : a.kind === 'danger-text' ? ' st-btn-danger-text' : '');
        b.textContent = a.label;
        b.addEventListener('click', function (e) {
          if (b.type === 'submit') return;  // handled by submit (runs validation)
          e.preventDefault();
          chosen = a.value;
          dlg.close();
        });
        b._value = a.value;
        actions.appendChild(b);
        return b;
      });
      form.appendChild(actions);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!form.reportValidity()) return;
        var submitter = e.submitter && e.submitter._value !== undefined ? e.submitter : buttons.filter(function (b) { return b.type === 'submit'; })[0];
        chosen = submitter ? submitter._value : 'ok';
        dlg.close();
      });
      dlg.appendChild(form);
      document.body.appendChild(dlg);
      dlg.addEventListener('close', function () {
        dlg.remove();
        if (returnFocus && document.contains(returnFocus) && returnFocus.focus) returnFocus.focus();
        resolve({ value: chosen, form: form });
      });
      dlg.showModal();
      var first = opts.alert ? buttons[0] : (body.querySelector('input, select, textarea') || buttons[buttons.length - 1]);
      first.focus();
    });
  }

  /**
   * Confirmation in the page's own dialog (never the browser's confirm box):
   * window.stConfirm({ message, title?, confirmLabel?, danger? }) → Promise<boolean>.
   * Without a title, the message's question becomes the title and the rest
   * its explanation ("Remove this bank? Historical data … remains."). Cancel
   * has focus first, so Enter doesn't destroy anything by accident.
   */
  function stConfirm(o) {
    o = o || {};
    var msg = String(o.message || '');
    var title = o.title, rest = msg;
    if (!title) {
      var m = /^(.*?\?)(\s+|$)([\s\S]*)$/.exec(msg);
      if (m && m[1].length <= 140) { title = m[1]; rest = m[3]; }
      else { var q = /([^.?!]*\?)\s*$/.exec(msg); title = q ? q[1].trim() : 'Are you sure?'; rest = q ? msg.slice(0, q.index).trim() : msg; }
    }
    var verb = /^(Remove|Delete|Write)\b/.exec(msg);
    var label = o.confirmLabel || (verb ? verb[1] : /Save anyway\?$/.test(msg) ? 'Save anyway' : 'Continue');
    var body = document.createElement('div');
    if (rest) { var p = document.createElement('p'); p.textContent = rest; body.appendChild(p); }
    return openDialog({ title: title, body: body, alert: true, actions: [{ label: 'Cancel', value: null }, { label: label, value: 'ok', kind: o.danger === false ? 'primary' : 'danger' }] })
      .then(function (r) { return r.value === 'ok'; });
  }
  window.stConfirm = stConfirm;

  // ── Sections and routing ───────────────────────────────────────────────
  var SECTION_TITLES = {
    sources: 'Sources', metrics: 'Metrics', forecast: 'Forecast and weather', savings: 'Prices and savings',
    appearance: 'Appearance', uploads: 'Uploads', network: 'Network', backup: 'Backup and restore', help: 'Help'
  };
  var SAVABLE = ['sources', 'metrics', 'forecast', 'savings', 'appearance', 'uploads', 'network'];
  // Old section ids (bookmarks, the setup wizard, help text) → new ones.
  var LEGACY = { 'data-sources': 'sources', solar: 'forecast', dashboard: 'appearance', branding: 'appearance' };

  var current = { section: null, type: null, index: null };

  function sectionEl(name) { return $('section-' + name); }

  function parseHash() {
    var parts = (location.hash || '').replace(/^#/, '').split('/').filter(Boolean).map(decodeURIComponent);
    var sec = LEGACY[parts[0]] || parts[0];
    if (parts[0] === 'data-sources' && parts[1] === 'pvoutput') return { section: 'uploads' };
    if (!SECTION_TITLES[sec]) return null;
    return { section: sec, type: parts[1] || null, index: parts[2] != null ? parseInt(parts[2], 10) : null };
  }

  function go(hash) {
    if (location.hash === '#' + hash) route(); else location.hash = hash;
  }

  function route() {
    var r = parseHash();
    if (!r) {
      var last = null;
      try { last = localStorage.getItem('epilykos-settings-section'); } catch (e) {}
      last = LEGACY[last] || last;
      r = { section: SECTION_TITLES[last] ? last : 'sources' };
      history.replaceState(null, '', '#' + r.section);
    }
    showSection(r.section);
    if (r.section === 'sources') showSource(r.type, r.index);
  }

  function showSection(name) {
    var changed = current.section !== name;
    current.section = name;
    Object.keys(SECTION_TITLES).forEach(function (s) {
      var el = sectionEl(s);
      if (el) el.hidden = s !== name;
    });
    document.querySelectorAll('.st-nav-link').forEach(function (a) {
      if (a.dataset.section === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('st-mobile-title').textContent = SECTION_TITLES[name];
    document.title = SECTION_TITLES[name] + ' · Settings · Epilykos';
    try { localStorage.setItem('epilykos-settings-section', name); } catch (e) {}
    if (name === 'backup') loadSnapshots();
    updateSaveBar();
    closeNav();
    if (changed) {
      $('st-main').scrollTop = 0;
      var h1 = sectionEl(name) && sectionEl(name).querySelector('h1');
      if (h1 && document.activeElement && document.activeElement.closest && document.activeElement.closest('.st-nav')) {
        // keep focus in the nav for keyboard users moving through it
      }
    }
  }

  // Help text and older pages call navigateTo('data-sources', 'modbus').
  window.navigateTo = function (sectionId, subtabId) {
    var sec = LEGACY[sectionId] || sectionId;
    if (sectionId === 'data-sources' && subtabId === 'pvoutput') return go('uploads');
    go(subtabId && sec === 'sources' ? 'sources/' + subtabId : sec);
  };

  // ── Mobile navigation ──────────────────────────────────────────────────
  function openNav() {
    document.body.classList.add('st-nav-open');
    $('st-scrim').hidden = false;
    $('st-nav-open').setAttribute('aria-expanded', 'true');
    var link = document.querySelector('.st-nav-link[aria-current="page"]') || document.querySelector('.st-nav-link');
    if (link) link.focus();
  }
  function closeNav() {
    if (!document.body.classList.contains('st-nav-open')) return;
    document.body.classList.remove('st-nav-open');
    $('st-scrim').hidden = true;
    $('st-nav-open').setAttribute('aria-expanded', 'false');
  }

  // ── Theme ──────────────────────────────────────────────────────────────
  var mql = window.matchMedia('(prefers-color-scheme: dark)');
  function storedTheme() {
    try { return localStorage.getItem('theme') || localStorage.getItem('epilykos-theme'); } catch (e) { return null; }
  }
  function applyTheme(choice) {
    var theme = choice === 'auto' ? (mql.matches ? 'dark' : 'light') : choice;
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('[data-theme-choice]').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.themeChoice === choice));
    });
  }
  function setTheme(choice) {
    try {
      if (choice === 'auto') { localStorage.removeItem('theme'); localStorage.removeItem('epilykos-theme'); }
      else { localStorage.setItem('theme', choice); localStorage.setItem('epilykos-theme', choice); }
    } catch (e) {}
    applyTheme(choice);
  }
  function initTheme() {
    var t = storedTheme();
    applyTheme(t === 'light' || t === 'dark' ? t : 'auto');
    mql.addEventListener('change', function () { if (!storedTheme()) applyTheme('auto'); });
    $('st-theme').addEventListener('click', function (e) {
      var b = e.target.closest('[data-theme-choice]');
      if (b) setTheme(b.dataset.themeChoice);
    });
    $('st-theme').addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var list = Array.from(this.querySelectorAll('[data-theme-choice]'));
      var i = list.findIndex(function (b) { return b.getAttribute('aria-checked') === 'true'; });
      var next = list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
      setTheme(next.dataset.themeChoice);
      next.focus();
      e.preventDefault();
    });
  }

  // ── Change tracking ────────────────────────────────────────────────────
  // Each section's state is fingerprinted from its controls and structure.
  // A section is dirty when the fingerprint differs from the last saved one.
  // Until someone touches a section, background updates (catalogs and
  // dropdowns filling in after load) just move the baseline.
  var baseline = {};      // section → { sig, controls: [{el, value, checked}], count }
  var dirty = {};         // section → number of changed controls (0 = clean)
  var touched = {};       // section → user has interacted
  var ready = false;

  function controlsOf(sec) {
    var el = sectionEl(sec);
    if (!el) return [];
    return Array.from(el.querySelectorAll('input, select, textarea')).filter(function (c) {
      // [data-own-save] cards (Combined metrics) save themselves, outside the save bar.
      return c.type !== 'file' && c.type !== 'search' && !c.closest('.mappings-filter-bar') && !c.closest('[data-own-save]') && !c.classList.contains('mappings-filter-input');
    });
  }
  function snapshotSection(sec) {
    var controls = controlsOf(sec).map(function (c) { return { el: c, value: c.value, checked: c.checked }; });
    var cards = sectionEl(sec) ? sectionEl(sec).querySelectorAll('.device-card, .metric-row').length : 0;
    var sig = JSON.stringify(controls.map(function (c) { return [c.el.name || c.el.id || c.el.className, c.value, c.checked]; })) + '#' + cards;
    return { sig: sig, controls: controls, count: controls.length, cards: cards };
  }
  function changedCount(sec) {
    var b = baseline[sec];
    if (!b) return 0;
    var now = snapshotSection(sec);
    if (now.sig === b.sig) return 0;
    if (now.count !== b.count || now.cards !== b.cards) return -1;  // structure changed
    var n = 0;
    for (var i = 0; i < now.controls.length; i++) {
      var a = now.controls[i], o = b.controls[i];
      if (a.value !== o.value || a.checked !== o.checked) n++;
    }
    return n || -1;
  }
  function takeBaseline(sec) {
    baseline[sec] = snapshotSection(sec);
    dirty[sec] = 0;
    touched[sec] = false;
  }

  var recheckTimer = null;
  function scheduleRecheck() {
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(recheckAll, 120);
  }
  function recheckAll() {
    if (!ready) return;
    SAVABLE.forEach(function (sec) {
      if (!touched[sec]) { baseline[sec] = snapshotSection(sec); dirty[sec] = 0; return; }
      dirty[sec] = changedCount(sec);
    });
    updateNavMeta();
    updateSaveBar();
    if (current.section === 'sources') renderSourcesList();
  }
  function isDirty(sec) { return !!dirty[sec]; }
  function anyDirty() { return SAVABLE.some(isDirty); }

  function sectionOfEvent(e) {
    var s = e.target && e.target.closest && e.target.closest('.st-section');
    return s ? s.dataset.section : null;
  }
  function onUserEdit(e) {
    if (!e.isTrusted) return;
    var sec = sectionOfEvent(e);
    if (!sec || SAVABLE.indexOf(sec) === -1) return;
    if (e.type === 'click') {
      // Only clicks that change structure (add/remove) count as edits.
      var btn = e.target.closest('button');
      if (!btn) return;
      var sig = ((btn.className || '') + ' ' + (btn.id || '') + ' ' + (btn.getAttribute('data-action') || '')).toLowerCase();
      if (!/(^|[\s-])(add|remove|delete)([\s-]|$)|remove-btn|load-|fetch/.test(sig)) return;
    }
    touched[sec] = true;
    scheduleRecheck();
  }

  // ── Save bar ───────────────────────────────────────────────────────────
  var savingSection = null;
  function updateSaveBar() {
    var sec = current.section;
    var bar = $('st-savebar');
    var status = $('save-status');
    var hasError = status.classList.contains('error');
    var show = SAVABLE.indexOf(sec) !== -1 && (isDirty(sec) || savingSection === sec || hasError);
    bar.hidden = !show;
    document.body.classList.toggle('st-has-savebar', show);
    if (!show) return;
    var n = dirty[sec];
    $('st-savebar-text').textContent = savingSection === sec ? 'Saving ' + SECTION_TITLES[sec] + '…'
      : !isDirty(sec) ? SECTION_TITLES[sec]
      : (n > 0 ? n + ' unsaved change' + (n === 1 ? '' : 's') : 'Unsaved changes') + ' to ' + SECTION_TITLES[sec];
    bar.classList.toggle('is-dirty', isDirty(sec));
    $('st-save').disabled = savingSection === sec || !isDirty(sec);
    $('st-discard').disabled = savingSection === sec || !isDirty(sec);
  }
  function setBarStatus(msg, type) {
    var el = $('save-status');
    if (typeof showStatus === 'function') showStatus(el, msg, type); else el.textContent = msg;
    updateSaveBar();
  }

  function updateNavMeta() {
    document.querySelectorAll('.st-nav-link').forEach(function (a) {
      var sec = a.dataset.section;
      var meta = a.querySelector('.st-nav-meta');
      var html = '';
      if (sec === 'sources' && sourceIssues > 0) html += '<span class="st-badge is-error">' + sourceIssues + (sourceIssues === 1 ? ' issue' : ' issues') + '</span>';
      if (isDirty(sec)) html += '<span class="st-dirty-dot" title="Unsaved changes"></span><span class="st-visually-hidden">, unsaved changes</span>';
      meta.innerHTML = html;
    });
  }

  // ── Saving ─────────────────────────────────────────────────────────────
  async function postSettings(payload) {
    var res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      var msg = 'Server error (' + res.status + ')';
      try { var err = await res.json(); if (err.error) msg = err.error + ' (' + res.status + ')'; } catch (e) {}
      var error = new Error(msg);
      error.status = res.status;
      throw error;
    }
  }
  function fieldsPayload(sec) {
    var payload = {};
    sectionEl(sec).querySelectorAll('input[name], select[name], textarea[name]').forEach(function (el) {
      if (el.name.indexOf('[') !== -1 || el.type === 'radio') return;
      payload[el.name] = el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value;
    });
    return payload;
  }
  var SAVERS = {
    sources: async function () { await postSettings(await buildSourcesPayload()); },
    uploads: async function () { await postSettings(buildUploadsPayload()); },
    metrics: async function () { await saveRoleMetrics(); },
    forecast: async function () { await postSettings(fieldsPayload('forecast')); },
    savings: async function () { await postSettings(fieldsPayload('savings')); },
    appearance: async function () { await postSettings(fieldsPayload('appearance')); },
    network: async function () { await postSettings(fieldsPayload('network')); }
  };

  async function saveSection(sec) {
    if (!SAVERS[sec]) return true;
    var invalid = Array.from(sectionEl(sec).querySelectorAll('input, select, textarea')).filter(function (c) {
      return !c.disabled && c.offsetParent !== null && !c.checkValidity();
    })[0];
    if (invalid) {
      if (sec !== current.section) go(sec);
      invalid.reportValidity();
      return false;
    }
    savingSection = sec;
    updateSaveBar();
    try {
      await SAVERS[sec]();
      takeBaseline(sec);
      savingSection = null;
      setBarStatus('', 'info');
      $('save-status').className = 'status';
      toast(SECTION_TITLES[sec] + ' saved');
      if (sec === 'sources') {
        // Cards saved now count as saved for their status.
        TYPES.forEach(function (t) { cardsOf(t).forEach(function (c) { savedCards.add(c); }); });
        renderSourcesList();
        refreshMetricTimes();
      }
      updateNavMeta();
      updateSaveBar();
      return true;
    } catch (e) {
      savingSection = null;
      var msg = e.cancelled ? e.message
        : (e.status === 401 || e.status === 403) ? 'Couldn\'t save ' + SECTION_TITLES[sec] + ': your session ended. Sign in again in another tab, then save. Your changes are still here.'
        : 'Couldn\'t save ' + SECTION_TITLES[sec] + ': ' + e.message;
      setBarStatus(msg, 'error');
      return false;
    }
  }

  async function saveAllDirty() {
    for (var i = 0; i < SAVABLE.length; i++) {
      var sec = SAVABLE[i];
      if (isDirty(sec) && !(await saveSection(sec))) return false;
    }
    return true;
  }

  var RELOAD_DISCARD = ['sources', 'uploads'];
  async function discardSection(sec) {
    if (RELOAD_DISCARD.indexOf(sec) !== -1 || changedCount(sec) === -1) {
      var r = await openDialog({
        title: 'Discard changes to ' + SECTION_TITLES[sec] + '?',
        body: '<p>The page reloads with your saved settings. Unsaved changes in other sections are lost too.</p>',
        alert: true,
        actions: [{ label: 'Keep editing', value: null }, { label: 'Discard and reload', value: 'discard', kind: 'danger' }]
      });
      if (r.value !== 'discard') return;
      leaving = true;
      location.reload();
      return;
    }
    baseline[sec].controls.forEach(function (c) {
      c.el.value = c.value;
      c.el.checked = c.checked;
      c.el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    takeBaseline(sec);
    $('save-status').className = 'status';
    $('save-status').textContent = '';
    updateNavMeta();
    updateSaveBar();
    toast('Changes discarded');
  }

  // ── Leaving ────────────────────────────────────────────────────────────
  var leaving = false;
  async function confirmLeave(url) {
    if (!anyDirty()) { leaving = true; location.href = url; return; }
    var names = SAVABLE.filter(isDirty).map(function (s) { return '<b>' + esc(SECTION_TITLES[s]) + '</b>'; });
    var list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
    var r = await openDialog({
      title: 'Leave settings?',
      body: '<p>Changes to ' + list + ' aren\'t saved yet.</p>',
      alert: true,
      actions: [{ label: 'Stay', value: null }, { label: 'Discard and leave', value: 'discard', kind: 'danger-text' }, { label: 'Save and leave', value: 'save', kind: 'primary' }]
    });
    if (r.value === 'discard') { leaving = true; location.href = url; }
    else if (r.value === 'save' && await saveAllDirty()) { leaving = true; location.href = url; }
  }

  // ── Sources overview ───────────────────────────────────────────────────
  var LABELS = (window.EPILYKOS_LABELS && window.EPILYKOS_LABELS.subnav) || {};
  var TYPES = [
    { key: 'modbus', panel: 'modbus', container: 'modbus-devices-container', add: 'add-modbus-device', label: 'Modbus', icon: 'register', group: 'Inverter', desc: 'RS485 or TCP. Most hybrid inverters, with ready profiles.' },
    { key: 'dongle', panel: 'dongle', container: 'dongle-devices-container', add: 'add-dongle-device', label: 'WiFi dongle', icon: 'dongle', group: 'Inverter', desc: 'Solarman, LuxPower, Growatt and Felicity sticks.' },
    { key: 'rs232', panel: 'rs232', container: 'rs232-devices-container', add: 'add-rs232-device', label: 'RS232 serial', icon: 'serial', group: 'Inverter', desc: 'Voltronic, Victron VE.Direct, SolaX Pocket USB.' },
    { key: 'ha', panel: 'ha', container: 'ha-devices-container', add: 'add-ha-device', label: LABELS.ha || 'Home Assistant', icon: 'home', group: 'Home automation', desc: 'Read any entity with a long-lived token.' },
    { key: 'mqtt', panel: 'mqtt', container: 'mqtt-devices-container', add: 'add-mqtt-device', label: 'MQTT', icon: 'mqtt', group: 'Home automation', desc: 'Subscribe to topics on a broker.' },
    { key: 'bms', panel: 'bms', container: 'bms-devices-container', add: 'add-bms-device', label: 'Bluetooth BMS', icon: 'battery', group: 'Battery', desc: 'JBD, JK, Pace and others over Bluetooth.' },
    { key: 'bms-wired', panel: 'bms', container: 'bms-wired-devices-container', add: 'add-bms-wired-device', label: 'Wired BMS', icon: 'battery', group: 'Battery', desc: 'RS485 or RS232 (Modbus-RTU).' },
    { key: 'bms-bank', panel: 'bms', container: 'bms-banks-container', add: 'add-bms-bank', label: 'Battery bank', icon: 'bank', group: 'Battery', desc: 'Combine several BMS into one virtual battery.' },
    { key: 'tuya', panel: 'tuya', container: 'tuya-devices-container', add: 'add-tuya-device', label: 'Tuya', icon: 'tuya', group: 'Other', desc: 'Local Tuya devices, keys fetched once from the cloud.' },
    { key: 'external', panel: 'external', container: 'external-sources-container', add: 'add-external-source', label: 'REST API', icon: 'rest', group: 'Other', desc: 'Read values from any JSON endpoint.' }
  ];
  function typeByKey(k) { return TYPES.filter(function (t) { return t.key === k; })[0] || null; }
  function cardsOf(t) {
    var c = $(t.container);
    return c ? Array.from(c.children).filter(function (el) { return el.classList.contains('device-card'); }) : [];
  }
  function cardName(card, t) {
    var input = card.querySelector('.device-header input[type="text"], .bank-name');
    return (input && input.value.trim()) || 'Unnamed ' + t.label;
  }
  function cardEnabled(card) {
    var cb = card.querySelector('.device-header input[type="checkbox"], .bank-enabled');
    return cb ? cb.checked : true;
  }
  function cardMetrics(card) {
    var names = [];
    card.querySelectorAll('.metric-row .metric-name, .bank-fn-output').forEach(function (el) {
      var v = (el.value || '').trim();
      if (v && names.indexOf(v) === -1) names.push(v);
    });
    return names;
  }
  function cardPoll(card) {
    var p = card.querySelector('input[name$="[poll_interval]"]');
    var v = p ? parseInt(p.value, 10) : NaN;
    return isFinite(v) && v > 0 ? v : 30;
  }

  var metricTimes = {};
  async function refreshMetricTimes() {
    try {
      var res = await fetch('/api/metrics/list');
      if (!res.ok) return;
      var list = await res.json();
      metricTimes = {};
      (Array.isArray(list) ? list : []).forEach(function (m) { if (m && m.name) metricTimes[m.name] = m.timestamp || null; });
      var names = $('st-metric-names');
      if (names) names.innerHTML = Object.keys(metricTimes).sort().map(function (n) { return '<option value="' + esc(n) + '"></option>'; }).join('');
      if (current.section === 'sources') renderSourcesList();
      updateNavMeta();
    } catch (e) { /* status stays as it was */ }
  }
  function ago(seconds) {
    if (seconds < 60) return Math.max(1, Math.round(seconds)) + ' s ago';
    if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago';
    return Math.round(seconds / 86400) + ' d ago';
  }
  var savedCards = new WeakSet();
  function cardStatus(card) {
    if (!savedCards.has(card)) return { kind: 'new', label: 'Not saved yet' };
    if (!cardEnabled(card)) return { kind: 'off', label: 'Off' };
    var names = cardMetrics(card);
    if (!names.length) return { kind: 'unknown', label: 'No mapped metrics', title: 'Map at least one metric to see whether this source is reporting.' };
    var newest = 0;
    names.forEach(function (n) { if (metricTimes[n] && metricTimes[n] > newest) newest = metricTimes[n]; });
    if (!newest) return { kind: 'error', label: 'No readings yet' };
    var age = Date.now() / 1000 - newest;
    var limit = Math.max(180, cardPoll(card) * 4);
    if (age <= limit) return { kind: 'ok', label: 'Connected', detail: 'Last reading ' + ago(age) };
    return { kind: 'error', label: 'No recent data', detail: 'Last reading ' + ago(age) };
  }

  var sourceIssues = 0;
  function renderSourcesList() {
    var list = $('sources-list');
    if (!list) return;
    var total = 0, ok = 0, issues = 0, off = 0;
    var html = '';
    var groups = {};
    TYPES.forEach(function (t) {
      var cards = cardsOf(t);
      if (!cards.length) return;
      (groups[t.group] = groups[t.group] || []).push({ t: t, cards: cards });
    });
    Object.keys(groups).forEach(function (g) {
      html += '<div class="st-src-group"><h2 class="st-src-group-title">' + esc(g) + '</h2>';
      groups[g].forEach(function (entry) {
        var t = entry.t;
        var typeOn = current.type === t.key && current.index == null;
        html += '<a class="st-src-type' + (typeOn ? ' is-current' : '') + '" href="#sources/' + t.key + '"' + (typeOn ? ' aria-current="true"' : '') + '>' +
          esc(t.label) + ' · ' + entry.cards.length + '<span class="st-src-type-hint">' + (t.key === 'tuya' ? 'Account and all devices' : 'All') + '</span></a>';
        entry.cards.forEach(function (card, i) {
          total++;
          var st = cardStatus(card);
          if (st.kind === 'ok') ok++;
          else if (st.kind === 'error') issues++;
          else if (st.kind === 'off') off++;
          var on = current.type === t.key && current.index === i;
          var mapped = cardMetrics(card).length;
          html += '<a class="st-src' + (on ? ' is-current' : '') + '" href="#sources/' + t.key + '/' + i + '"' + (on ? ' aria-current="true"' : '') + '>' +
            '<span class="st-src-icon">' + icon(t.icon, 20) + '</span>' +
            '<span class="st-src-text"><span class="st-src-name">' + esc(cardName(card, t)) + '</span>' +
            '<span class="st-src-sub">' + esc(t.label) + ' · ' + mapped + (mapped === 1 ? ' metric' : ' metrics') + (st.detail ? ' · ' + esc(st.detail) : '') + '</span></span>' +
            '<span class="st-pill is-' + st.kind + '"' + (st.title ? ' title="' + esc(st.title) + '"' : '') + '><span class="st-pill-dot"></span>' + esc(st.label) + '</span>' +
          '</a>';
        });
      });
      html += '</div>';
    });
    list.innerHTML = html;
    sourceIssues = issues;
    var parts = [total + (total === 1 ? ' source' : ' sources')];
    if (ok) parts.push(ok + ' connected');
    if (issues) parts.push(issues + (issues === 1 ? ' needs' : ' need') + ' attention');
    if (off) parts.push(off + ' off');
    $('sources-summary').textContent = !ready ? 'Loading your sources…'
      : total ? 'Where Epilykos reads metrics from. ' + parts.join(' · ') + '.' : 'Where Epilykos reads metrics from.';
    $('sources-empty').hidden = !ready || total > 0 || !!current.type;
    document.querySelector('.st-sources').classList.toggle('is-empty', total === 0);
  }

  function showSource(typeKey, index) {
    var t = typeKey ? typeByKey(typeKey) : null;
    if (!t && isNarrow()) {
      // Phones start on the list.
      current.type = null;
      current.index = null;
      document.querySelector('.st-sources').classList.remove('show-detail');
    } else if (!t) {
      // Nothing chosen: open the first device, if any.
      var first = null;
      TYPES.some(function (tt) { if (cardsOf(tt).length) { first = tt; return true; } return false; });
      current.type = first ? first.key : null;
      current.index = first ? 0 : null;
      t = first;
      if (first && ready) history.replaceState(null, '', '#sources/' + first.key + '/0');
    } else {
      current.type = t.key;
      var cards = cardsOf(t);
      current.index = index != null && isFinite(index) && cards[index] ? index : null;
    }
    document.querySelectorAll('.st-type-panel').forEach(function (p) {
      p.hidden = !t || p.dataset.type !== t.panel;
      p.classList.remove('is-device-view');
    });
    document.querySelectorAll('.device-card.is-focused').forEach(function (c) { c.classList.remove('is-focused'); });
    if (t) {
      var panel = $('subtab-' + t.panel);
      if (current.index != null) {
        panel.classList.add('is-device-view');
        cardsOf(t)[current.index].classList.add('is-focused');
      }
    }
    renderSourcesList();
    if (isNarrow() && t) document.querySelector('.st-sources').classList.add('show-detail');
  }

  // ── Add a source ───────────────────────────────────────────────────────
  async function addSource() {
    var body = document.createElement('div');
    body.className = 'st-add-source';
    var groups = {};
    TYPES.forEach(function (t) { (groups[t.group] = groups[t.group] || []).push(t); });
    var html = '<fieldset class="st-choices"><legend class="st-visually-hidden">Source type</legend>';
    Object.keys(groups).forEach(function (g) {
      html += '<p class="st-choice-group">' + esc(g) + '</p>';
      groups[g].forEach(function (t, i) {
        html += '<label class="st-choice st-choice-icon"><input type="radio" name="sourceType" value="' + t.key + '" required' + (g === 'Inverter' && i === 0 ? ' checked' : '') + '>' +
          '<span class="st-src-icon">' + icon(t.icon, 18) + '</span>' +
          '<span><span class="st-choice-title">' + esc(t.label) + '</span><span class="st-choice-desc">' + esc(t.desc) + '</span></span></label>';
      });
    });
    html += '</fieldset>';
    body.innerHTML = html;
    var r = await openDialog({
      title: 'Add a source',
      body: body,
      actions: [{ label: 'Cancel', value: null }, { label: 'Continue', value: 'ok', kind: 'primary' }]
    });
    if (r.value !== 'ok') return;
    var key = r.form.elements.sourceType.value;
    var t = typeByKey(key);
    if (!t || !$(t.add)) return;
    $(t.add).click();
    touched.sources = true;
    var cards = cardsOf(t);
    labelize($(t.container));
    go('sources/' + t.key + '/' + (cards.length - 1));
    var card = cards[cards.length - 1];
    var nameInput = card && card.querySelector('.device-header input[type="text"], .bank-name');
    setTimeout(function () { if (nameInput) { nameInput.focus(); nameInput.select(); } }, 50);
    scheduleRecheck();
  }

  // ── Visible labels for device fields ───────────────────────────────────
  var FIELD_LABELS = {
    url: 'Server URL', token: 'Access token', poll_interval: 'Read every (seconds)', broker: 'Broker URL',
    username: 'Username', password: 'Password', host: 'Host or IP address', port: 'Port',
    serial_path: 'Serial port', serial_baud: 'Baud rate', serial_data_bits: 'Data bits', serial_parity: 'Parity',
    serial_stop_bits: 'Stop bits', unit: 'Modbus unit ID', modbus_unit_id: 'Modbus unit ID', address: 'Address',
    dev_id: 'Device ID', local_key: 'Local key', version: 'Protocol version', serial_number: 'Serial number',
    dongle_serial: 'Dongle serial number', inverter_serial: 'Inverter serial number', prefix: 'Metric name prefix',
    ble_address: 'Bluetooth address', ble_write_uuid: 'Write characteristic UUID', ble_notify_uuid: 'Notify characteristic UUID',
    transport: 'Connection', profile: 'Profile', tcp_framing: 'TCP framing', bms_type: 'BMS type', capacity: 'Capacity'
  };
  var CLASS_KEYS = {
    'modbus-transport-select': 'transport', 'modbus-profile-select': 'profile', 'modbus-framing-select': 'tcp_framing',
    'dongle-profile-select': 'profile', 'bms-type-select': 'bms_type'
  };
  function fieldKey(el) {
    var m = (el.name || '').match(/\[([a-z0-9_]+)\]$/i);
    if (m) return m[1];
    for (var cls in CLASS_KEYS) if (el.classList.contains(cls)) return CLASS_KEYS[cls];
    return '';
  }
  function humanize(k) {
    return k ? k.replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }) : '';
  }
  function labelize(root) {
    if (!root) return;
    root.querySelectorAll('.device-card input, .device-card select, .device-card textarea').forEach(function (el) {
      if (el.dataset.stLabelled) return;
      el.dataset.stLabelled = '1';
      if (/^(hidden|checkbox|radio|file|button|submit)$/.test(el.type)) return;
      if (el.closest('.metric-row, .mappings-list, .mappings-filter-bar, label, .st-autolabel, .bank-function-row, .bank-device-row')) return;
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return;
      if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return;
      if (el.closest('.device-header')) {
        el.setAttribute('aria-label', 'Source name');
        el.classList.add('st-source-name');
        return;
      }
      var key = fieldKey(el);
      var text = FIELD_LABELS[key] || humanize(key);
      if (!text) {
        if (el.placeholder) el.setAttribute('aria-label', el.placeholder);
        return;
      }
      var wrap = document.createElement('label');
      wrap.className = 'st-autolabel';
      var span = document.createElement('span');
      span.className = 'st-autolabel-text';
      span.textContent = text;
      el.parentNode.insertBefore(wrap, el);
      wrap.appendChild(span);
      wrap.appendChild(el);
    });
    // Icon-only remove buttons ("✕") need a name.
    root.querySelectorAll('button').forEach(function (b) {
      if (b.getAttribute('aria-label')) return;
      var text = (b.textContent || '').trim();
      if (text === '✕' || text === '×' || text === 'X') {
        b.setAttribute('aria-label', b.closest('.device-header') || b.classList.contains('remove-btn') && !b.closest('.metric-row') ? 'Remove this source' : 'Remove row');
      }
    });
    // "Enabled" toggles whose text label isn't tied to the checkbox.
    root.querySelectorAll('.toggle-wrap').forEach(function (w) {
      var cb = w.querySelector('input[type="checkbox"]');
      var text = Array.from(w.querySelectorAll('label')).filter(function (l) { return !l.classList.contains('toggle-switch'); })[0];
      if (!cb || !text || text.htmlFor) return;
      if (!cb.id) cb.id = 'st-cb-' + Math.random().toString(36).slice(2, 9);
      text.htmlFor = cb.id;
    });
  }

  // ── Search across every field ──────────────────────────────────────────
  var searchIndex = [];
  function buildSearchIndex() {
    searchIndex = [];
    Object.keys(SECTION_TITLES).forEach(function (sec) {
      var el = sectionEl(sec);
      if (!el) return;
      searchIndex.push({ section: sec, label: SECTION_TITLES[sec], context: 'Section', target: null });
      el.querySelectorAll('.st-field > label, .toggle-wrap > label:not(.toggle-switch), .st-card-head h2, .st-card-subhead, .st-subhead, .help-summary, .st-type-head h2').forEach(function (l) {
        var text = (l.textContent || '').trim().replace(/\s+/g, ' ');
        if (!text || text.length > 80) return;
        var type = l.closest('.st-type-panel');
        searchIndex.push({ section: sec, label: text, context: SECTION_TITLES[sec] + (type ? ' › ' + (typeByKey(type.dataset.type) || {}).label : ''), target: l, type: type ? type.dataset.type : null });
      });
    });
    // Fields inside each configured device.
    TYPES.forEach(function (t) {
      cardsOf(t).forEach(function (card, i) {
        var name = cardName(card, t);
        card.querySelectorAll('.st-autolabel-text, .section-divider').forEach(function (l) {
          var text = (l.textContent || '').trim().replace(/\s+/g, ' ');
          if (!text || text.length > 60) return;
          searchIndex.push({ section: 'sources', label: text, context: 'Sources › ' + name, deviceHash: 'sources/' + t.key + '/' + i, target: l });
        });
      });
    });
    TYPES.forEach(function (t) {
      searchIndex.push({ section: 'sources', label: t.label, context: 'Sources › add or edit', type: t.key, typeOnly: true });
    });
  }
  function runSearch(q) {
    var box = $('st-search-results');
    var input = $('st-search-input');
    q = q.trim().toLowerCase();
    if (!q) { box.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
    var hits = searchIndex.filter(function (it) {
      return (it.label + ' ' + it.context).toLowerCase().indexOf(q) !== -1;
    }).slice(0, 8);
    box.innerHTML = hits.length
      ? hits.map(function (h, i) {
          return '<div class="st-search-hit" role="option" id="st-hit-' + i + '" data-i="' + i + '" aria-selected="' + (i === 0) + '"><span class="st-search-hit-label">' + esc(h.label) + '</span><span class="st-search-hit-context">' + esc(h.context) + '</span></div>';
        }).join('')
      : '<p class="st-search-empty">No settings match “' + esc(q) + '”.</p>';
    box._hits = hits;
    box._active = 0;
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', hits.length ? 'st-hit-0' : '');
  }
  function openHit(h) {
    $('st-search-input').value = '';
    runSearch('');
    if (h.typeOnly) { go('sources/' + h.type); return; }
    var hash = h.section;
    if (h.deviceHash) hash = h.deviceHash;
    else if (h.section === 'sources' && h.type) hash += '/' + (TYPES.filter(function (t) { return t.panel === h.type; })[0] || {}).key;
    go(hash);
    if (h.target) {
      setTimeout(function () {
        var field = h.target.htmlFor ? $(h.target.htmlFor) : h.target.closest('.st-autolabel, .st-field, .toggle-wrap, details, .st-card');
        if (h.target.closest('details')) h.target.closest('details').open = true;
        var focusEl = (field && field.matches && field.matches('input, select, textarea')) ? field : (field && field.querySelector && field.querySelector('input, select, textarea, summary'));
        (field || h.target).scrollIntoView({ block: 'center', behavior: 'smooth' });
        var flash = h.target.closest('.st-autolabel, .st-field, .toggle-wrap, .st-card, details') || h.target;
        flash.classList.add('st-flash');
        setTimeout(function () { flash.classList.remove('st-flash'); }, 1600);
        if (focusEl) focusEl.focus({ preventScroll: true });
      }, 60);
    }
  }
  function wireSearch() {
    var input = $('st-search-input');
    var box = $('st-search-results');
    input.addEventListener('focus', buildSearchIndex);
    input.addEventListener('input', function () { runSearch(input.value); });
    input.addEventListener('keydown', function (e) {
      var hits = box._hits || [];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!hits.length) return;
        e.preventDefault();
        box._active = (box._active + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
        box.querySelectorAll('.st-search-hit').forEach(function (el, i) { el.setAttribute('aria-selected', String(i === box._active)); });
        input.setAttribute('aria-activedescendant', 'st-hit-' + box._active);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (hits[box._active]) openHit(hits[box._active]);
      } else if (e.key === 'Escape') {
        input.value = '';
        runSearch('');
      }
    });
    box.addEventListener('mousedown', function (e) {
      var hit = e.target.closest('.st-search-hit');
      if (!hit) return;
      e.preventDefault();
      openHit(box._hits[parseInt(hit.dataset.i, 10)]);
    });
    input.addEventListener('blur', function () { setTimeout(function () { runSearch(''); }, 150); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target;
      if (t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      if (isNarrow()) openNav();
      input.focus();
    });
  }

  // ── Metrics: new metric dialog and filter ──────────────────────────────
  async function newMetric() {
    var body = document.createElement('div');
    body.className = 'st-dialog-fields';
    body.innerHTML = '<div class="st-field"><label for="st-new-metric-name">Name</label><input id="st-new-metric-name" name="name" class="input" required pattern="[A-Za-z0-9_.:\\-]+" maxlength="128" autocomplete="off"><span class="st-help">Letters, numbers and _ . : - only, e.g. garage_battery_soc.</span></div>' +
      '<div class="st-field"><label for="st-new-metric-unit">Unit (optional)</label><input id="st-new-metric-unit" name="unit" class="input" maxlength="16" placeholder="W, kWh, %"></div>';
    var r = await openDialog({ title: 'New metric', body: body, actions: [{ label: 'Cancel', value: null }, { label: 'Create metric', value: 'ok', kind: 'primary' }] });
    if (r.value !== 'ok') return;
    var name = r.form.elements.name.value.trim();
    var unit = r.form.elements.unit.value.trim();
    try {
      var res = await fetch('/api/metrics/create', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ name: name, unit: unit }) });
      if (!res.ok) { var err = await res.json().catch(function () { return {}; }); throw new Error(err.error || 'Server error (' + res.status + ')'); }
      if (typeof loadMetricsList === 'function') await loadMetricsList();
      if (typeof refreshAllMetricDropdowns === 'function') await refreshAllMetricDropdowns();
      refreshMetricTimes();
      toast('Metric "' + name + '" created');
    } catch (e) {
      toast('Couldn\'t create the metric: ' + e.message, { tone: 'error', timeout: 0 });
    }
  }

  // ── Backup and restore ─────────────────────────────────────────────────
  function formatBytes(n) {
    return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
  }
  function downloadBackup() {
    // Navigating to the download keeps the page (attachment response).
    var a = document.createElement('a');
    a.href = '/api/backup';
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function restoreDialogBody(what) {
    var wrap = document.createElement('div');
    wrap.innerHTML = '<p>This replaces all settings, metrics and history with ' + what + '. Anything recorded since then is lost.</p>' +
      '<label class="st-check-card"><input type="checkbox" name="downloadFirst" checked><span><span class="st-choice-title">Download current data first</span><span class="st-choice-desc">Saves a backup file before restoring, so you can go back.</span></span></label>';
    return wrap;
  }
  async function confirmRestore(title, what) {
    var r = await openDialog({ title: title, body: restoreDialogBody(what), alert: true, actions: [{ label: 'Cancel', value: null }, { label: 'Restore', value: 'restore', kind: 'danger' }] });
    if (r.value !== 'restore') return false;
    if (r.form.elements.downloadFirst.checked) {
      downloadBackup();
      await new Promise(function (res) { setTimeout(res, 1500); });
    }
    return true;
  }
  function wireBackup() {
    var statusEl = $('backup-status');
    $('backup-btn').addEventListener('click', function () {
      downloadBackup();
      showStatus(statusEl, 'Your backup is downloading.', 'success');
    });
    var file = $('restore-file');
    $('restore-btn').addEventListener('click', function () { file.click(); });
    file.addEventListener('change', async function () {
      var f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      if (!(await confirmRestore('Restore from "' + f.name + '"?', 'the contents of this file (' + formatBytes(f.size) + ')'))) return;
      var fd = new FormData();
      fd.append('dbfile', f);
      showStatus(statusEl, 'Restoring…', 'info');
      try {
        var r = await fetch('/api/restore', { method: 'POST', body: fd });
        if (!r.ok) { var err = await r.json().catch(function () { return {}; }); throw new Error(err.error || 'Restore failed (' + r.status + ')'); }
        showStatus(statusEl, 'Restored. Reloading…', 'success');
        leaving = true;
        setTimeout(function () { location.reload(); }, 1200);
      } catch (e) { showStatus(statusEl, e.message, 'error'); }
    });
  }
  async function loadSnapshots() {
    var list = $('snapshot-list');
    var statusEl = $('snapshot-status');
    if (!list) return;
    try {
      var r = await fetch('/api/snapshots');
      if (!r.ok) throw new Error('Couldn\'t load snapshots (' + r.status + ')');
      var snaps = await r.json();
      if (!snaps.length) { list.innerHTML = '<p class="st-help">No snapshots yet. The first one is taken within a day of starting Epilykos.</p>'; return; }
      list.innerHTML = snaps.map(function (s) {
        return '<div class="st-snapshot"><div><span class="st-snapshot-date">' + esc(new Date(s.time).toLocaleString()) + '</span><span class="st-help"> · ' + esc(formatBytes(s.size)) + '</span></div>' +
          '<button type="button" class="st-btn" data-snapshot="' + esc(s.name) + '" data-when="' + esc(new Date(s.time).toLocaleString()) + '" data-size="' + esc(formatBytes(s.size)) + '">Restore…</button></div>';
      }).join('');
      list.querySelectorAll('[data-snapshot]').forEach(function (b) {
        b.addEventListener('click', async function () {
          if (!(await confirmRestore('Restore the snapshot from ' + b.dataset.when + '?', 'this snapshot (' + b.dataset.size + ')'))) return;
          showStatus(statusEl, 'Restoring from snapshot…', 'info');
          try {
            var res = await fetch('/api/snapshots/restore/' + encodeURIComponent(b.dataset.snapshot), { method: 'POST' });
            var data = await res.json().catch(function () { return {}; });
            if (!res.ok) throw new Error(data.error || 'Restore failed (' + res.status + ')');
            showStatus(statusEl, 'Snapshot restored. Reloading…', 'success');
            leaving = true;
            setTimeout(function () { location.reload(); }, 1200);
          } catch (e) { showStatus(statusEl, e.message, 'error'); }
        });
      });
    } catch (e) {
      list.innerHTML = '<p class="st-help"></p>';
      list.firstChild.textContent = e.message;
    }
  }

  // ── Forecast helpers ───────────────────────────────────────────────────
  function updateSolcastFields() {
    var a = $('forecast-default-source').value, b = $('weather-default-source').value;
    $('st-solcast-fields').hidden = a === 'open-meteo' && b === 'open-meteo';
  }
  function wireForecast() {
    ['forecast-default-source', 'weather-default-source'].forEach(function (id) { $(id).addEventListener('change', updateSolcastFields); });
    $('st-use-location').addEventListener('click', function () {
      var statusEl = $('st-location-status');
      if (!navigator.geolocation) { showStatus(statusEl, 'This browser can\'t share its location. Enter it yourself.', 'error'); return; }
      showStatus(statusEl, 'Finding your location…', 'info');
      navigator.geolocation.getCurrentPosition(function (pos) {
        $('solar-latitude').value = pos.coords.latitude.toFixed(4);
        $('solar-longitude').value = pos.coords.longitude.toFixed(4);
        touched.forecast = true;
        scheduleRecheck();
        showStatus(statusEl, 'Location filled in. Save to keep it.', 'success');
      }, function (err) {
        var msg = err.code === 1 ? 'Location permission was refused.' : 'Couldn\'t get your location.';
        if (!window.isSecureContext) msg += ' Browsers only share location over HTTPS or localhost.';
        showStatus(statusEl, msg + ' Enter it yourself.', 'error');
      }, { timeout: 10000 });
    });
  }

  // ── Help, metrics and mapping filters ──────────────────────────────────
  function wireFilters() {
    var ms = $('metrics-search');
    ms.addEventListener('input', function () {
      var q = ms.value.toLowerCase();
      document.querySelectorAll('#metrics-table-body tr').forEach(function (row) {
        row.hidden = !!q && row.textContent.toLowerCase().indexOf(q) === -1;
      });
    });
    var hs = $('help-search');
    hs.addEventListener('input', function () {
      var q = hs.value.toLowerCase().trim();
      document.querySelectorAll('#section-help details.help-accordion').forEach(function (acc) {
        var visible = !q || acc.textContent.toLowerCase().indexOf(q) !== -1;
        acc.hidden = !visible;
        if (q && visible) acc.open = true;
        acc.querySelectorAll('details.help-sub').forEach(function (sub) {
          var v = !q || sub.textContent.toLowerCase().indexOf(q) !== -1;
          sub.hidden = !v;
          if (q && v) sub.open = true;
        });
      });
    });
    // Per-device mapping filters (rows are added by settings.js).
    $('settings-form').addEventListener('input', function (e) {
      var input = e.target.closest('.mappings-filter-input');
      if (!input) return;
      var list = $(input.dataset.container);
      if (!list) return;
      var q = input.value.toLowerCase().trim();
      list.querySelectorAll('.metric-row').forEach(function (row) {
        row.style.display = !q || row.textContent.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
      });
    });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────
  function wire() {
    hydrateIcons(document);
    initTheme();
    var form = $('settings-form');
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    form.addEventListener('input', onUserEdit, true);
    form.addEventListener('change', onUserEdit, true);
    form.addEventListener('click', onUserEdit, true);
    form.addEventListener('input', scheduleRecheck);
    form.addEventListener('change', scheduleRecheck);
    // Enter in a field saves its section instead of submitting the form.
    form.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || !e.target.matches('input:not([type="checkbox"]):not([type="radio"])')) return;
      if (e.target.closest('.st-search, .mappings-filter-bar') || e.target.type === 'search') return;
      e.preventDefault();
      var sec = sectionOfEvent(e);
      if (sec && isDirty(sec)) saveSection(sec);
    });
    new MutationObserver(function (records) {
      var structural = records.some(function (r) { return r.addedNodes.length || r.removedNodes.length; });
      if (!structural) return;
      TYPES.forEach(function (t) { labelize($(t.container)); });
      if (current.section === 'sources' && current.type) {
        // A removed card: fall back to its type view.
        var t = typeByKey(current.type);
        if (current.index != null && t && !cardsOf(t)[current.index]) { go('sources/' + t.key); return; }
      }
      scheduleRecheck();
    }).observe($('section-sources'), { childList: true, subtree: true });

    $('st-save').addEventListener('click', function () { saveSection(current.section); });
    $('st-discard').addEventListener('click', function () { discardSection(current.section); });
    $('st-add-source').addEventListener('click', addSource);
    document.querySelectorAll('[data-open-add-source]').forEach(function (b) { b.addEventListener('click', addSource); });
    $('st-new-metric').addEventListener('click', newMetric);
    $('st-nav-open').addEventListener('click', openNav);
    $('st-nav-close').addEventListener('click', closeNav);
    $('st-scrim').addEventListener('click', closeNav);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.classList.contains('st-nav-open')) { closeNav(); $('st-nav-open').focus(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && SAVABLE.indexOf(current.section) !== -1) {
        e.preventDefault();
        if (isDirty(current.section)) saveSection(current.section);
      }
    });
    // In-page links leave through the guard.
    document.querySelectorAll('a[href="/"], a[href="/editor"], a[href="/setup"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        if (!anyDirty() || e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        confirmLeave(a.getAttribute('href'));
      });
    });
    window.addEventListener('beforeunload', function (e) {
      if (leaving || !anyDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    });
    window.addEventListener('hashchange', route);
    document.querySelector('.st-sources').addEventListener('click', function (e) {
      if (e.target.closest('[data-back-to-list]')) document.querySelector('.st-sources').classList.remove('show-detail');
    });
    wireSearch();
    wireBackup();
    wireForecast();
    wireFilters();
  }

  async function init() {
    wire();
    route();
    try { await (window.settingsReady || Promise.resolve()); } catch (e) { /* settings.js reports its own load errors */ }
    // Give catalogs and dropdowns a moment to settle before the baseline.
    await new Promise(function (r) { setTimeout(r, 400); });
    TYPES.forEach(function (t) {
      labelize($(t.container));
      cardsOf(t).forEach(function (c) { savedCards.add(c); });
    });
    labelize(document.getElementById('section-uploads'));
    updateSolcastFields();
    SAVABLE.forEach(takeBaseline);
    ready = true;
    await refreshMetricTimes();
    route();
    setInterval(function () { if (!document.hidden) refreshMetricTimes(); }, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
