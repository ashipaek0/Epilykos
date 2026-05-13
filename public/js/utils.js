export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function getDayName(dateStr) {
  const date = new Date(dateStr + 'T12:00:00');
  return date.toLocaleDateString(undefined, { weekday: 'long' });
}
