'use strict';
/**
 * Dashboard presets that ship with Epilykos (presets/*.json): finished dashboards a person can add from the
 * layout editor. Each is one file in the same format as Export, so Import reads it too. presets/index.json says
 * what to call each one; what a preset needs (the card types and metrics it uses) is read from the file itself,
 * so the list can't drift from the preset.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'presets');
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Every metric name a preset's cards point at. */
function metricsUsed(node, found = new Set()) {
  if (Array.isArray(node)) node.forEach(n => metricsUsed(n, found));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'metric' && typeof v === 'string' && v) found.add(v);
      else metricsUsed(v, found);
    }
  }
  return found;
}

function cardTypesUsed(config) {
  const types = new Set();
  for (const db of config.dashboards || []) for (const b of db.layout || []) if (b && b.type) types.add(b.type);
  return types;
}

function read(file) { return JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); }

/** The listing: id, name, description, tags, the metrics and card types the preset uses. */
function listPresets(dir = DIR) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  return index.filter(p => ID.test(p.id) && fs.existsSync(path.join(dir, `${p.id}.json`))).map(p => {
    const config = JSON.parse(fs.readFileSync(path.join(dir, `${p.id}.json`), 'utf8'));
    return {
      id: p.id, name: p.name, description: p.description, tags: Array.isArray(p.tags) ? p.tags : [],
      dashboards: (config.dashboards || []).length,
      cards: (config.dashboards || []).reduce((n, db) => n + (db.layout || []).length, 0),
      metrics: [...metricsUsed(config)].sort(),
      hasPreview: fs.existsSync(path.join(dir, 'previews', `${p.id}.webp`)),
      remoteBackground: (config.dashboards || []).some(db => /^https?:/i.test(String(db.appearance && db.appearance.bgImage || ''))),
    };
  });
}

/**
 * The listed preset an id names, as the listing itself holds it: the file names below come from presets/index.json,
 * never from the request, so a request can only pick one of them.
 */
function listed(id) {
  if (typeof id !== 'string') return null;
  return listPresets().find(p => p.id === id) || null;
}

/** One preset's file contents, or null for an id that isn't listed. */
function getPreset(id) {
  const entry = listed(id);
  return entry ? read(`${entry.id}.json`) : null;
}

function previewPath(id) {
  const entry = listed(id);
  if (!entry || !entry.hasPreview) return null;
  return path.join(DIR, 'previews', `${entry.id}.webp`);
}

module.exports = { listPresets, getPreset, previewPath, metricsUsed, cardTypesUsed, DIR };
