/** A note you write, shown as plain text (line breaks kept). */
export function buildTextCard(block = {}) {
  const config = block.config || {};
  const container = document.createElement('div');
  container.className = 'text-card ep-card';
  // textCard renders plain text only — content is set via textContent to prevent XSS
  container.textContent = config.content || '';
  if (!config.content) {
    container.classList.add('ep-card-empty');
    container.textContent = 'Write the text for this block in the layout editor.';
  }
  return container;
}

export function updateTextCard(state) { /* static */ }
