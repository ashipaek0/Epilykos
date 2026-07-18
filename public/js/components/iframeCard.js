import { escapeHtml } from '../utils.js';
export function buildIframeCard(block = {}) {
  const config = block.config || {};
  const url = config.url || '';
  const container = document.createElement('div');
  container.className = 'iframe-card';
  container.style.width = '100%'; container.style.height = '100%'; container.style.minHeight = '300px';
  if (url) {
    container.innerHTML = `<iframe src="${escapeHtml(url)}" style="width:100%;height:100%;min-height:300px;border:none;border-radius:var(--radius);" sandbox="allow-scripts"><!-- sandbox allows scripts only; add allow-popups if needed --></iframe>`;
  } else {
    container.innerHTML = '<div style="padding:1rem;color:var(--text-secondary);text-align:center;">Configure URL in settings</div>';
  }
  return container;
}
export function updateIframeCard(state) { /* static */ }
