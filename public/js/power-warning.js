/* Low-power warning on the Settings pages (EpilykosOS only).
 * The Pi's firmware flags a supply that drops too low; the host reports it in
 * /api/system as `power`. A weak supply corrupts SD cards and drops Bluetooth,
 * and a dip of a few seconds is over before anyone looks, so a dip since the
 * last start is shown too, until it is dismissed (for this browser session). */
(function () {
  'use strict';

  /** What to say for a `power` report, or null when there is nothing to say. */
  function describe(power) {
    if (!power || !power.supported) return null;
    if (power.undervoltage_now) {
      return { key: 'now', now: true, title: 'Low power.',
        text: 'The supply voltage is too low right now. This can corrupt the SD card and drop Bluetooth. Use the official power supply and a short, thick cable.' };
    }
    if (power.undervoltage_since_boot) {
      var at = power.last_seen ? new Date(power.last_seen * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      return { key: 'since-' + (power.last_seen || 'boot'), now: false, title: 'Low power earlier.',
        text: 'The supply voltage dipped too low since the last start' + (at ? ' (last at ' + at + ')' : '') + '. Check the power supply and cable.' };
    }
    return null;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { describe: describe };
  if (typeof document === 'undefined') return;

  var host = document.getElementById('main-content');
  if (!host) return;
  var el = null;

  function dismissed(key) { try { return sessionStorage.getItem('epilykos-power-dismissed') === key; } catch (e) { return false; } }
  function dismiss(key) { try { sessionStorage.setItem('epilykos-power-dismissed', key); } catch (e) { /* stays until reload */ } }

  function show(d) {
    if (!d || (!d.now && dismissed(d.key))) { if (el) { el.remove(); el = null; } return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'st-power-warning';
      el.className = 'st-callout st-power-warning';
      el.setAttribute('role', 'status');
      host.insertBefore(el, host.firstChild);
    }
    el.classList.toggle('is-now', d.now);
    el.textContent = '';
    var p = document.createElement('p');
    var b = document.createElement('strong');
    b.textContent = d.title + ' ';
    p.appendChild(b);
    p.appendChild(document.createTextNode(d.text));
    el.appendChild(p);
    if (!d.now) {
      var x = document.createElement('button');
      x.type = 'button'; x.className = 'st-btn'; x.textContent = 'Dismiss';
      x.addEventListener('click', function () { dismiss(d.key); show(d); });
      el.appendChild(x);
    }
  }

  function check() {
    if (document.hidden) return;
    fetch('/api/system').then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
      show(s && s.appliance ? describe(s.power) : null);
    }).catch(function () { /* the next check tries again */ });
  }
  check();
  setInterval(check, 60000);
})();
