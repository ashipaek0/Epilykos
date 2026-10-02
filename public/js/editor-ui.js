/**
 * Small accessible UI primitives for the dashboard editor: a modal dialog
 * (native <dialog>, so focus trapping and Escape come from the browser),
 * a popup menu and a toast with an optional action.
 */
import { icon } from './editor-catalog.js';

/**
 * Open a modal dialog. `body` is a DOM node or trusted HTML string.
 * Resolves with the dialog's <form> when confirmed, or null when cancelled.
 */
export function openDialog({ title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, alert = false, onOpen } = {}) {
  return new Promise(function(resolve) {
    var returnFocus = document.activeElement;
    var dlg = document.createElement('dialog');
    dlg.className = 'ed-dialog';
    if (alert) dlg.setAttribute('role', 'alertdialog');
    var titleId = 'dlg-title-' + Math.random().toString(36).slice(2, 8);
    dlg.setAttribute('aria-labelledby', titleId);

    var form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'ed-dialog-form';
    var h = document.createElement('h2');
    h.id = titleId;
    h.className = 'ed-dialog-title';
    h.textContent = title;
    form.appendChild(h);

    var content = document.createElement('div');
    content.className = 'ed-dialog-body';
    if (typeof body === 'string') content.innerHTML = body; else if (body) content.appendChild(body);
    form.appendChild(content);

    var actions = document.createElement('div');
    actions.className = 'ed-dialog-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'ed-btn';
    cancel.textContent = cancelLabel;
    var ok = document.createElement('button');
    ok.type = 'submit';
    ok.value = 'confirm';
    ok.className = danger ? 'ed-btn ed-btn-danger' : 'ed-btn ed-btn-primary';
    ok.textContent = confirmLabel;
    actions.appendChild(cancel);
    actions.appendChild(ok);
    form.appendChild(actions);
    dlg.appendChild(form);
    document.body.appendChild(dlg);

    var confirmed = false;
    cancel.addEventListener('click', function() { dlg.close(); });
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      if (!form.reportValidity()) return;
      confirmed = true;
      dlg.close();
    });
    dlg.addEventListener('close', function() {
      dlg.remove();
      if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) returnFocus.focus();
      resolve(confirmed ? form : null);
    });
    dlg.showModal();
    // Destructive dialogs start on Cancel; others on the first field or the confirm button.
    var first = danger ? cancel : (content.querySelector('input, select, textarea') || ok);
    first.focus();
    if (first.select && first.type === 'text') first.select();
    if (onOpen) onOpen(dlg, form);
  });
}

var openMenuState = null;

export function closeMenu(restoreFocus) {
  if (!openMenuState) return;
  var s = openMenuState;
  openMenuState = null;
  s.menu.remove();
  s.anchor.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', s.onOutside, true);
  if (restoreFocus) s.anchor.focus();
}

/**
 * Open a popup menu under `anchor`. Items: { label, hint, onSelect, checked,
 * disabled, danger, separator, icon }.
 */
export function openMenu(anchor, items, { label } = {}) {
  var reopen = !openMenuState || openMenuState.anchor !== anchor;
  closeMenu(false);
  if (!reopen) return;

  var menu = document.createElement('div');
  menu.className = 'ed-menu';
  menu.setAttribute('role', 'menu');
  if (label) menu.setAttribute('aria-label', label);

  items.forEach(function(item) {
    if (item.separator) {
      var sep = document.createElement('div');
      sep.className = 'ed-menu-sep';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      return;
    }
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ed-menu-item' + (item.danger ? ' is-danger' : '');
    var isRadio = typeof item.checked === 'boolean';
    b.setAttribute('role', isRadio ? 'menuitemradio' : 'menuitem');
    if (isRadio) b.setAttribute('aria-checked', String(item.checked));
    b.disabled = !!item.disabled;
    b.tabIndex = -1;
    var mark = document.createElement('span');
    mark.className = 'ed-menu-mark';
    mark.innerHTML = isRadio ? (item.checked ? icon('check', 16) : '') : (item.icon ? icon(item.icon, 16) : '');
    var text = document.createElement('span');
    text.className = 'ed-menu-text';
    text.textContent = item.label;
    b.appendChild(mark);
    b.appendChild(text);
    if (item.hint) {
      var hint = document.createElement('span');
      hint.className = 'ed-menu-hint';
      hint.textContent = item.hint;
      b.appendChild(hint);
    }
    b.addEventListener('click', function() {
      closeMenu(true);
      if (item.onSelect) item.onSelect();
    });
    menu.appendChild(b);
  });

  document.body.appendChild(menu);
  var r = anchor.getBoundingClientRect();
  var left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
  anchor.setAttribute('aria-expanded', 'true');

  var enabled = function() { return Array.from(menu.querySelectorAll('.ed-menu-item:not(:disabled)')); };
  menu.addEventListener('keydown', function(e) {
    var list = enabled();
    var i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'Tab') { closeMenu(false); }
  });
  var onOutside = function(e) { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu(false); };
  document.addEventListener('pointerdown', onOutside, true);
  openMenuState = { menu: menu, anchor: anchor, onOutside: onOutside };
  var first = menu.querySelector('[aria-checked="true"]:not(:disabled)') || enabled()[0];
  if (first) first.focus();
}

export function isMenuOpen() { return !!openMenuState; }

var toastTimer = null;

/** Show a short message, optionally with one action (e.g. Undo). */
export function toast(message, { actionLabel, onAction, timeout = 6000, tone } = {}) {
  var region = document.getElementById('ed-toast-region');
  if (!region) return;
  clearTimeout(toastTimer);
  region.innerHTML = '';
  var t = document.createElement('div');
  t.className = 'ed-toast' + (tone ? ' is-' + tone : '');
  var msg = document.createElement('span');
  msg.className = 'ed-toast-msg';
  msg.textContent = message;
  t.appendChild(msg);
  if (actionLabel && onAction) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ed-toast-action';
    b.textContent = actionLabel;
    b.addEventListener('click', function() { hideToast(); onAction(); });
    t.appendChild(b);
  }
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'ed-toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML = icon('close', 16);
  close.addEventListener('click', hideToast);
  t.appendChild(close);
  region.appendChild(t);
  if (timeout) toastTimer = setTimeout(hideToast, timeout);
}

export function hideToast() {
  clearTimeout(toastTimer);
  var region = document.getElementById('ed-toast-region');
  if (region) region.innerHTML = '';
}
