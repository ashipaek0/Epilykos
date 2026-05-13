function parseGridState(state) {
  if (state === null || state === undefined) return 0;
  if (typeof state === 'number') return state > 0 ? 1 : 0;
  const str = String(state).toLowerCase().trim();
  if (str === 'on' || str === 'true' || str === '1' || str === 'open' || str === 'unlocked') return 1;
  return 0;
}

module.exports = { parseGridState };
