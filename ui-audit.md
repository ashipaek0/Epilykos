# Epilykos UI/UX Design Audit & Overhaul Proposal

**Auditor:** Basquiat (UI/UX Designer)
**Date:** 18 July 2026
**Reference:** ui-warm.html (approved mockup), ui-design-preferences SKILL.md
**Scanner:** unslop-ui (devibe_scan.py) — Vibe Score: 24 ⚠️ "STRONG AI-default look"

---

## Executive Summary

The current Epilykos frontend is running a **tailwind-era, AI-default design system**. It uses blue as its primary accent (#3b82f6), a cool slate palette, bright neon chart colors, emoji-as-icons throughout, gradient fills, pulsing animations, pill-shaped buttons, and system-ui typography — essentially a textbook example of what the ui-design-preferences skill calls "very AI built and obvious."

The approved ui-warm.html mockup establishes a **warm residential aesthetic** — think Nest Thermostat, Apple Home, a physical meter — with a Stone/Amber/Olive/Sky palette, Inter typography with tabular-nums, 14px max radius, physical-object shadows, and absolutely no gradients, glow, or blue.

**The single most impactful change:** Replace the `:root` CSS custom properties with the warm residential design tokens. This one change cascades through ~80% of the UI and instantly moves the dashboard from "AI slop" to "warm residential." Everything else is cleanup.

---

## PHASE 1: STRUCTURED AUDIT

### Severity Legend
- **🔴 CRITICAL** — Violates explicit anti-pattern prohibition; user-facing rejection trigger
- **🟠 HIGH** — Materially wrong; undermines the warm residential direction
- **🟡 MEDIUM** — Inconsistent or incomplete; degrades polish
- **🟢 LOW** — Minor refinements, edge cases

---

### 🔴 CRITICAL — 5 findings

#### CRIT-1: BLUE AS PRIMARY ACCENT (#3b82f6 → amber)

| Aspect | Current | Target | Rule Cited |
|--------|---------|--------|------------|
| `--accent` | `#3b82f6` (Tailwind blue-500) | `#f59e0b` (amber-400) | "No blue. No indigo. No purple. Warm neutrals only." |
| Focus rings | `rgba(59,130,246,0.15)` | `rgba(245,158,11,0.12)` | "Focus ring: Amber-400 with 12% opacity" |
| Active tabs | Blue background | Amber background | Anti-pattern: "Blue as primary accent" |
| Hover states | Blue background on hover | Amber border + amber-50 bg | Same |
| Info boxes | `#dbeafe` / `#1e40af` text | Stone / amber | Same |

**Files affected:** `style.css` lines 7, 26, 75-79, 110-114, 119, 347-350, 610-611, 1092, 1084, 1108-1109, 1143, 1161, 1178, 1188, 1228, 1253

**JS hardcoded blue references:**
- `flowCard.js` lines 32, 35, 44 — `#3b82f6` for grid export
- `systemTopology.js` lines 72, 81, 110 — `#3b82f6` for grid export
- `flowCardSquare.js` line 94 — `#3b82f6`
- `flowCardSquare2.js` lines 72, 83 — `#3b82f6`
- `halfGaugeCard.js` lines 11, 48 — `#3b82f6` default color
- `halfGauge2Card.js` lines 12, 45 — `#3b82f6` default color
- `forecast.js` line 34 — `#3b82f6` for rain icon
- `main.js` line 20 — `#3b82f6` inline style
- `charts.js` line 54 — `#0062FF` for Load (should be stone-700)
- `chartPower.js` line 4 — `#0062FF` for Load
- `chartEnergy.js` lines 4-5 — `#0062FF` for Consumption

**Fix:** Replace all `#3b82f6` with `#f59e0b`, all `#2563eb` with `#d97706`, all `#0062FF` with `#44403c`. Update CSS custom properties and all JS hardcoded values.

---

#### CRIT-2: COLOR PALETTE — ENTIRE DESIGN TOKENS WRONG

| Token | Current Value | Target Value | Domain |
|-------|--------------|-------------|--------|
| `--bg` | `#f8fafc` (slate-50) | `#f5f4f0` (stone-100) | Page canvas |
| `--text` | `#0f172a` (slate-900) | `#1c1917` (stone-900) | Primary text |
| `--text-secondary` | `#475569` (slate-600) | `#787670` (stone-500) | Labels, hints |
| `--border` | `#e2e8f0` (slate-200) | `#e7e5e0` (stone-200) | Borders |
| `--solar` | `#FFEA00` (neon yellow) | `#f59e0b` (amber-400) | Solar accent |
| `--battery` | `#00E056` (neon green) | `#84a45a` (olive-500) | Battery accent |
| `--grid` | `#FF4255` (RED!) | `#87aec8` (sky-500) | Grid accent |
| `--home` | `#0062FF` (bright blue) | `#44403c` (stone-700) | Home/Load accent |

**Rule Cited:** ui-design-preferences palette table. "Palette: Stone-100 background, Stone-900 text, Stone-500 secondary, Stone-200 borders. Solar: Amber-400. Battery: Olive-500/600. Grid: Sky-500. Home: Stone-700."

**Impact:** Every card, chart, text element, and status indicator inherits the wrong color temperature. The dashboard reads as "Slack/Notion SaaS" instead of "home energy monitor."

---

#### CRIT-3: LINEAR GRADIENT ON PV PROGRESS BAR

**File:** `style.css` line 260
```css
.pvt-progress-fill { background: linear-gradient(90deg, #FFEA00, #fff07a); }
```

**Rule Cited:** Anti-pattern: "Gradients (linear or radial) on cards or backgrounds"

**Fix:** Replace with solid `var(--amber-400)` fill. Use a subtle opacity layer or solid-to-solid if differentiation is needed — but never a gradient.

---

#### CRIT-4: PULSING ANIMATION ON FLOW ARROWS

**File:** `style.css` lines 182-183
```css
.flow-arrow.flowing { animation: pulse 1.5s infinite; }
@keyframes pulse { 0% { opacity: 0.5; } 50% { opacity: 1; } 100% { opacity: 0.5; } }
```

**Rule Cited:** "No looping animations. No 'breathing' effects." + "Status dots: static (on/off), NOT pulsing."

**Fix:** Remove the pulse animation entirely. Energy flow direction is already communicated by arrow direction (→ / ←) and color. Static opacity transition on state change only.

---

#### CRIT-5: DOT-ANIMATED FLOW LINES IN TOPOLOGY

**Files:** `style.css` lines 728-764, 918-936

The `.topo-line.active::before` and `.fcs2-line.active::before` use `animation: dot-v 1.4s linear infinite` with travelling dots along SVG-style lines. These are functionally equivalent to pulse-dot animations.

**Rule Cited:** Anti-pattern: "Pulse-dot animations or blinking 'live' indicators" + "No looping animations"

**Fix:** Replace moving dots with a static colored line that changes opacity on state. If animation is truly desired for energy flow visualization, use a one-shot fill animation on state change only — never loop.

---

### 🟠 HIGH — 8 findings

#### HIGH-1: TYPOGRAPHY — System-UI instead of Inter

**File:** `style.css` line 42
```css
font-family: system-ui, -apple-system, sans-serif;
```

**Rule Cited:** "One typeface: Inter" — typography section

**Fix:** Add `@import url('https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600;14..32,700&display=swap');` and set `font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;`

**Impact:** Inter has a warmer, more refined character than system-ui. It's the single biggest typographic signal of the warm residential aesthetic.

---

#### HIGH-2: MISSING TABULAR-NUMS ON PRIMARY DATA VALUES

Current CSS has `font-variant-numeric: tabular-nums` on `.pvt-value` (line 256) and `.stat-value` (line 304), but NOT on:
- `.flow-value` (line 179) — the most prominent numbers on screen
- `.topo-value` (line 664)
- `.fcs-value` (line 874)
- `.fcs2-value` (line 908)
- `.battery-soc-big` (batteryBlock.js line 8)

**Rule Cited:** "Tabular-nums everywhere — numbers are the primary content and must not jump on update"

**Fix:** Add `font-variant-numeric: tabular-nums` to ALL value classes: `.flow-value`, `.topo-value`, `.fcs-value`, `.fcs2-value`, `.battery-soc-big`, `.bg-retro-value`, `.block-value`.

---

#### HIGH-3: EMOJI AS UI ICONS (12+ hits)

Scanner found 12 distinct emoji-as-icon usages across settings.html, editor.html, theme.js, pvToday.js, editor.js, network-detect.js:

| File | Emoji | Context |
|------|-------|---------|
| `settings.html:49` | ⚡ | Logo text |
| `settings.html:51-59` | 📡📊☀️🏠💰💾🎨🌐❓ | 9 nav icons |
| `settings.html:248` | ⚡ | Default dashboard title |
| `settings.html:268,305` | 💡 | Network info box |
| `settings.html:285` | 🚀 | Help accordion icon |
| `editor.html:254,258,266,277,287,290-291` | ⚡💾📦⚙️💡📥📤 | Editor UI |
| `theme.js:7,24` | ☀️🌙 | Theme toggle (both modes) |
| `pvToday.js:289-294` | ☀️🌧️☁️⛅ | Weather timeline icons |
| `editor.js:69` | ☀️ | Placeholder text |

**Rule Cited:** "No emoji unless user explicitly asks"

**Fix:** Replace all emoji with Flaticon Uicons (already loaded via CDN) or plain text. The settings nav icons can use fi-sr- classes. Theme toggle: use `fi fi-sr-moon` / `fi fi-sr-sun`. Weather timeline: use appropriate fi-sr- weather icons.

---

#### HIGH-4: PILL-SHAPED ELEMENTS (border-radius: 2rem / 99px)

| Class | Radius | File:Line |
|-------|--------|-----------|
| `.theme-toggle` | `2rem` | style.css:76 |
| `.settings-link` | `2rem` | style.css:83 |
| `.dashboard-tab` | `2rem` | style.css:104 |
| `.chart-controls button` | `2rem` | style.css:348 |
| `.stg-subnav-btn` | `99px` | style.css:1043 |
| `.stg-nav-badge` | `99px` | style.css:1016 |
| `.stg-search` | `99px` | style.css:1132 |
| `.mappings-filter-input` | `99px` | style.css:1241 |

**Rule Cited:** "No border-radius > 14px (no 'modern' inflated corners). No border-radius: 9999px (pill shapes)."

**Fix:** Replace all `2rem` (32px) and `99px` with `var(--radius-sm)` (10px) for interactive components and `var(--radius)` (14px) for cards/sections.

---

#### HIGH-5: GLOW ON DEVICE STATUS DOT

**File:** `style.css` line 1063
```css
.stg-device-status.on { background: #22c55e; box-shadow: 0 0 6px #22c55e80; }
```

**Rule Cited:** Anti-pattern: "Glowing borders or neon effects"

**Fix:** Remove the `box-shadow`. Status is communicated effectively by the green color alone. If emphasis is needed, use a 2px solid ring with 30% opacity (same approach as ui-warm.html badge dot: `box-shadow: 0 0 0 2px rgba(132,164,90,.25)`).

---

#### HIGH-6: CHART COLORS HARDCODED IN JS

`charts.js`, `chartPower.js`, `chartEnergy.js` hardcode the old palette:
- Load: `#0062FF` → should be `#44403c` (stone-700)
- Solar: `#FFEA00` → should be `#f59e0b` (amber-400)
- Battery: `#00E056` → should be `#84a45a` (olive-500)
- Grid: `#FF4255` → should be `#87aec8` (sky-500)

**Fix:** Reference CSS custom properties via `getComputedStyle()` or update hardcoded values to match the new palette. Prefer CSS variable references.

---

#### HIGH-7: SHADOW SYSTEM WRONG

**Current:** `0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)` — Tailwind `shadow-md` equivalent

**Target:** `0 1px 3px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06)` — physical-object shadow

**Rule Cited:** "Soft, physical-object shadows" shadow section

The current shadow is hard, short, and reads as a generic card lift. The target shadow is softer, taller, and reads as a physical object resting on a surface.

---

#### HIGH-8: DARK MODE INHERITS WRONG PALETTE

**File:** `style.css` lines 20-33

Dark mode re-declares the same wrong colors (`--accent: #3b82f6`, `--solar: #FFEA00`, etc.). The dark mode palette should use warm dark tones:
- `--dark-bg: #1c1917` (stone-900)
- `--dark-surface: #292524` (stone-800)
- `--dark-raised: #44403c` (stone-700)
- `--dark-text: #fafaf9` (stone-50)
- `--dark-text-2: #a8a29e` (stone-400)
- `--dark-border: #44403c` (stone-700)

---

### 🟡 MEDIUM — 7 findings

#### MED-1: `border-radius: 50%` circle nodes in topology

**Files:** `style.css` line 637 (`.topo-node-circle`), editor.html line 234 (`.spinner`)

Circular nodes for topology diagrams are acceptable (they're circles, not pills). However, the `.spinner` in editor.html uses `border-radius: 50%` for a loading indicator — this could be 10px for a rounded square spinner instead.

**Rule Cited:** "No border-radius > 14px" — circles are fine for diagram nodes, but check sizing.

---

#### MED-2: Radius `var(--radius)` = `1rem` = 16px — exceeds 14px max

**File:** `style.css` line 14: `--radius: 1rem;`

**Rule Cited:** "14px radius on cards, buttons, inputs" — `1rem` = 16px at default browser settings, exceeding the 14px cap.

**Fix:** `--radius: 14px;` (explicit), `--radius-sm: 10px;`, `--radius-xs: 8px;`

---

#### MED-3: Missing `prefers-reduced-motion` support

No `@media (prefers-reduced-motion: reduce)` anywhere in style.css.

**Rule Cited:** "Respect prefers-reduced-motion" — motion section

**Fix:** Add:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

#### MED-4: Red "danger" color (#ef4444) used extensively

Delete buttons, error states, remove buttons all use Tailwind red-500. While not explicitly prohibited by the anti-patterns list, it's a cool-toned red that clashes with the warm palette.

**Fix:** Replace `#ef4444` with `#b45309` (amber-700) for danger actions, or `#d97706` (amber-600). For error states, use a warmer red like `#c2410c`. Or keep muted red but use sparingly.

---

#### MED-5: Settings page `border-radius: 0.5rem` (8px) inconsistency

Settings page forms use `0.5rem` (8px) while the design system should use `var(--radius-sm)` (10px) for inputs and inner elements.

**Fix:** Standardize on the design token values.

---

#### MED-6: Login page uses independent inline styles

**File:** `login.html` lines 8-56

The login page has its own `<style>` block with hardcoded values (`border-radius: 1rem`, `0.5rem`) that don't reference CSS custom properties. It should inherit from the main design system.

**Fix:** Rewrite login.html inline styles to use CSS custom property references (e.g., `var(--radius)` instead of `1rem`).

---

#### MED-7: Flow Card Square `padding: 3rem` is excessive

**File:** `style.css` lines 833, 900

`.fcs-cell` and `.fcs2-cell` use `padding: 3rem` which is 48px of internal padding — massively wasteful in constrained dashboard blocks.

**Fix:** Reduce to `padding: 0.75rem` or `1rem` to match the ui-warm.html flow proportions.

---

### 🟢 LOW — 4 findings

#### LOW-1: Inter not loaded (no @import or link)

No Google Fonts import for Inter anywhere. The mockup ui-warm.html loads it. The production CSS should too.

---

#### LOW-2: Theme toggle hardcoded emoji ☀️/🌙

**File:** `theme.js` lines 7, 24

Already covered under HIGH-3 (emoji), but specifically: the theme toggle should use Flaticon Uicons which are already loaded.

---

#### LOW-3: Loading spinner uses blue (#3b82f6)

**File:** `editor.html` line 232: `border-top-color: var(--accent)` — inherits blue. Will be fixed when `--accent` becomes amber.

---

#### LOW-4: Grid timeline `.tl-segment.on` uses red (#FF4255)

**File:** `style.css` line 456

The "ON" grid state is colored red, which is semantically inverted (red = off/error). Should use sky-500 or olive-500 instead.

---

## PHASE 2: OVERHAUL PROPOSAL

### 2.1 Design Token System (CSS Custom Properties)

The overhaul starts with a single-source-of-truth `:root` block replacing the current CSS custom properties. This is implemented in a working mockup at `/home/ashipa/epilykos-dev/ui-review-dashboard.html`.

```css
:root {
  /* Neutral — warm stone */
  --stone-50:  #fafaf9;
  --stone-100: #f5f4f0;
  --stone-200: #e7e5e0;
  --stone-300: #d6d3cc;
  --stone-500: #787670;
  --stone-700: #44403c;
  --stone-900: #1c1917;

  /* Accents */
  --amber-400: #f59e0b;
  --amber-500: #d97706;
  --olive-500: #84a45a;
  --olive-600: #6b8e42;
  --sky-500:  #87aec8;

  /* Semantic */
  --surface:         var(--stone-50);
  --surface-raised:  #ffffff;
  --text-primary:    var(--stone-900);
  --text-secondary:  var(--stone-500);
  --border:          var(--stone-200);
  --accent:          var(--amber-400);
  --accent-strong:   var(--amber-500);
  --accent-focus:    rgba(245,158,11,.12);

  /* Shape */
  --radius:   14px;
  --radius-sm: 10px;
  --radius-xs: 8px;

  /* Typography */
  --font: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;

  /* Shadow — physical, barely-there */
  --shadow-card: 0 1px 3px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06);
  --shadow-icon: 0 1px 2px rgba(0,0,0,.03);

  /* Semantic domain colors */
  --color-solar:    var(--amber-400);
  --color-battery:  var(--olive-500);
  --color-home:     var(--stone-700);
  --color-grid:     var(--sky-500);
}
```

### 2.2 Specific CSS/HTML Changes (Prioritized)

#### Priority 1: Rewrite `:root` and `[data-theme="dark"]` blocks
**File:** `style.css` lines 1-33
**Action:** Replace entirely with the token system above. This fixes CRIT-1, CRIT-2, HIGH-7, HIGH-8, MED-2 in one edit.

#### Priority 2: Add Inter font import and apply to body
**File:** `style.css` (add before `:root`), `index.html` `<head>`
**Action:** Add Google Fonts import. Fixes HIGH-1.

#### Priority 3: Add tabular-nums to ALL value classes
**File:** `style.css`
**Action:** Add `font-variant-numeric: tabular-nums` to `.flow-value`, `.topo-value`, `.fcs-value`, `.fcs2-value`, `.battery-soc-big`, `.bg-retro-value`, `.block-value`. Fixes HIGH-2.

#### Priority 4: Remove gradient, pulse animation, dot animation
**File:** `style.css`
**Action:** 
- Line 260: `.pvt-progress-fill` → solid `var(--amber-400)`
- Lines 182-183: Delete `.flow-arrow.flowing` animation + `@keyframes pulse`
- Lines 728-764, 918-936: Remove all `animation: dot-v/dot-h infinite` rules
Fixes CRIT-3, CRIT-4, CRIT-5.

#### Priority 5: Replace all pill radius values
**File:** `style.css`
**Action:** Grep for `2rem` and `99px` in border-radius contexts; replace with `var(--radius-sm)` (10px). Fixes HIGH-4.

#### Priority 6: Replace emoji in all HTML templates
**Files:** `settings.html`, `editor.html`, `login.html`, `index.html`
**Action:** Replace every emoji with a Flaticon Uicon `<i class="fi fi-sr-...">` element. Fixes HIGH-3.

#### Priority 7: Update all JS hardcoded colors
**Files:** `flowCard.js`, `systemTopology.js`, `flowCardSquare.js`, `flowCardSquare2.js`, `charts.js`, `chartPower.js`, `chartEnergy.js`, `halfGaugeCard.js`, `halfGauge2Card.js`, `forecast.js`, `pvToday.js`, `theme.js`
**Action:** Replace `#3b82f6` → `#f59e0b`, `#0062FF` → `#44403c`, `#00E056` → `#84a45a`, `#FF4255` → `#87aec8`, `#FFEA00` → `#f59e0b`. Fixes CRIT-1 (JS portion), HIGH-6.

#### Priority 8: Remove glow from device status dot
**File:** `style.css` line 1063
**Action:** Delete `box-shadow: 0 0 6px #22c55e80`. Fixes HIGH-5.

#### Priority 9: Rewrite login.html inline styles
**File:** `login.html`
**Action:** Replace hardcoded values with CSS custom property references. Fixes MED-6.

#### Priority 10: Add prefers-reduced-motion
**File:** `style.css` (end of file)
**Action:** Add the media query. Fixes MED-3.

### 2.3 Component Redesigns

#### Flow Card (flowCard.js)
**Current state:** Horizontal flex layout with large icons (3.5rem), pulsing arrows, neon chart colors, no tabular-nums.
**Target state:** Match ui-warm.html exactly — 42px icon containers with `var(--radius-xs)` (8px), `var(--shadow-icon)`, uppercase 0.65rem labels, tabular-nums readings at 1.1rem/700, amber/gold solar, olive battery, stone-700 home, sky-500 grid. No pulse animation. Static connectors with amber when flowing.

#### System Topology (systemTopology.js)
**Current state:** Circle nodes with 50% border-radius, conic-gradient borders, travelling dot animations on lines, #3b82f6 grid export color.
**Target state:** Keep the cardinal layout but: simplify circles to 14px border-radius (rounded squares approach), replace conic-gradient with solid single-source border colors, remove all dot animations, use sky-500 for grid export.

#### Forecast Banner (forecastBanner.js)
**Current state:** Blue-accented clock, neon yellow solar values, Weather icons via Flaticon (good).
**Target state:** Amber accent for forecast clock, stone palette, keep Flaticon weather icons (they're already SVG, correct approach).

### 2.4 Settings Page — Needs Major Work (HIGH-3 affects 20+ lines)

The settings page is the single largest source of emoji-as-icons (9 nav items + logo + 6 help accordion icons). Every `.stg-nav-btn` uses emoji for its icon. The fix is mechanical but extensive:

```html
<!-- Before -->
<button class="stg-nav-btn" data-section="data-sources">
  <span class="stg-nav-icon">📡</span> Data Sources
</button>

<!-- After -->
<button class="stg-nav-btn" data-section="data-sources">
  <i class="fi fi-sr-antenna stg-nav-icon"></i> Data Sources
</button>
```

Flaticon mappings for settings nav:
- Data Sources: `fi fi-sr-antenna` or `fi fi-sr-signal-alt-2`
- Metrics: `fi fi-sr-chart-histogram`
- Solar: `fi fi-sr-solar-panel` (already loaded)
- Dashboard: `fi fi-sr-apps`
- Savings: `fi fi-sr-piggy-bank`
- Backup: `fi fi-sr-database`
- Branding: `fi fi-sr-palette`
- Network: `fi fi-sr-globe`
- Help: `fi fi-sr-interrogation`

### 2.5 Responsive Design Assessment

Current media queries:
- `@media (max-width: 768px)` — Dashboard stacks vertically, settings sidebar collapses to icons-only
- `@media (max-width: 600px)` — Flow card to 2-col grid, stats to 2-col grid, forecast wraps
- `@media (max-width: 480px)` — Topology shrinks, settings sidebar becomes horizontal scroll
- `@media (orientation: landscape) and (max-height: 500px)` — Compact mode with smaller fonts

**Assessment:** Coverage is good. No responsive breakpoints need changing. However, the spacing values should be reviewed after the palette migration — `0.5rem` gaps may feel tight with the new stone-100 background.

### 2.6 Dark Mode Support Assessment

Current dark mode exists but inherits the wrong palette. After the `:root` migration, dark mode needs:
1. Dark background: `#1c1917` (stone-900)
2. Dark surface: `#292524` (stone-800)
3. Accents remain the same (amber-400, olive-500, sky-500) — they work on dark backgrounds
4. Chart grid colors: `rgba(255,255,255,0.06)` instead of current `#334155`

### 2.7 Accessibility Assessment

- **Contrast:** With the new palette, stone-900 (#1c1917) on stone-100 (#f5f4f0) has a contrast ratio of ~15:1 — excellent. Stone-500 (#787670) on white has ~3.5:1 — marginal for labels; consider stone-600 for better contrast.
- **Focus states:** Currently `2px solid var(--accent)`. When accent becomes amber, this is WCAG-compliant on both light and dark backgrounds.
- **Touch targets:** Already enforced via `min-height: 44px; min-width: 44px` on interactive controls (style.css lines 997-1000). This is good and should be preserved.
- **Screen reader:** `aria-live` region exists in index.html line 45. Good.

---

## PHASE 3: MOCKUPS

### Dashboard Mockup
**File:** `/home/ashipa/epilykos-dev/ui-review-dashboard.html` ✅ Created and verified

This file demonstrates:
- Warm residential palette: Stone-100 background, stone-900 text, amber-400 solar, olive-500 battery, stone-700 home, sky-500 grid
- Inter typography with tabular-nums on all numeric readings
- 14px max radius (cards: 14px, metrics: 10px, icons: 8px)
- Physical-object shadows (`0 1px 3px + 0 8px 24px`)
- Energy flow matching ui-warm.html exactly — linear Solar→Battery→Home→Grid
- SVG chart placeholder with amber/olive/stone/sky curves (no neon, no blue)
- Grid status card with muted sky blue
- Dark mode toggle (functional)
- `prefers-reduced-motion` support
- Responsive breakpoints at 768px and 480px
- No gradients, no glow, no pulse dots, no emoji (all icons via Flaticon Uicons)

### Status of Settings Mockup
Given the scope of settings.html (1089 lines, 9 tabs, 8 sub-tabs, help accordions, device grids), a full settings mockup was not created. The settings page's primary violations are emoji-as-icons (HIGH-3) and pill-shaped buttons (HIGH-4) — both are mechanical replacements. The mockup dashboard demonstrates the design token system that settings.html can adopt by updating its `:root` variables.

---

## IMPLEMENTATION ROADMAP

| Step | Scope | Effort | Impact |
|------|-------|--------|--------|
| 1. Rewrite `:root` + `[data-theme="dark"]` in style.css | CSS only | 30 min | 🔴 Critical (fixes CRIT-1, CRIT-2, HIGH-7, HIGH-8, MED-2) |
| 2. Add Inter font import to index.html + style.css | HTML + CSS | 5 min | 🟠 High (HIGH-1) |
| 3. Add tabular-nums to all value classes | CSS only | 10 min | 🟠 High (HIGH-2) |
| 4. Remove gradients, pulse, dot animations | CSS only | 15 min | 🔴 Critical (CRIT-3, CRIT-4, CRIT-5) |
| 5. Replace pill radii (2rem/99px → 10px) | CSS only | 15 min | 🟠 High (HIGH-4) |
| 6. Replace emoji with Flaticon Uicons | HTML | 60 min | 🟠 High (HIGH-3) |
| 7. Update JS hardcoded colors | JS | 45 min | 🔴 Critical + 🟠 High (CRIT-1 JS, HIGH-6) |
| 8. Remove glow from device status | CSS only | 2 min | 🟠 High (HIGH-5) |
| 9. Rewrite login.html styles | HTML | 10 min | 🟡 Medium (MED-6) |
| 10. Add prefers-reduced-motion | CSS only | 2 min | 🟡 Medium (MED-3) |

**Total estimated effort:** ~3.5 hours for complete overhaul.
**Vibe score target:** 85+ (from current 24).

---

## APPENDIX: Unslop-UI Scanner Raw Output

```
unslop-ui scan: /home/ashipa/epilykos-dev/public/
  files scanned: 49   findings: 12   vibe score: 24
  verdict: STRONG AI-default look
  high: 0   medium: 12   low: 0
```

All 12 findings were "Emoji used as icons / section bullets" — confirming the scanner only flags one anti-pattern category. The manual audit above covers the full spectrum of violations.
