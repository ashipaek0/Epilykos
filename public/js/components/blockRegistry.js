/**
 * Block registry: the block definition behind each rendered card, by block id.
 *
 * Cards read their own config from here when they update, instead of reaching
 * into the dashboard page's module state. That lets the same cards run on the
 * dashboard and in the layout editor (live previews). components/index.js
 * registers every block as it is built.
 *
 * @module components/blockRegistry
 */
const blocks = new Map();

/** Remember the block a card was built from (latest build wins). */
export function registerBlock(block) {
  if (block && block.id != null) blocks.set(String(block.id), block);
}

/** The block for a block id, or null. */
export function blockFor(id) {
  return id == null ? null : blocks.get(String(id)) || null;
}

/** The block for a card element (its own data-block-id or its wrapper's). */
export function blockForElement(el) {
  const id = el?.dataset?.blockId || el?.closest?.('[data-block-id]')?.dataset?.blockId;
  return blockFor(id);
}
