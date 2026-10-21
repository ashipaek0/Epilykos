/**
 * The addresses this Epilykos answers on, for the "This box" card at the
 * top of Settings -> Network. Read from the interfaces the app sees: on
 * EpilykosOS the container shares the host's network, so they are the
 * box's own. Inside an ordinary Docker container they are the container's
 * (172.17.x.x and so on), and the card says so.
 *
 * @module networkInfo
 */
'use strict';
const os = require('node:os');
const fs = require('node:fs');

// Container bridges, VPNs and other virtual links nobody types into a browser.
const SKIP = /^(lo|docker|veth|br-|virbr|podman|cni|flannel|cali|tun|tap|wg|zt|tailscale)/;

function kindOf(name) {
  if (/^wl/.test(name)) return 'wifi';
  if (/^(en|eth)/.test(name)) return 'ethernet';
  return 'other';
}

/** Interfaces with an address someone on the network could use; wired first. */
function listInterfaces(ifaces = os.networkInterfaces()) {
  const order = { ethernet: 0, wifi: 1, other: 2 };
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    if (SKIP.test(name) || !Array.isArray(addrs)) continue;
    const v4 = addrs.filter(a => !a.internal && (a.family === 'IPv4' || a.family === 4) && !a.address.startsWith('169.254.'));
    const v6 = addrs.filter(a => !a.internal && (a.family === 'IPv6' || a.family === 6) && !/^fe80:/i.test(a.address));
    if (!v4.length && !v6.length) continue;
    out.push({ name, kind: kindOf(name), ipv4: v4.map(a => a.address), ipv6: v6.map(a => a.address), mac: (v4[0] || v6[0]).mac || null });
  }
  return out.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

function inContainer() {
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
}

/** Docker's own bridge networks (172.16.0.0/12), as a container without host networking sees itself. */
function isBridgeAddress(ip) {
  const m = /^172\.(\d+)\./.exec(ip);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

/**
 * @param {{appliance: boolean, port: number, ifaces?: object, container?: boolean}} opts
 */
function describe({ appliance, port, ifaces, container = inContainer() }) {
  const interfaces = listInterfaces(ifaces);
  const v4 = interfaces.flatMap(i => i.ipv4);
  // On EpilykosOS the container shares the box's network; elsewhere a
  // container's own addresses aren't reachable from other devices.
  const containerOnly = !appliance && container && v4.length > 0 && v4.every(isBridgeAddress);
  const portPart = Number(port) === 80 ? '' : ':' + port;
  const urls = containerOnly ? [] : v4.map(ip => `http://${ip}${portPart}/`);
  if (appliance) urls.unshift(`http://epilykos.local${portPart}/`);
  return {
    appliance, port: Number(port), interfaces, urls, containerOnly,
    // A container's own hostname is a random ID: only worth showing outside one.
    hostname: appliance ? 'epilykos' : (container ? null : os.hostname()),
  };
}

module.exports = { listInterfaces, describe, isBridgeAddress };
