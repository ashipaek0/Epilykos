'use strict';
/**
 * modules/automations/index.js — control automations: saved rules that change
 * switches and device settings when conditions hold (admin only).
 *
 * start() runs the engine on its own 15 s timer, separate from the poll
 * cycle, so a slow or stuck poll doesn't stop automations. "Pause all"
 * (config 'automations_paused') stops every automation at once.
 */
const { getConfig, setConfig } = require('../database');
const { logger } = require('../logger');
const store = require('./store');
const catalog = require('./catalog');
const { validateDefinition } = require('./definition');
const { createEngine } = require('./engine');
const executor = require('./executor');

const TICK_MS = 15000;

function realDeps() {
  return {
    now: () => Date.now(),
    getMetrics: () => require('../metrics').getCurrentMetrics(),
    catalog: catalog.buildCatalog,
    list: store.list,
    readCurrent: executor.readCurrent,
    send: executor.send,
    logRun: run => { try { store.logRun(run); } catch (e) { logger.error('Automation log:', e.message); } },
    notify: (type, fields) => { try { require('../notifications/events').emitEvent(type, fields); } catch (_) { /* never breaks a run */ } },
    paused: () => isPaused(),
    error: (a, e) => logger.error(`Automation "${a.name}":`, e.message),
  };
}

const isPaused = () => getConfig('automations_paused') === 'true';
const setPaused = paused => setConfig('automations_paused', paused ? 'true' : 'false');

const engine = createEngine(realDeps());
let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { engine.tick().catch(e => logger.error('Automations tick:', e.message)); }, TICK_MS);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; engine.reset(); }

/** Validate against the current catalog. */
const validate = def => validateDefinition(def, catalog.buildCatalog());

module.exports = { start, stop, engine, store, validate, buildCatalog: catalog.buildCatalog, isPaused, setPaused, createEngine, realDeps, TICK_MS };
