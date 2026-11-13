/**
 * System hero card (type key `system-hero`): a small title, a headline and a status pill beside a picture (such as an
 * illustration of the house). The headline and the pill follow the first state whose rule is true, so the card can say
 * "Sun is powering the home" while solar covers the load and something else at night. A state with no metric always
 * applies, which makes it the fallback at the end of the list.
 *
 * The words can hold the three extra readings {a}, {b} and {c}, for example "All {a} panels producing". Every word is a
 * setting, so none is tied to a language.
 *
 * Block config: { title, image, extras: [{ metric, unit, signed }],
 *   states: [{ metric, when ('on'|'above'|'below'), limit, headline, pill, color }] }
 *
 * @module components/systemHero
 */
import { isOn, WHEN } from './statusList.js';
import { extraOptions, extraValues, fillWords, hexColor, imageUrl, num, word } from './cardText.js';

export const MAX_STATES = 8;

/** The valid options of a card's config. */
export function heroOptions(config = {}) {
  const states = (Array.isArray(config.states) ? config.states : [])
    .map(s => ({
      metric: String((s && s.metric) || '').trim(), when: WHEN.includes(s && s.when) ? s.when : 'on', limit: num(s && s.limit, 0),
      headline: word(s && s.headline, '', 80), pill: word(s && s.pill, '', 40), color: hexColor(s && s.color)
    }))
    .filter(s => s.headline || s.pill).slice(0, MAX_STATES);
  return { title: word(config.title, '', 40), image: imageUrl(config.image), extras: extraOptions(config.extras), states };
}

/** The first state whose rule is true for these metrics, or null. */
export function activeState(options, metrics) {
  for (const s of options.states) {
    if (!s.metric) return s;
    const entry = metrics ? metrics[s.metric] : undefined;
    if (entry && isOn(entry.value, s) === true) return s;
  }
  return null;
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

export function buildSystemHero(block = {}) {
  const o = heroOptions(block.config || {});
  const card = el('div', 'system-hero-card ep-card');
  card.dataset.blockId = block.id || '';
  card.dataset.heroCfg = JSON.stringify(o);
  card.classList.toggle('sh-has-image', !!o.image);
  const text = el('div', 'sh-text');
  if (o.title) text.appendChild(el('div', 'sh-title', o.title));
  text.append(el('div', 'sh-headline'), el('div', 'sh-pill'));
  card.appendChild(text);
  if (o.image) {
    const art = el('div', 'sh-art');
    const img = document.createElement('img');
    img.className = 'sh-img'; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.src = o.image;
    img.addEventListener('error', () => { card.classList.remove('sh-has-image'); art.remove(); });
    art.appendChild(img);
    card.appendChild(art);
  }
  return card;
}

export function updateSystemHero(state) {
  const metrics = (state && state.metrics) || {};
  document.querySelectorAll('.system-hero-card').forEach(card => {
    let o; try { o = JSON.parse(card.dataset.heroCfg); } catch (e) { return; }
    const s = activeState(o, metrics);
    const values = extraValues(o.extras, metrics);
    const headline = card.querySelector('.sh-headline'), pill = card.querySelector('.sh-pill');
    headline.textContent = s ? fillWords(s.headline, values) : '';
    pill.textContent = s ? fillWords(s.pill, values) : '';
    pill.style.setProperty('--sh-pill', (s && s.color) || '');
    card.dataset.state = s ? 'on' : 'none';
  });
}
