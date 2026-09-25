/**
 * Generate a unique block ID
 * @returns {string} Unique identifier
 */
export function generateBlockId() {
  return `block_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Ensure every block in the layout has an ID
 * @param {Array} layout - Layout array
 * @returns {Array} Layout with IDs guaranteed
 */
export function ensureBlockIds(layout) {
  return layout.map(block => ({
    ...block,
    id: block.id || generateBlockId()
  }));
}
