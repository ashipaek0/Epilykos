/**
 * The prepaid meter's data for the cards (the Prepaid meter card and the strip on the Grid card): one shared request to
 * /api/prepaid, kept for a short while so any number of cards cost one call, and the changes (recharge, correct, undo) that
 * a signed-in user makes. The showcase supplies its own made-up figures as `state.prepaid` and nothing is requested.
 *
 * @module components/prepaidClient
 */
const MAX_AGE_MS = 25000;
let cache = null, cachedAt = 0, inflight = null;
const listeners = new Set();

/** Be told whenever the figures change (after a refresh or a change). Returns the way to stop. */
export function onPrepaid(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function publish(data) { cache = data; cachedAt = Date.now(); listeners.forEach(fn => { try { fn(data); } catch (e) { /* a card failing must not stop the others */ } }); }

/** The figures: from `state.prepaid` when the page supplies them, else the shared request (at most one every 25 seconds). */
export function getPrepaid(state, { force = false } = {}) {
  if (state && state.prepaid) { if (cache !== state.prepaid) publish(state.prepaid); return Promise.resolve(state.prepaid); }
  if (!force && cache && Date.now() - cachedAt < MAX_AGE_MS) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch('/api/prepaid', { credentials: 'same-origin', cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(data => { inflight = null; if (data) publish(data); return data; })
    .catch(() => { inflight = null; return cache; });
  return inflight;
}

/** What is known right now, with no request. */
export const peekPrepaid = () => cache;

/** A change by a signed-in user: path is 'recharge', 'correct' or 'undo'. Resolves with the new figures, or rejects with the reason. */
export async function prepaidAction(path, body) {
  const r = await fetch('/api/prepaid/' + path, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `The server said ${r.status}.`);
  publish(data.view);
  return data.view;
}
