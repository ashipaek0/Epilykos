'use strict';
const checks = require('./_checks');
// Settings -> Network, "This box": the addresses Epilykos answers on.
const assert = require('node:assert/strict');
const { listInterfaces, describe } = require('../modules/networkInfo');

const a = (address, family = 'IPv4', internal = false, mac = 'b8:27:eb:1f:5d:d8') => ({ address, family, internal, mac });
const pi = {
  lo: [a('127.0.0.1', 'IPv4', true), a('::1', 'IPv6', true)],
  wlan0: [a('192.168.0.163'), a('fe80::ba27:ebff:fe1f:5dd8', 'IPv6')],
  eth0: [a('192.168.0.50'), a('2001:db8::5', 'IPv6')],
  podman0: [a('10.88.0.1')], docker0: [a('172.17.0.1')], tailscale0: [a('100.64.0.7')],
  usb0: [a('169.254.10.2')],
};

const list = listInterfaces(pi);
assert.deepEqual(list.map(i => [i.name, i.kind, i.ipv4, i.ipv6]), [
  ['eth0', 'ethernet', ['192.168.0.50'], ['2001:db8::5']],
  ['wlan0', 'wifi', ['192.168.0.163'], []],
], 'wired first; no loopback, container bridges, VPNs, link-local');
console.log('ok - interfaces: wired then Wi-Fi; loopback, bridges, VPNs and link-local addresses left out');

let d = describe({ appliance: true, port: 3000, ifaces: pi, container: true });
assert.deepEqual(d.urls, ['http://epilykos.local:3000/', 'http://192.168.0.50:3000/', 'http://192.168.0.163:3000/']);
assert.equal(d.hostname, 'epilykos');
assert.equal(d.containerOnly, false, 'on EpilykosOS the container shares the box network');
d = describe({ appliance: true, port: 80, ifaces: { wlan0: [a('192.168.0.163')] }, container: true });
assert.deepEqual(d.urls, ['http://epilykos.local/', 'http://192.168.0.163/'], 'port 80: no port in the address');
console.log('ok - appliance: epilykos.local and every address, with the port (none for 80)');

d = describe({ appliance: false, port: 3000, ifaces: { eth0: [a('172.18.0.4', 'IPv4', false, '02:42:ac:12:00:04')] }, container: true });
assert.equal(d.containerOnly, true);
assert.deepEqual(d.urls, [], 'a Docker bridge address is no use to another device');
assert.equal(d.hostname, null, 'a container ID is not a name');
d = describe({ appliance: false, port: 3000, ifaces: { eth0: [a('192.168.1.20')] }, container: false });
assert.deepEqual([d.containerOnly, d.urls], [false, ['http://192.168.1.20:3000/']]);
console.log('ok - Docker: its own bridge address is flagged rather than offered; a plain install lists its address');

checks.done();
