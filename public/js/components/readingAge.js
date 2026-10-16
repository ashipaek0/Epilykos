/**
 * Is a control's reading too old to show as the device's state?
 *
 * Tuya devices are read every polling cycle (30 s) and every good read
 * refreshes the timestamp, so a reading several minutes old means the device
 * is not answering (unplugged, off the Wi-Fi, a new IP). Showing that old
 * value as live made a switch look on while it was off. Home Assistant and
 * MQTT only report changes, so their age says nothing and is not checked.
 */
export const STALE_AFTER_MS = 3 * 60 * 1000;

export function isStaleReading(source, data, now = Date.now()) {
  if (source !== 'tuya' || !data) return false;
  const ts = Number(data.timestamp);
  return ts > 0 && now - ts > STALE_AFTER_MS;
}
