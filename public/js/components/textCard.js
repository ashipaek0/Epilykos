export function buildTextCard(block = {}) {
  const config = block.config || {};
  const container = document.createElement('div');
  container.className = 'text-card';
  container.style.padding = '1rem';
  container.style.color = 'var(--text)';
  container.style.fontSize = 'var(--fs-small)';
  container.style.lineHeight = '1.5';
  container.style.whiteSpace = 'pre-wrap';
  container.style.wordBreak = 'break-word';
  // textCard renders plain text only — content is set via textContent to prevent XSS
  container.textContent = config.content || '';
  return container;
}

export function updateTextCard(state) { /* static */ }
