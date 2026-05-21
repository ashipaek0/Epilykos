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
  // Note: content is intentionally rendered as HTML — only trusted admins can configure blocks
  container.innerHTML = config.content || '<em style="color:var(--text-secondary)">Configure content in settings</em>';
  return container;
}

export function updateTextCard(state) { /* static */ }
