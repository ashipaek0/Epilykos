# Epilykos (SapaSolar) — Settings Page Design Review

**URL:** https://sapasolar.ashipaek0.com.ng  
**Date:** 18 June 2026  
**Reviewer:** Hermes Agent  
**Scope:** Full settings section (Data Sources, Metrics, Solar, Dashboard, Branding, Backup, Help) + main dashboard

---

## Overall Verdict: **6/10**

The **dashboard** (flow diagram, bento-grid layout, real-time energy cards) is solid and competently designed. The **settings pages** feel like an afterthought — functionally complete but lacking the same visual polish, information architecture, and UX guardrails.

---

## What's Done Well

| Feature | Why |
|---|---|
| **Sidebar navigation** | Clean vertical list, active state is unmistakable (filled blue), consistent icon set across all sections |
| **Dark/light mode toggle** | Works reliably, both themes look intentional with cool-tone palettes |
| **Bento-grid dashboard layout** | Energy flow diagram at top is immediately readable. Cards are consistently spaced |
| **Mobile/Desktop viewport toggle** | Smart feature — lets users preview and edit layouts per device |
| **Metrics table** | Proper table structure with columns, sortable headers, filter input — far better than the flat-list approach in Data Sources |
| **Energy flow diagram** | Solar → Battery → Home → Grid with live wattage is the hero element; communicates system state at a glance |
| **Chart time-range selectors** | 24h/3d for power, 7d/30d/90d for energy — appropriate granularity for solar monitoring |
| **Branding section** | Only settings page that uses a proper card container |



## Critical Issues

### 1. Data Sources — Flat wall of form fields

The Home Assistant connection config dumps every control into one continuous column with zero visual grouping:

```
Data Sources
├── [Source type buttons]  ← HA / MQTT / Modbus / REST / BMS / Dongle / PVOutput
├── Device Name
├── Enabled checkbox
├── Remove button
├── URL
├── Access Token
├── Poll Interval
├── Fetch Entities button
├── Entity Mappings heading
├── Metric combo × Entity combo × Remove  × 30+ rows
```

**~40+ individual controls stacked vertically, no cards, no sections, no collapse.**

### 2. Entity Mappings — Unbounded row growth

30+ rows, each with 2 combo boxes + a delete button. No pagination, no search within the list. On a 14" laptop this scrolls for 3+ full pages.

### 3. Delete buttons everywhere, no confirmations

- **Metrics page:** Every row has a `Delete` button — one click, data gone
- **Data Sources:** Each entity mapping row has `Remove` — same issue
- **Dashboard settings:** Each widget has `Del` and `Remove` buttons
- None of these show a confirmation dialog or undo toast

### 4. Save button detached from form — Branding page

"Save All Settings" floats in the main footer bar, visually disconnected from the form card it applies to. Breaks the gestalt principle of proximity.

### 5. ColorWells with no visible labels — Dashboard layout editor

Each widget card shows 4 color pickers (`FONT`, `BG`, `INNER`, `GLASS`) as bare swatches with only a `<LabelText>` above. No preview swatch, no tooltip explaining what each controls.



## Moderate Issues

| Issue | Location | Detail |
|---|---|---|
| **No section dividers** | Dashboard settings | Editing panel for each widget is ~8 controls stacked — 10 widgets × 8 = 80 controls visible at once. No collapsible sections |
| **Combo trigger text overflow** | Entity Mappings | `"Grid Energy Out (export) (kWh)"` (34 chars) wraps/truncates in the combo trigger. Needs `text-overflow: ellipsis` |
| **Inconsistent "Active" UI** | Dashboard settings | One dashboard has `[Set Active]` button, another shows `[★ Active]` — same concept, two different patterns |
| **Form labels don't wrap gracefully** | Data Sources | Long metric labels in combo boxes cause layout jitter when expanded |
| **No placeholder text** | Branding, Data Sources | Empty inputs show nothing — no guidance for what to type |
| **Empty / loading states** | Dashboard forecast section | Shows "--" everywhere when HA is offline — could use skeleton loaders or an explicit "No data" message |
| **No onboarding / first-run help** | Help page | Would benefit from setup wizard or contextual tooltips for first-time users |
| **No form validation visible** | All settings | No inline error states, no "required field" indicators |

---

## Priority Recommendations

### 1. 🎯 Cardify the Data Sources page

Wrap each source type's config panel in a card with a header bar and collapsible body. Group fields into sections:

```
┌─ Home Assistant ─────────────────────────────────────────────┐
│ 📡 Connection                                                 │
│   Device Name    [________________]      [✔ Enabled]          │
│   URL            [________________]                           │
│   Access Token   [________________]                           │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│ ⏱ Polling                                                     │
│   Poll Interval  [10] seconds         [Fetch Entities]       │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│ 🔗 Entity Mappings                                            │
│   [🔍 Filter metrics...]                                      │
│   Metric ─────────────── Entity ────────────────              │
│   Battery Current (A)      sensor.batt_amps        [✕]      │
│   Battery Cycles (cycles)  sensor.jbd_ap21s001     [✕]      │
│   ...                                                         │
└──────────────────────────────────────────────────────────────┘
```

### 2. 🔍 Paginate / search Entity Mappings

- Add a filter input above the mapping list (the Metrics page already has one — reuse that component)
- Show 10 rows per page with pagination
- Or make the mapping rows virtualized

### 3. 🛡️ Add destructive-action confirmation

For every delete/remove action:
- **Minimum:** Change button color to `red` / danger
- **Better:** Show a confirmation dialog: `"Delete 'Battery Current'? This cannot be undone."`
- **Best:** Add an undo toast that auto-dismisses after 5 seconds

### 4. 📐 Move "Save" button into its card

Self-contained action inside the card footer:
```
┌─ Branding ────────────────────────────────────────────────────┐
│ Dashboard Title  [________________]                          │
│ Logo URL         [________________]                          │
│ Favicon URL      [________________]                          │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│                                            [💾 Save Settings] │
└──────────────────────────────────────────────────────────────┘
```

### 5. 📝 Add placeholder hints

| Field | Placeholder |
|---|---|
| Dashboard Title | `"My Solar Dashboard"` |
| Favicon URL | `"https://example.com/favicon.ico"` |
| Device Name | `"Home Assistant"` |
| Access Token | `"ha-xxxx…"` |

### 6. 🔤 Fix entity mapping combo display

```css
.entity-combo-trigger {
  max-width: 250px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Full name shows on open/hover via tooltip or `title` attribute.

### 7. 🧩 Unify "Active" UI

Pick one pattern:
- **Option A:** `[★ Active]` as a badge (read-only indicator)
- **Option B:** `[Set Active]` as a button (action)
- Use it consistently across all dashboard instances. Don't mix both.

### 8. 🎨 Align settings page visual language with dashboard

- Dashboard cards have rounded corners (~8-12px) and consistent elevation
- Apply the same card component to settings panels
- Unify border-radius, padding scale, and elevation tokens between dashboard + settings

---

## Effort Estimate

| # | Change | Effort | Impact |
|---|---|---|---|
| 1 | Cardify Data Sources | Medium | High |
| 2 | Paginate entity mappings | Medium | High |
| 3 | Destructive-action confirmation | Small | High |
| 4 | Move Save button | Small | Medium |
| 5 | Placeholder text | Small | Medium |
| 6 | Combo text ellipsis | Tiny | Medium |
| 7 | Unify Active UI | Tiny | Low |
| 8 | Align card language | Medium | Medium |

---

*Reviewed using: modern-web-design, web-design-expert, web-design-guidelines, web-design-engineer skills.*
