# Two-row header layout

## Problem

The header (`renderer/index.html` / `renderer/styles.css`) packs everything
into a single flex row: 6 nav tabs (VCP/PLM/CMC/LB/📊 Dashboard/🕸 Canvas),
6 status filter chips (Backlog/Rework/Ready for Design/In work/To accept/Done),
the "You:" assignee dropdown, a multi-select hint, and 5 icon-ish action
controls (▤ Columns, 🔊 mute, 🔔 bell, ⟳ refresh, ⚙ settings). At full-screen
width on a large display this fits, but at any narrower window width the row
runs out of space. Flex-shrink then squeezes individual chips/tabs below
their natural content width, wrapping their text onto two lines (e.g. "Ready
for" / "Design") instead of the row simply wrapping as whole units — the bar
looks broken rather than compact.

## Goals

- Nothing in the header wraps its own label text onto multiple lines.
- The header fits comfortably in a half-width (non-fullscreen) window without
  looking cramped or broken.
- No existing functionality is hidden, collapsed into a menu, or removed —
  every tab, chip, control, and icon stays visible and directly clickable.

## Non-goals

- Changing what any control does, its icon, or its label text.
- Responsive breakpoints / icon-only collapsing at very narrow widths (out of
  scope for this pass — two rows should already resolve the reported issue).
- Touching the bulk-actions bar, table, or any panel below the header.

## Design

Split the single header row into two stacked rows (`header` becomes
`flex-direction: column`), grouped by purpose rather than by current DOM
order:

**Row 1 — navigation** (`#header-top`): `nav#tabs` (the 6 view tabs) on the
left; an icon-action group (`#header-actions`: ▤ Columns, the existing
`#notifications-control` [🔊 mute, 🔔 bell, dropdown], ⟳ refresh, ⚙ settings)
pushed right via `margin-left: auto`.

**Row 2 — filters** (`#header-filters`): `#status-filters` (the 6 status
chips) on the left; `#des-control` ("You:" + assignee `<select>`) and
`#multiselect-hint` grouped on the right via `margin-left: auto`.

Each row keeps `display:flex; align-items:center;` with a modest gap/padding
(reusing the existing `--space-*` tokens, tightened slightly — same intent as
the earlier padding/font-size pass, just now with two rows to spread across
instead of one). `.tab` and `.status-chip` get `white-space: nowrap` and
`flex-shrink: 0` so a genuinely too-narrow row wraps whole chips/tabs onto a
second line (via `flex-wrap: wrap` on the row) rather than compressing text
inside them.

### HTML restructuring

Inside `<header>`, wrap the existing elements into two new wrapper `<div>`s
(`#header-top`, `#header-filters`) instead of the current single
`#controls` div — no elements are added or removed, only regrouped:

```html
<header>
  <div id="header-top">
    <nav id="tabs">...</nav>              <!-- unchanged -->
    <div id="header-actions">
      <button id="columns-btn">...</button>
      <div id="notifications-control">...</div>   <!-- unchanged -->
      <button id="refresh-btn">...</button>
      <button id="settings-btn">...</button>
    </div>
  </div>
  <div id="header-filters">
    <div id="status-filters"></div>       <!-- unchanged, JS-populated -->
    <div id="header-filters-right">
      <div id="des-control">...</div>     <!-- unchanged -->
      <span id="multiselect-hint">...</span>
    </div>
  </div>
</header>
```

`renderer/app.js` references controls by their existing IDs
(`status-filters`, `des-select`, `columns-btn`, etc.) — none of those IDs
change, so no JS changes are needed.

### CSS changes

- `header`: `flex-direction: column`, keep `border-bottom`/background.
- `#header-top`, `#header-filters`: `display: flex; align-items: center;
  flex-wrap: wrap;` with a small gap and horizontal padding (vertical padding
  split across the two rows so total header height doesn't roughly double).
- `#header-actions`, `#header-filters-right`: `display: flex; align-items:
  center; gap; margin-left: auto;` (replaces the old single `#controls`
  right-alignment).
- `.tab`, `.status-chip`: add `white-space: nowrap; flex-shrink: 0;`.
- Remove the now-unused `#controls` selector; everything else
  (`.status-chip`, `#des-select`, icon buttons, etc.) keeps its existing
  rules, just re-parented.

## Testing

Manual only: load the app, resize the window to roughly half screen width,
confirm no tab/chip text wraps internally and both rows lay out cleanly; also
check full-screen width still looks correct (not overly spaced out).
