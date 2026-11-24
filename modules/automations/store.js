'use strict';
/**
 * modules/automations/store.js — saved automations and their run log (SQLite).
 *
 * `automations`     one row per automation; `def_json` is the validated definition.
 * `automation_runs` what automations actually did (an action sent, or one that
 *                   failed). Kept apart from device_write_log so a busy
 *                   automation can't push the human-made changes out of that
 *                   log; the write itself is also logged there as 'automation:<id>'.
 */
const { getDb } = require('../database');

const RUNS_KEEP = 1000;
let tableFor = null;
function db() {
  const d = getDb();
  if (tableFor !== d) {
    d.exec(`CREATE TABLE IF NOT EXISTS automations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      def_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      automation_id INTEGER NOT NULL,
      name TEXT,
      branch TEXT,
      step INTEGER,
      target TEXT,
      wanted TEXT,
      outcome TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_automation_runs_auto ON automation_runs (automation_id, id)`);
    tableFor = d;
  }
  return d;
}

function rowToAutomation(r) {
  if (!r) return null;
  let def;
  try { def = JSON.parse(r.def_json); } catch (_) { return null; }
  return { id: r.id, ...def, name: r.name, enabled: !!r.enabled, created_at: r.created_at, updated_at: r.updated_at, updated_by: r.updated_by || '' };
}
const defJson = def => JSON.stringify({ ...def, enabled: undefined, name: undefined });

function list() { return db().prepare('SELECT * FROM automations ORDER BY id').all().map(rowToAutomation).filter(Boolean); }
function get(id) { return rowToAutomation(db().prepare('SELECT * FROM automations WHERE id = ?').get(id)); }

function create(def, by, nowMs = Date.now()) {
  const info = db().prepare('INSERT INTO automations (name, enabled, def_json, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(def.name, def.enabled ? 1 : 0, defJson(def), nowMs, nowMs, by || null);
  return get(Number(info.lastInsertRowid));
}
function update(id, def, by, nowMs = Date.now()) {
  const info = db().prepare('UPDATE automations SET name = ?, enabled = ?, def_json = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(def.name, def.enabled ? 1 : 0, defJson(def), nowMs, by || null, id);
  return info.changes ? get(id) : null;
}
function setEnabled(id, enabled, by, nowMs = Date.now()) {
  const info = db().prepare('UPDATE automations SET enabled = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(enabled ? 1 : 0, nowMs, by || null, id);
  return info.changes ? get(id) : null;
}
function remove(id) { return db().prepare('DELETE FROM automations WHERE id = ?').run(id).changes > 0; }

const s = v => (v === undefined || v === null ? null : String(v).slice(0, 300));
function logRun(run, nowMs = Date.now()) {
  const d = db();
  d.prepare('INSERT INTO automation_runs (ts, automation_id, name, branch, step, target, wanted, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(nowMs, run.automationId, s(run.name), s(run.branch), run.step === undefined ? null : run.step, s(run.target), s(run.wanted), run.outcome, s(run.detail));
  d.prepare('DELETE FROM automation_runs WHERE id <= (SELECT MAX(id) FROM automation_runs) - ?').run(RUNS_KEEP);
}
function recentRuns(limit = 100, automationId) {
  const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
  return automationId
    ? db().prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT ?').all(automationId, n)
    : db().prepare('SELECT * FROM automation_runs ORDER BY id DESC LIMIT ?').all(n);
}

module.exports = { list, get, create, update, setEnabled, remove, logRun, recentRuns, RUNS_KEEP };
