/**
 * How far an image download has got, from the lines Docker streams while it
 * pulls ({"status":"Downloading","progressDetail":{"current":..,"total":..},"id":"<layer>"}).
 *
 * Layers Docker already has ("Already exists") are left out. A layer's size
 * is only known once its download starts, so until every layer of the pull
 * has one the total is unknown (null) and the page shows a moving bar rather
 * than one that would jump backwards.
 *
 * @module pullProgress
 */
'use strict';

const DOWNLOADED = new Set(['Verifying Checksum', 'Download complete', 'Extracting', 'Pull complete']);

function createPullProgress() {
  const layers = new Map(); // id -> { total, current, cached }

  function layer(id) {
    if (!layers.has(id)) layers.set(id, { total: null, current: 0, cached: false });
    return layers.get(id);
  }

  /** Feed one parsed line of the pull stream. */
  function add(line) {
    if (!line || typeof line !== 'object' || typeof line.id !== 'string' || typeof line.status !== 'string') return;
    // The first line names the tag ("Pulling from ...", id "latest"); layers are 12-hex ids.
    if (!/^[0-9a-f]{6,64}$/.test(line.id)) return;
    const l = layer(line.id);
    if (line.status === 'Already exists') { l.cached = true; return; }
    if (line.status === 'Downloading') {
      const d = line.progressDetail || {};
      if (Number.isFinite(d.total) && d.total > 0) {
        l.total = d.total;
        l.current = Math.min(Math.max(0, d.current || 0), d.total);
      }
      return;
    }
    if (DOWNLOADED.has(line.status) && l.total) l.current = l.total;
  }

  /** { bytes, total } (total null while a layer's size is still unknown). */
  function snapshot() {
    let bytes = 0, total = 0, unknown = false;
    for (const l of layers.values()) {
      if (l.cached) continue;
      if (!l.total) { unknown = true; continue; }
      bytes += l.current;
      total += l.total;
    }
    return { bytes, total: unknown || total === 0 ? null : total };
  }

  return { add, snapshot };
}

module.exports = { createPullProgress };
