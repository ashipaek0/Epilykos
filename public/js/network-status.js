/**
 * Settings → Network, "This box": the addresses Epilykos answers on, and
 * on EpilykosOS how the box is connected (Wi-Fi network and signal, router,
 * Wi-Fi country). Read-only; refreshed whenever the section opens.
 * Loaded after settings-shell.js (window.stShell).
 */
(function () {
  'use strict';

  var root = document.getElementById('net-status-root');
  if (!root) return;
  var shell = window.stShell || {};
  var esc = shell.esc || function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };

  async function getJson(url) {
    var res = await fetch(url, { cache: 'no-store' });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
    return data;
  }

  /** A word for a Wi-Fi signal, so −78 dBm needs no explaining. */
  function signalWord(dbm) {
    if (dbm >= -55) return 'excellent';
    if (dbm >= -67) return 'good';
    if (dbm >= -75) return 'fair';
    return 'weak';
  }

  /** One line of the card: a label and what it is. */
  function row(label, detail) {
    return '<div><dt>' + label + '</dt><dd>' + detail + '</dd></div>';
  }

  function render(info, net) {
    var html = '';
    if (info.urls && info.urls.length) {
      html += '<p class="st-help">Open Epilykos on this network at '
        + info.urls.map(function (u) { return '<a href="' + esc(u) + '"><code>' + esc(u) + '</code></a>'; }).join(' or ') + '.</p>';
    }
    var rows = '';
    var wifi = net && net.wifi;
    (info.interfaces || []).forEach(function (i) {
      var label = i.kind === 'wifi' ? 'Wi-Fi' : i.kind === 'ethernet' ? 'Ethernet' : esc(i.name);
      var parts = i.ipv4.map(esc);
      if (i.kind === 'wifi' && wifi && wifi.connected && wifi.interface === i.name) {
        if (wifi.ssid) parts.push('network <b>' + esc(wifi.ssid) + '</b>');
        if (typeof wifi.signal_dbm === 'number') parts.push('signal ' + wifi.signal_dbm + ' dBm (' + signalWord(wifi.signal_dbm) + ')');
        if (wifi.channel) parts.push('channel ' + wifi.channel);
      }
      if (!i.ipv4.length && i.ipv6.length) parts.push(esc(i.ipv6[0]));
      rows += row(label, parts.join(' · '));
    });
    if (wifi && !wifi.connected && !(info.interfaces || []).some(function (i) { return i.kind === 'wifi'; })) {
      rows += row('Wi-Fi', 'not connected');
    }
    if (net && net.gateway) rows += row('Router', esc(net.gateway));
    if (net && net.wifi_country) {
      rows += row('Wi-Fi country', esc(net.wifi_country) + (net.wifi_country_source ? ' (from the ' + esc(net.wifi_country_source) + ')' : ''));
    } else if (net && wifi) {
      rows += row('Wi-Fi country', 'Not set, so channels 12 and 13 stay unused. Choose the site time zone under System.');
    }
    if (info.hostname) rows += row('Name', esc(info.appliance ? info.hostname + '.local' : info.hostname));
    if (rows) html += '<dl class="st-facts">' + rows + '</dl>';
    else html += '<p class="st-help">No network address yet.</p>';
    if (info.containerOnly) {
      html += '<p class="st-help">These are the Docker container’s own addresses, which other devices can’t reach. '
        + 'Open Epilykos at the address of the computer running Docker, on port ' + esc(info.port) + '.</p>';
    }
    root.innerHTML = html;
  }

  async function load() {
    try {
      var info = await getJson('/api/system/addresses');
      var net = null;
      if (info.appliance) {
        try { net = (await getJson('/api/system')).network || null; } catch (e) { net = null; }
      }
      render(info, net);
    } catch (e) {
      root.innerHTML = '<p class="st-help"></p>';
      root.querySelector('p').textContent = 'Could not read the network status: ' + e.message;
    }
  }

  document.addEventListener('st:section-shown', function (ev) {
    if (ev.detail && ev.detail.section === 'network') load();
  });
  load();
})();
