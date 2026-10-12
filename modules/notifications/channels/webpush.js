'use strict';
/**
 * Web Push channel — browser push to the admin's subscribed devices.
 * config: { devices: 'all' | [deviceId, ...] }. One channel can target every
 * device or a chosen few, so a rule can alert "my phone" without the tablet.
 * Subscriptions the push service reports gone (404/410) are removed.
 */

const webpush = require('web-push');

const TTL = { info: 6 * 3600, warning: 24 * 3600, critical: 24 * 3600 };
const URGENCY = { info: 'low', warning: 'normal', critical: 'high' };

function validate(config) {
  const d = config.devices;
  if (d !== 'all' && !(Array.isArray(d) && d.length)) return 'Pick at least one device (or all devices)';
  return null;
}

function targets(config, devices) {
  if (config.devices === 'all') return devices;
  const ids = new Set(config.devices || []);
  return devices.filter(d => ids.has(d.id));
}

function payloadFor(msg) {
  return JSON.stringify({
    title: msg.title,
    body: msg.body,
    severity: msg.severity,
    tag: msg.tag || 'epilykos',
    url: msg.url || '/',
    timestamp: (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000,
  });
}

/**
 * deps: { getDevices(), removeDevice(id), markDevice(id, ok), vapid: {publicKey, privateKey, subject}, sendNotification? }
 */
async function send(config, msg, deps) {
  const err = validate(config);
  if (err) throw new Error(err);
  const list = targets(config, deps.getDevices());
  if (!list.length) throw new Error('No subscribed devices for this channel — enable push on a device first');
  const sendNotification = deps.sendNotification || webpush.sendNotification.bind(webpush);
  const options = {
    TTL: TTL[msg.severity] || TTL.info,
    urgency: URGENCY[msg.severity] || 'normal',
    vapidDetails: { subject: deps.vapid.subject, publicKey: deps.vapid.publicKey, privateKey: deps.vapid.privateKey },
    timeout: 15000,
  };
  const payload = payloadFor(msg);
  const failures = [];
  let delivered = 0;
  await Promise.all(list.map(async (d) => {
    try {
      await sendNotification({ endpoint: d.endpoint, keys: d.keys }, payload, options);
      delivered++;
      if (deps.markDevice) deps.markDevice(d.id, true);
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        if (deps.removeDevice) deps.removeDevice(d.id);
        failures.push(`${d.label || d.id}: subscription expired, device removed`);
      } else {
        if (deps.markDevice) deps.markDevice(d.id, false);
        failures.push(`${d.label || d.id}: ${e && e.statusCode ? 'HTTP ' + e.statusCode : (e && e.message) || e}`);
      }
    }
  }));
  // Partial delivery counts as sent; every device failing is an error.
  if (!delivered) throw new Error(failures.join('; '));
  return { delivered, failures };
}

module.exports = { type: 'webpush', label: 'Push to devices', secretFields: [], validate, targets, payloadFor, send };
