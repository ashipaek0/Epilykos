/**
 * The tab icon from Settings → Branding → Favicon URL.
 *
 * The pages ship two icon links (an .ico and an .svg) and browsers choose
 * between them, so changing one left the built-in icon showing. A custom icon
 * replaces every icon link with one of its own. If the address does not load,
 * the built-in links come back.
 */
export function applyFavicon(doc, url) {
  if (!url) return;
  const builtIn = [...doc.querySelectorAll('link[rel~="icon"]')];
  builtIn.forEach(link => link.remove());
  const link = doc.createElement('link');
  link.rel = 'icon';
  link.href = url;
  link.addEventListener('error', () => {
    link.remove();
    builtIn.forEach(original => doc.head.appendChild(original));
  });
  doc.head.appendChild(link);
}
