/**
 * Where to go after signing in: the page the visitor came from (?next=…), but
 * only if it is on this site. The address is parsed the way the browser parses
 * it (which drops tabs and line breaks and reads "\" as "/"), so nothing that
 * ends up on another site gets through, and the result always starts with this
 * site's own origin.
 */
(function (root) {
  'use strict';
  function safeNext(next, origin) {
    try {
      const url = new URL(String(next == null ? '' : next), origin);
      if (url.origin !== origin) return origin + '/';
      return origin + url.pathname + url.search + url.hash;
    } catch (_) { return origin + '/'; }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { safeNext };
  else root.safeNext = safeNext;
})(typeof window === 'undefined' ? globalThis : window);
