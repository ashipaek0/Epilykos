import { escapeHtml } from '../utils.js';

/** Another web page in a frame (sandboxed: scripts only). */
export function buildIframeCard(block = {}) {
  const config = block.config || {};
  const url = config.url || '';
  const container = document.createElement('div');
  container.className = 'iframe-card ep-card ep-card-flush';
  if (url) {
    container.innerHTML = `<iframe src="${escapeHtml(url)}" title="${escapeHtml(config.title || 'Embedded page')}" loading="lazy" sandbox="allow-scripts"><!-- sandbox allows scripts only; add allow-popups if needed --></iframe>`;
  } else {
    container.classList.add('ep-card-empty');
    container.textContent = 'Add the page address for this block in the layout editor.';
  }
  return container;
}

export function updateIframeCard(state) { /* static */ }
