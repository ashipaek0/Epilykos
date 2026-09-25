export function uid(base, blockId) {
  return blockId ? `${base}-${blockId}` : base;
}
