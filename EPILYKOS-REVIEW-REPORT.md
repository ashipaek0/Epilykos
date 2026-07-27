# EPILYKOS — Comprehensive Review Report

**Date:** 18 July 2026  
**Branch:** `settings-design-overhaul` (based on `dev`)  
**Repository:** `/home/ashipa/epilykos-dev`  
**Review Team:** Basquiat (UI/UX), Linus (Code), Ade (QA)  
**Project Manager:** AshipaEk0

---

## Executive Summary

Three specialist agents reviewed the Epilykos codebase and frontend. Total findings: **62 issues** across security, code quality, UI/UX design, and functional bugs.

| Severity | Count | Breakdown |
|---|---|---|
| 🔴 Critical | 9 | Security ×5, Design ×3, QA ×1 |
| 🟠 High | 17 | Code ×6, Design ×8, QA ×3 |
| 🟡 Medium | 15 | Code ×4, Design ×7, QA ×4 |
| 🟢 Low | 21 | Code ×7, Design ×4, QA ×10 |

**Overall verdict:** The backend has solid fundamentals (SQL parameterization, WebSocket reconnection, shutdown hooks) but critical security gaps. The frontend CSS is a Tailwind-era AI-default design system that must be replaced wholesale. The approved `ui-warm.html` mockup was never implemented in production CSS.

**Unslop scanner scores:**
- Code: 252 slop score (134 findings, 88 files)
- Frontend: 154 slop score (84 findings)
- UI: **24/100 vibe score** — "STRONG AI-default look"

---

## 🔴 CRITICAL — Immediate Action Required

### Security (Linus)

| ID | Finding | File | Risk |
|---|---|---|---|
| C-SEC-1 | **SSRF via external polling** — fetches any URL with no validation | `modules/external.js:24` | Server exploited to hit internal network |
| C-SEC-2 | **Stored XSS via textCard** — admin HTML injected unsanitized | `public/js/components/textCard.js:11` | Script execution for all dashboard viewers |
| C-SEC-3 | **Session secret regenerated on restart** — invalidates all sessions | `server.js:63` | Users silently logged out every restart |
| C-SEC-4 | **Settings password logged to console on startup** | `modules/sessionAuth.js:7-8` | Docker logs / journald expose admin password |
| C-SEC-5 | **Error details leaked to clients** — `err.message` in 27 API responses | `server.js` (27 occurrences) | File paths, DB errors, internal structure exposed |

### Design (Basquiat)

| ID | Finding | Rule Violated |
|---|---|---|
| C-DES-1 | **Blue as primary accent (#3b82f6)** across CSS + 6 JS files | "No blue. No indigo. No purple." |
| C-DES-2 | **Entire palette is wrong** — slate/zinc instead of stone/cream | "Warm neutrals only" |
| C-DES-3 | **Gradient fill on PV bar gauge** — `#0062FF → #00E056` | "No gradients on cards or backgrounds" |

### QA (Ade)

| ID | Finding | File |
|---|---|---|
| C-QA-1 | **DEBUG_PVTODAY = true in production** — 19 diagnostic console.log calls | `public/js/components/pvToday.js:72` |
| C-QA-2 | **escapeHtml defined 21 times** — massive code duplication | 21 files |

---

## 🟠 HIGH — Second Priority

### Cross-Confirmed (both Ade + Linus found these)

| ID | Finding | Ade | Linus |
|---|---|---|---|
| H-CROSS-1 | **23 empty catch blocks** swallow errors silently | H-2 | S-1 |
| H-CROSS-2 | **CSRF header mismatch** — `X-Requested-With` missing from frontend fetches | — | C-6 |
| H-CROSS-3 | **Missing #save-status element** — settings.js tries to update null | H-7 | — |

### Code (Linus)

| ID | Finding | File |
|---|---|---|
| H-CODE-1 | **N+1 query pattern** — `buildDashboardState()` makes 6+ sequential DB calls | `server.js:153-236` |
| H-CODE-2 | **Race condition in BMS polling** — overlapping cycles silently drop data | `modules/bms.js:10-58` |
| H-CODE-3 | **settings.js is 3,396 lines** — unmaintainable monolith | `public/settings.js` |
| H-CODE-4 | **settings save accepts any key** — no allowlist validation | `server.js:874-919` |
| H-CODE-5 | **Swallowed settings load failure** — error object discarded | `public/settings.js:71-73` |
| H-CODE-6 | **Save error on non-JSON response** — HTTP status lost | `public/settings.js:3376` |

### Design (Basquiat)

| ID | Finding | Rule Violated |
|---|---|---|
| H-DES-1 | **system-ui font instead of Inter** | "One typeface: Inter" |
| H-DES-2 | **Missing tabular-nums** — numbers jump on update | "tabular-nums everywhere" |
| H-DES-3 | **12+ emoji as icons** in components | "No emoji unless user explicitly asks" |
| H-DES-4 | **Pill-shaped buttons** — `border-radius: 2rem / 9999px` | "No border-radius > 14px" |
| H-DES-5 | **Glow on status dot** — `box-shadow: 0 0 8px` | "No glowing borders or neon effects" |
| H-DES-6 | **Hardcoded chart colors** — neon green `#00E056`, neon red `#FF4255`, bright blue `#0062FF` | "No blue... No gradients" |
| H-DES-7 | **Pulsing flow arrows** — `.flow-arrow` animation loops | "No looping animations" |
| H-DES-8 | **Wrong shadow system** — `0 2px 8px rgba(0,0,0,.1)` AI-default | "Physical-object shadows" |

### QA (Ade)

| ID | Finding | File |
|---|---|---|
| H-QA-1 | **Null-ref crash on theme-toggle** — unauthenticated users | `public/js/main.js:102` |
| H-QA-2 | **gridCard null-check crash** — missing element checks | `public/js/components/gridCard.js:89` |
| H-QA-3 | **Dashboard builder exception breaks entire render** — one bad block kills all | `public/js/dashboard.js:178` |
| H-QA-4 | **Theme has no fallback** — `prefers-color-scheme` unsupported = undefined state | `public/js/theme.js:3-5` |
| H-QA-5 | **settings.js `mappingsList` used before declaration** — closure captures undefined | `public/settings.js:552` |
| H-QA-6 | **CSS typo `padding: 0.25px`** — should be `0` or `0.25rem` | `public/style.css:129` |

---

## 🟡 MEDIUM

### Code (Linus)

| ID | Finding |
|---|---|
| M-CODE-1 | WebSocket broadcast — synchronous loop over clients, no built-in broadcast |
| M-CODE-2 | buildDashboardState runs regardless of connected WebSocket clients |
| M-CODE-3 | Database module uses sync `fs.mkdirSync` with no try/catch |
| M-CODE-4 | `db` export via Object.defineProperty — confusing lazy getter pattern |

### Design (Basquiat)

| ID | Finding |
|---|---|
| M-DES-1 | Circle nodes in topology — should be rounded rectangles |
| M-DES-2 | Radius ≥ 16px on cards — exceeds 14px max |
| M-DES-3 | No `prefers-reduced-motion` support |
| M-DES-4 | Red danger color — should be warm amber or muted red |
| M-DES-5 | `0.5rem` radius inconsistency — mixed radius scale |
| M-DES-6 | Login page uses isolated styles — diverges from dashboard |
| M-DES-7 | Excessive padding on cards — 24px/32px instead of warm residential 16-20px |

### QA (Ade)

| ID | Finding |
|---|---|
| M-QA-1 | Missing loading state for forecast/chart blocks |
| M-QA-2 | `updateWithState` doesn't handle undefined `dashboardConfig` |
| M-QA-3 | Logo `<img>` with empty `src` causes broken request |
| M-QA-4 | Chart.js loaded unconditionally — 200KB+ on every page |

---

## 🟢 LOW — Polish

### QA (Ade) — 8 findings
- 29 console.log statements in production code
- `substr()` deprecated usage
- `theme.js` double-imports charts module
- No `:focus-visible` styles for keyboard accessibility
- No skip-to-content link for screen readers
- Inline CSRF in settings.html differs from shared `csrf.js`
- `metric-cards` builder returns empty unstyled div
- `updateWeatherBlock` fetches forecast even without weather blocks

### Design (Basquiat) — 4 findings
- Inter font not loaded from CDN
- Theme toggle uses emoji
- Spinner is blue
- Grid ON state is red

### Code (Linus) — 3 findings
- Hardcoded BMS bridge URL with no auth
- `server.js` is 1,367 lines — should split into routes/
- `escapeHtml` is the most duplicated function in the codebase (21 copies)

---

## Cross-Check: Findings Confirmed by Multiple Agents

| Finding | Ade | Linus | Basquiat |
|---|---|---|---|
| Duplicate `escapeHtml` (21 copies) | ✅ C-2 | ✅ A-2 | — |
| Empty catch blocks (23 instances) | ✅ H-2 | ✅ S-1 | — |
| Missing error handling in settings saves | ✅ H-7 | ✅ S-2, B-3 | — |
| Monolithic settings.js (3,396 lines) | — | ✅ A-1 | — |
| Console.log spam in production | ✅ C-1 | — | — |
| Blue accent throughout | — | — | ✅ C-DES-1 |
| Emoji as icons (12+ instances) | ✅ (scan) | ✅ (scan) | ✅ H-DES-3 |

---

## UI Overhaul Proposal (Basquiat)

### Design Token System

Replace the current Tailwind-era `:root` block in `style.css`:

```css
:root {
  /* Neutral — warm stone */
  --stone-50:  #fafaf9;
  --stone-100: #f5f4f0;  /* Page canvas */
  --stone-200: #e7e5e0;  /* Borders */
  --stone-500: #787670;  /* Secondary text */
  --stone-700: #44403c;  /* Load accent */
  --stone-900: #1c1917;  /* Primary text */

  /* Accents */
  --amber-400: #f59e0b;  /* Solar */
  --olive-500: #84a45a;  /* Battery */
  --sky-500:  #87aec8;   /* Grid */

  /* Semantic */
  --surface: var(--stone-50);
  --text-primary: var(--stone-900);
  --text-secondary: var(--stone-500);
  --border: var(--stone-200);
  --accent: var(--amber-400);

  /* Shape */
  --radius: 14px;
  --radius-sm: 10px;

  /* Typography */
  --font: 'Inter', system-ui, sans-serif;
  font-variant-numeric: tabular-nums;

  /* Shadows — physical object */
  --shadow-card: 0 1px 3px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.06);
}
```

### Color Mapping

| Role | Current (Slop) | Target (Warm Residential) |
|---|---|---|
| Primary accent | `#3b82f6` (blue) | `#f59e0b` (amber) |
| Page background | `#f8fafc` (slate) | `#f5f4f0` (stone-100) |
| Card surface | `#ffffff` | `#ffffff` (keep) |
| Text primary | `#0f172a` | `#1c1917` (stone-900) |
| Text secondary | `#64748b` | `#787670` (stone-500) |
| Solar power | `#0062FF` (blue) | `#f59e0b` (amber) |
| Battery SOC | `#00E056` (neon green) | `#84a45a` (olive) |
| Grid import | `#FF4255` (red) | `#87aec8` (sky) |
| Home load | (varies) | `#44403c` (stone-700) |
| Focus ring | `rgba(59,130,246,.15)` (blue) | `rgba(245,158,11,.12)` (amber) |

### Files Requiring Changes

| File | Changes Needed |
|---|---|
| `public/style.css` | Replace `:root` tokens, remove ~50 blue references, replace chart colors, fix radius, remove gradients/glow/pulse, add `:focus-visible`, add `prefers-reduced-motion` |
| `public/js/components/flowCard.js` | Replace `#3b82f6` → `#44403c`, remove flow-arrow pulse animation |
| `public/js/components/systemTopology.js` | Replace `#3b82f6` → `#44403c`, remove dot pulse, circle → rounded rect |
| `public/js/components/flowCardSquare.js` | Replace `#3b82f6` → `#44403c` |
| `public/js/components/flowCardSquare2.js` | Replace `#3b82f6` → `#44403c` |
| `public/js/components/halfGaugeCard.js` | Replace `#3b82f6` → `#f59e0b` (default color) |
| `public/js/components/halfGauge2Card.js` | Replace `#3b82f6` → `#f59e0b` |
| `public/js/components/pvToday.js` | Replace gradient → solid amber fill, disable DEBUG_PVTODAY |
| `public/js/charts.js` | Replace neon chart colors with warm palette |
| `public/js/components/barGauge.js` | Replace gradient fills with solid |
| `public/index.html` | Load Inter font from CDN, fix logo src |
| `public/settings.html` | Add `#save-status` element, remove inline CSRF |

### Chart Color Replacement

```javascript
// Current (slop)
const solarColor = '#0062FF';    // bright blue
const batteryColor = '#00E056';   // neon green
const gridImportColor = '#FF4255'; // alarm red

// Target (warm residential)
const solarColor = '#f59e0b';    // amber-400
const batteryColor = '#84a45a';   // olive-500
const gridImportColor = '#87aec8'; // sky-500
const loadColor = '#44403c';      // stone-700
```

---

## Deliverables

| File | Size | Description |
|---|---|---|
| `ui-review-dashboard.html` | 25 KB / 725 lines | Working dashboard mockup with warm residential design tokens, SVG chart, dark/light mode, responsive |
| `ui-audit.md` | 25 KB / 569 lines | Complete UI/UX audit with 24 severity-graded findings, design token spec, component redesigns, 10-step implementation roadmap |

---

## Implementation Roadmap

| Step | What | Effort | Priority |
|---|---|---|---|
| 1 | Add SSRF protection to external polling | 30 min | 🔴 IMMEDIATE |
| 2 | Sanitize textCard HTML (DOMPurify) | 15 min | 🔴 IMMEDIATE |
| 3 | Stop exposing err.message to API clients | 1 hr | 🔴 |
| 4 | Fix session secret persistence | 15 min | 🔴 |
| 5 | Set DEBUG_PVTODAY = false | 5 min | 🔴 |
| 6 | Guard theme-toggle null check | 5 min | 🟠 |
| 7 | Add X-Requested-With to frontend fetch calls | 15 min | 🟠 |
| 8 | Replace `:root` CSS design tokens | 30 min | 🟠 |
| 9 | Replace blue → amber in 6 component JS files | 1 hr | 🟠 |
| 10 | Remove gradients, glow, pulse animations from CSS | 30 min | 🟠 |
| 11 | Replace hardcoded chart colors | 30 min | 🟠 |
| 12 | Fix all 23 empty catch blocks (add logging) | 1 hr | 🟡 |
| 13 | Add `:focus-visible` styles | 15 min | 🟡 |
| 14 | Eliminate duplicate escapeHtml (import from utils.js) | 1 hr | 🟡 |
| 15 | Parallelize buildDashboardState DB queries | 2 hr | 🟡 |
| 16 | Split settings.js into domain modules | 4 hr | 🟡 |
| 17 | Gate console.log behind localStorage.debug | 30 min | 🟢 |
| 18 | Add `prefers-reduced-motion` support | 15 min | 🟢 |

**Total estimated effort:** ~14 hours for full implementation.

---

## What's Done Well

1. **SQL parameterization** — all queries use `?` placeholders, no injection risk
2. **WebSocket reconnection** — exponential backoff, IndexedDB caching, visibility-change handling
3. **Growatt protocol parser** — proper binary frame handling with checksum validation
4. **Dongle SSRF guard** — `/api/dongle/test` has thorough IP/hostname validation
5. **Shutdown hooks** — SIGTERM/SIGINT clean up polling intervals, MQTT, RS232, DB
6. **Rate limiting** — login (10/min) + global (2000/15min)
7. **PWA support** — service worker with periodic background sync
8. **BMS Aggregator** — clean function composition with freshness checks and publication thresholds

---

*Report generated by the Epilykos Dev Team — Basquiat, Linus, Ade — under AshipaEk0's project management.*
