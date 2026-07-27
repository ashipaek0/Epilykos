# Epilykos Settings Redesign — Design Proposal v2

## Research Summary

I surveyed modern settings paradigms across VS Code, macOS System Settings, Home Assistant, Linear, Tailscale, Grafana, and Dribbble design explorations. Key patterns observed:

| Pattern | Used by | Strength |
|---------|---------|----------|
| Two-panel master-detail | VS Code, macOS, Tailscale | Persistent nav, fast section switching, searchable |
| Single-scroll progressive disclosure | Linear, Notion | Flat learning curve, natural scanning |
| Card-based hub with flyouts | Home Assistant, AWS Console | Visual grouping, status-at-a-glance |
| Tabbed horizontal nav | Grafana, Vercel | Simple, works for <7 sections |
| Tree-nav with search | VS Code (advanced) | Deep nesting, power-user friendly |

**Critical insight for Epilykos:** With 9+ sections, 8 sub-tabs in Data Sources, and a complex block editor — a flat list or tab bar fails. The navigation must support search, grouping, and progressive disclosure simultaneously.

---

## Direction 1: Two-Panel Master-Detail _(RECOMMENDED)_

### Navigation Model
Persistent left sidebar (260px) with grouped navigation + global search. Content panel on the right with breadcrumb, section content, and sub-navigation as horizontal tabs.

### Information Architecture
```
┌─ Sidebar ───────────────────────┐  ┌─ Content Panel ──────────────────┐
│ 🔍 Search settings...           │  │ ← Data Sources / Home Assistant  │
│                                 │  │                                  │
│ ▸ DATA & SOURCES                │  │ [HA] [MQTT] [Modbus] [RS232]     │
│   ● Home Assistant              │  │ [REST] [BMS] [Dongle] [PVOutput] │
│   ● MQTT                       │  │                                  │
│   ● Modbus                     │  │ ┌ HA Device 1 ───────────────┐   │
│   ● RS232                      │  │ │ URL: http://192...  ● OK   │   │
│   ● REST API                   │  │ │ Token: **********          │   │
│   ● BMS                        │  │ │ Poll: 30s  [Test] [Save]  │   │
│   ● Dongle                     │  │ └───────────────────────────┘   │
│   ● PVOutput                   │  │                                  │
│                                 │  │ + Add HA Device                 │
│ ▸ DASHBOARD & DISPLAY           │  │                                  │
│   ● Dashboard Layout            │  │                                  │
│   ● Branding                   │  │                                  │
│   ● Display Settings           │  │                                  │
│                                 │  │                                  │
│ ▸ MONITORING                    │  │                                  │
│   ● Metrics                    │  │                                  │
│   ● Solar Forecast             │  │                                  │
│   ● Savings                    │  │                                  │
│                                 │  │                                  │
│ ▸ SYSTEM                        │  │                                  │
│   ● Backup & Restore            │  │                                  │
│   ● Network                    │  │                                  │
│   ● Help                       │  │                                  │
└─────────────────────────────────┘  └──────────────────────────────────┘
```

### Why It Works
- **Persistent navigation** allows jumping between sections without losing context
- **Search filters nav items** — type "MQTT" and only matching sections light up
- **Logical grouping** collapses 17 items into 4 groups (expandable/collapsible)
- **Block editor removed** from settings — replaced with "Open in Editor →" link
- **Mobile:** sidebar becomes a slide-out drawer triggered by hamburger
- **Status badges** in nav show connected/disconnected state at a glance
- **44px touch targets** throughout — sidebar items, buttons, form controls

### Tradeoffs
- Slightly more complex to implement than a flat page
- Requires JavaScript for search filtering and mobile drawer
- 260px sidebar may feel wide on small tablets (collapsible in phase 2)

---

## Direction 2: Single-Page Accordion with Floating TOC

### Navigation Model
All sections on one scrollable page as collapsible accordions. A floating table-of-contents (TOC) pill on the right edge allows quick jumps. Global search filters which accordions are visible.

### Information Architecture
```
┌────────────────────────────────────────────────────┐
│ 🔍 Search settings...                    [☀ ☾]     │
│                                                    │
│ ▼ DATA SOURCES — 3 devices connected               │  ┌──────┐
│   [HA] [MQTT] [Modbus] [RS232] [REST] [BMS] ...    │  │ TOC  │
│   ┌ HA Device 1 ──────────────────────────┐        │  │ ● DS │
│   │ ...                                   │        │  │ ● Me │
│   └───────────────────────────────────────┘        │  │ ● So │
│                                                    │  │ ● Da │
│ ▼ METRICS — 12 metrics, 2 custom                  │  │ ● Br │
│   ┌ Metrics table ────────────────────────┐        │  │ ● Sa │
│   │ ...                                   │        │  │ ● Ba │
│   └───────────────────────────────────────┘        │  │ ● Ne │
│                                                    │  │ ● He │
│ ▶ SOLAR FORECAST                                   │  └──────┘
│ ▶ DASHBOARD — 1 dashboard, 5 blocks                │
│ ▶ BRANDING                                         │
│ ▶ SAVINGS                                          │
│ ▶ BACKUP & RESTORE                                 │
│ ▶ NETWORK                                          │
│ ▶ HELP                                             │
└────────────────────────────────────────────────────┘
```

### Why It Works
- **Natural scanning** — users scroll through all options
- **Progressive disclosure** — collapsed sections reduce visual noise
- **Status in headers** — "3 devices connected" tells you state without opening
- **Search filtering** — type to show only matching sections, hide the rest
- **Floating TOC** — quick jumps without losing scroll position

### Tradeoffs
- Long scroll with 9+ sections; even collapsed, headers take space
- Hard to compare settings across sections
- Sub-tabs (8 in Data Sources) become unwieldy if collapsed
- TOC is a secondary navigation device — less intuitive than a sidebar
- Mobile TOC may overlap content awkwardly

---

## Direction 3: Dashboard-Centric Hub with Flyout Cards

### Navigation Model
A settings "hub" page with visual cards for each functional zone. Clicking a card opens a full-screen flyout/modal with that zone's settings. Search works across all zones.

### Information Architecture
```
┌────────────────────────────────────────────────────┐
│ ⚡ Epilykos Settings            🔍 Search...  [☀ ☾] │
│                                                    │
│ ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│ │ 📡           │  │ 📊           │  │ ☀️          │ │
│ │ Data Sources │  │ Monitoring   │  │ Dashboard   │ │
│ │ 5 connected  │  │ 12 metrics   │  │ 1 dashboard │ │
│ │ 2 errors     │  │ ● All OK     │  │ 5 blocks    │ │
│ └──────────────┘  └──────────────┘  └────────────┘ │
│                                                    │
│ ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│ │ 💰           │  │ 💾           │  │ 🌐          │ │
│ │ Savings      │  │ Backup       │  │ Network     │ │
│ │ €0.30/kWh    │  │ Last: 2h ago │  │ LAN + WAN   │ │
│ └──────────────┘  └──────────────┘  └────────────┘ │
│                                                    │
│ ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│ │ 🎨           │  │ ❓           │  │             │ │
│ │ Branding     │  │ Help         │  │             │ │
│ │ "Epilykos"   │  │ Guides, FAQ  │  │             │ │
│ └──────────────┘  └──────────────┘  └────────────┘ │
└────────────────────────────────────────────────────┘
```

### Why It Works
- **Visual scanning** — cards with status indicators give instant overview
- **Mental model** — each card is a "room" for a category of settings
- **Reduced cognitive load** — only one zone's settings visible at a time
- **Status-at-a-glance** — errors visible before opening any card
- **Search across zones** — global search highlights which card contains the match

### Tradeoffs
- Flyout/modal pattern means you lose context when drilling in
- No side-by-side comparison possible
- 9 cards need careful visual weight balancing
- Extra click to reach any setting (hub → card → setting)
- Mobile: cards work well but flyouts need full-screen treatment
- Sub-tabs (8 in Data Sources) become a flyout within a flyout — depth issues

---

## Comparison Matrix

| Criteria | Dir 1: Master-Detail | Dir 2: Accordion+TOC | Dir 3: Card Hub |
|----------|---------------------|---------------------|-----------------|
| Navigation speed | ★★★★★ Instant jump | ★★★☆☆ Scroll + click | ★★☆☆☆ Click + open |
| Search integration | ★★★★★ Filter nav + content | ★★★★☆ Filter visibility | ★★★★☆ Highlight cards |
| Section comparison | ★★★★☆ Switch tabs fast | ★★☆☆☆ Scroll back/forth | ★☆☆☆☆ Must close/open |
| Sub-tab support | ★★★★★ Horizontal tabs | ★★★☆☆ Nested accordion | ★★☆☆☆ Nested flyout |
| Mobile adaptation | ★★★★☆ Slide drawer | ★★★☆☆ Long scroll | ★★★★★ Card grid |
| Information density | ★★★★☆ Good use of space | ★★★☆☆ Spread out | ★★★☆☆ Extra clicks |
| Status visibility | ★★★★☆ Badges in nav | ★★★☆☆ Headers only | ★★★★★ Card previews |
| Implementation complexity | ★★★☆☆ Moderate JS | ★★☆☆☆ Simple | ★★★★☆ Modal management |

---

## Recommendation: Direction 1 — Two-Panel Master-Detail

### Why It's the Strongest Choice

1. **It solves the core IA problem.** The current settings page has no information architecture — 9 flat sections with no grouping. The master-detail pattern groups related sections under 4 categories (Data & Sources, Dashboard & Display, Monitoring, System), reducing cognitive load from 9 to 4 top-level choices.

2. **Search is first-class.** A persistent search bar filters both navigation and content. This directly addresses the "no search across settings" problem. Users can type "backup" and see the Backup section highlighted, or "MQTT" to jump directly to the MQTT sub-tab.

3. **Sub-tabs work naturally.** Data Sources' 8 sub-tabs become horizontal tabs in the content panel — a proven pattern (VS Code settings editor uses the same approach). The sidebar shows "Data Sources" as one item; expanding it reveals sub-items.

4. **Block editor removed.** The largest UX problem — the cramped inline block editor — is eliminated. Dashboard settings show a summary with an "Open in Editor →" link that navigates to /editor. No duplicate concern.

5. **Mobile-first.** On screens under 768px, the sidebar becomes a slide-out drawer. The hamburger menu is a universal mobile pattern. Content fills the full width. 44px touch targets are maintained throughout.

6. **Design system alignment.** The warm palette (Stone backgrounds, Amber accents, Olive status, Sky borders) maps naturally: sidebar uses card-bg, active items use Amber, connected status uses Olive green, borders use Sky blue. No blue, no gradients, no glow.

### What We're Removing
- **Inline block editor** — replaced with "Open in Editor →" link (de-duplicates concern)
- **Emoji as icons** — replaced with Unicode symbols (⚡ → \u26A1) and SVG icons
- **Radio buttons** — replaced with toggle switches or segmented controls
- **Pill buttons** (>14px radius) — all buttons use 8px border-radius
- **30×30px color pickers** — replaced with full-width 44px pickers
- **ALL CAPS labels** — sentence case throughout
- **"Inner BG" showing "—"** — removed; unused properties hidden
- **Floating export/import** — moved into a contextual toolbar within the Dashboard section
