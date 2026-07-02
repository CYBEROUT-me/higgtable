# HiggTable Visual Redesign

## Context

HiggTable's dark theme has grown organically feature-by-feature — colors, radii, and spacing were chosen ad hoc per component. The user wants a redesign because the app now "looks too basic." Scoped via brainstorming to: overall visual polish, keeping the dark theme, styled closer to Notion/Airtable (warm, rounded, comfortable spacing, friendly but professional).

Two visual directions were validated with the user via mockups in the visual companion:
1. **Palette: "Warm Charcoal"** — a refined version of today's dark base (deeper blacks, softened teal-green accent, generous rounding, subtle shadows) over two colder/warmer alternatives (Slate & Amber, Navy & Coral).
2. **Dashboard structure: refined list** — same ranked-list-with-progress-bar shape as today (not a per-designer card grid), executed with better styling.

## Goals

- Introduce a consistent design token system (color/spacing/radius/shadow) in CSS, replacing hardcoded ad hoc values.
- Apply the Warm Charcoal palette across every surface: header/tabs, main table, dashboard, modals, rename panel, bulk actions bar, buttons/inputs.
- Wrap the main table and dashboard leaderboard in rounded "surface" panels instead of flush full-bleed content, for the boxed Airtable-grid feel.
- Unify all row-selection visual states (hover, rename-selected, bulk-selected, notification highlight-flash) around the new accent color at different intensities — today they use inconsistent, unrelated blues.
- Recolor primary buttons and active tabs to the new accent instead of the current unrelated blue (`#1e4d8c`).
- Increase corner radius and add real elevation shadows to modals (Settings, record detail, field-visibility settings).

## Non-goals

- No new bundled font — system font stack (`-apple-system, sans-serif`, extended with cross-platform fallbacks) stays.
- No icon replacement — emoji icons (⚙ 📊 ⟳ ×) stay as-is; this redesign is not about iconography.
- No behavior or feature changes of any kind. Every existing interaction (multi-select via Shift/Cmd-click, dashboard period filters, record editing, file renaming, notifications, auto-update, field visibility settings) must work identically after the redesign — only appearance changes.
- No changes to `main.js`, `preload.js`, or `airtable.js` — this is a `renderer/styles.css` change only (see Implementation note below — no new HTML structure needed either).

## Design tokens

New CSS custom properties on `:root` in `renderer/styles.css`:

```css
--bg-app: #151515;         /* window background */
--bg-surface: #1e1e1e;     /* panels: table wrapper, dashboard wrapper, rename panel */
--bg-surface-2: #212121;   /* nested surfaces: table rows, dashboard row cards */
--border: #2e2e2e;         /* default border */
--border-strong: #3a3a3a;  /* hover/focus border */
--text-primary: #ececec;
--text-secondary: #999;
--text-muted: #666;
--accent: #4fd6ad;         /* replaces old #4a9 / #44aa99 */
--accent-bg: rgba(79, 214, 173, 0.15);   /* status pill / selection tint backgrounds */
--accent-strong: #3fb894;  /* gradient end / hover state for accent elements */
--radius-sm: 6px;          /* buttons, inputs, small chips */
--radius-md: 10px;         /* table/dashboard row cards */
--radius-lg: 12px;         /* panels, modals */
--shadow-panel: 0 2px 8px rgba(0,0,0,0.3);
--shadow-modal: 0 8px 24px rgba(0,0,0,0.45);
--space-1: 4px;
--space-2: 6px;
--space-3: 8px;
--space-4: 12px;
--space-5: 16px;
--space-6: 20px;
--space-7: 24px;
```

These replace hardcoded values throughout the stylesheet. Existing component-specific classes (`.status-chip`, `.dash-preset`, `.record-chip`, etc.) get updated to reference tokens instead of their current inline hex values. `body` uses `--bg-app` as its background (the window's base color); every panel sitting on top of it (table, dashboard, modals, rename panel) uses `--bg-surface` or `--bg-surface-2`, so the app background shows through as a visible gap around each panel.

Implementation is CSS-only — no new wrapper `<div>`s are needed. "Wrapping in a surface panel" means applying background/border/radius/shadow/margin directly to the existing container elements (`#records-container`, `#dashboard-table-area`, `.modal-box`, `#rename-panel`), not introducing new DOM structure.

## Component changes

**Header & tabs** — `header` background moves to `--bg-surface`; increase padding using the new spacing scale. `.tab.active` becomes an accent-tinted pill (`background: var(--accent-bg); color: var(--accent); border-color: var(--accent)`) instead of solid `#1e4d8c`. `.status-chip.on` aligns to the same accent tokens (already close today, just tokenized).

**Main table** — `#records-container` gets wrapped visually as a surface panel: `background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-panel)`, with appropriate margin so it reads as a distinct card rather than filling the whole window edge-to-edge. Row states consolidated:
- `tr:hover td` → subtle `--bg-surface-2` tint (unchanged in spirit, tokenized)
- `tr.selected td` (rename target) → `var(--accent-bg)` with a left accent border for clear distinction
- `tr.bulk-selected td` → a lighter accent tint than `.selected`, so the two states are visually distinguishable when adjacent
- `tr.highlight-flash` → flash animation reuses `--accent` at higher opacity instead of the current unrelated blue (`rgba(74,153,255,0.45)`)

**Dashboard** — `#dashboard-container`'s table wrapped the same way as the main table (surface panel treatment). `.dash-bar-fill` becomes a gradient (`linear-gradient(90deg, var(--accent), var(--accent-strong))`) with fully rounded ends. `.dash-preset` buttons restyled to match `.status-chip`'s pill visual language (currently already similar, will tokenize and refine hover/active states). `.total-row` gets a top border in `--border-strong` plus a faint background tint to read as a summary row.

**Modals** (Settings, record detail, field-visibility settings) — `.modal-box` radius increases to `--radius-lg`, shadow changes from none to `--shadow-modal`, internal padding increases slightly for breathing room. Record modal's field-row divider color moves to `--border`. Inputs/selects/textareas inside modals get `--radius-sm` and `--border` tokens (currently hardcoded `#444`/`#1a1a1a`).

**Buttons** — `button.primary` recolors to `--accent` (from `#1e4d8c`); default `button` gets `--radius-sm` (from `4px`) and refined hover using `--bg-surface-2`.

**Rename panel & bulk actions bar** — Rename panel border-top and background tokenized. Bulk actions bar keeps a distinct, slightly more saturated accent treatment (not just the passive selection tint) so it still reads as "here's an action available," separate from row-selection state.

## Testing / Verification

This is a visual-only change with no logic modifications, so:
1. Re-run the existing Jest suite (`npm test`) — covers `airtable.js` only, unaffected by CSS, run for hygiene / regression safety net.
2. Manual visual verification via the CDP screenshot technique already used throughout this project: launch the app against an isolated `--user-data-dir`, screenshot each major view (main table in default/hover/rename-selected/bulk-selected/sort-active states, Dashboard across a couple of period presets, record detail modal, Settings modal, field-visibility modal, rename panel with pending files) and confirm against the design intent above.
3. Spot-check interactive behavior (clicking tabs, opening modals, multi-select, sorting) still functions identically — no regressions from the panel-wrapping DOM changes.
