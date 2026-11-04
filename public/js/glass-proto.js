/* Prototype switch for the glass card look (public/glass.css). Open the dashboard with ?glass=1 to turn it
 * on and ?glass=0 to turn it off; the choice is remembered in this browser. When it is on, a small "Glass"
 * button at the bottom left opens two sliders (blur and tint) for trying values. Not a setting yet. */
(function () {
  'use strict';
  var KEY = 'epilykos-glass';
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function write(v) { try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch (e) { /* private window */ } }

  var q = new URLSearchParams(location.search).get('glass');
  var state = read();
  if (q === '1') state = state || {};
  if (q === '0') state = null;
  if (q === '0' || q === '1') write(state);
  if (!state) return;

  function apply() {
    document.body.classList.add('glass-cards');
    // Only what has been moved is set; the rest follows the stylesheet (which differs in light and dark).
    if (state.blur != null) document.body.style.setProperty('--glass-blur', state.blur + 'px');
    if (state.tint != null) document.body.style.setProperty('--glass-tint', String(state.tint / 100));
  }
  function panel() {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;font:12px system-ui,sans-serif;color:#fff;';
    var btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = 'Glass';
    btn.style.cssText = 'padding:6px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.5);background:rgba(0,0,0,.45);color:#fff;cursor:pointer;backdrop-filter:blur(8px);';
    var box = document.createElement('div');
    box.hidden = true;
    box.style.cssText = 'margin-bottom:8px;padding:10px 12px;border-radius:12px;background:rgba(0,0,0,.55);backdrop-filter:blur(10px);display:grid;gap:8px;min-width:200px;';
    function current(key) {
      if (state[key] != null) return state[key];
      var cs = getComputedStyle(document.body);
      return key === 'blur' ? parseFloat(cs.getPropertyValue('--glass-blur')) || 18 : Math.round((parseFloat(cs.getPropertyValue('--glass-tint')) || .3) * 100);
    }
    function slider(label, key, min, max, unit) {
      var shown = current(key);
      var row = document.createElement('label'); row.style.cssText = 'display:grid;gap:2px;';
      var out = document.createElement('span'); out.textContent = label + ': ' + shown + unit;
      var input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max; input.value = shown;
      input.addEventListener('input', function () { state[key] = Number(input.value); out.textContent = label + ': ' + state[key] + unit; apply(); write(state); });
      row.append(out, input); return row;
    }
    var off = document.createElement('button'); off.type = 'button'; off.textContent = 'Turn glass off';
    off.style.cssText = 'padding:4px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.4);background:transparent;color:#fff;cursor:pointer;';
    off.addEventListener('click', function () { write(null); location.search = ''; });
    box.append(slider('Blur', 'blur', 0, 40, 'px'), slider('Tint', 'tint', 0, 60, '%'), off);
    btn.addEventListener('click', function () { box.hidden = !box.hidden; });
    wrap.append(box, btn); document.body.appendChild(wrap);
  }
  function start() { apply(); panel(); }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
