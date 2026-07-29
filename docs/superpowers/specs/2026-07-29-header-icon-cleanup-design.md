# Header icon cleanup

## Problem

The header's icon-action group (`#header-actions`: Columns, mute, bell,
refresh, settings) mixes two visually incompatible icon styles:

- **Emoji** (🔊/🔇 on `#notify-mute-btn`, 🔔 on `#notify-bell-btn`) — full
  color, OS-rendered, size and appearance vary by platform, can't be
  recolored via CSS.
- **Plain unicode glyphs** (▤ on `#columns-btn`, ⟳ on `#refresh-btn`, ⚙ on
  `#settings-btn`) — monochrome, styled via `color: var(--text-muted)`,
  consistent across platforms.

Sitting side by side, the colorful emoji clash with the muted-gray glyphs —
this is what reads as "a mess." Additionally, icon buttons today only change
text color on hover (no background), giving weak click affordance, and the
"You:"/multi-select row below doesn't share a consistent rhythm with the
icon row above it.

## Goals

- Replace all six icon glyphs (▤, 🔊, 🔇, 🔔, ⟳, ⚙) with a single
  consistent custom icon set: inline SVG, stroke-based, monochrome via
  `currentColor`, same visual weight throughout.
- No new runtime dependency (no icon font, no icon library, no build step)
  — plain inline `<svg>` markup, consistent with this being a build-step-free
  Electron renderer.
- Icon buttons get a clear hover affordance (rounded background), unifying
  them into one cohesive toolbar-style group.
- The mute icon's on/off swap keeps working exactly as today (driven by the
  existing `.muted` class on `#notify-mute-btn`), just via CSS-toggled SVGs
  instead of `textContent` swaps.
- The "You:"/multi-select row picks up matching spacing so both header rows
  read as one toolbar.

## Non-goals

- Changing what any control does, its `id`, its `title` tooltip text, or its
  position in the two-row layout established in
  [[2026-07-29-header-two-row-layout-design]].
- Introducing an icon library/font or any build tooling.
- Touching the nav tabs (VCP/PLM/CMC/LB/Dashboard/Canvas) or status chips —
  their emoji (📊, 🕸) are informal/decorative there and not part of the
  reported clash.
- Changing notification badge/dropdown behavior — only `#notify-bell-btn`'s
  glyph changes, not `#notify-badge`/`#notify-dropdown` logic.

## Design

### Icon set

Six inline SVGs, `viewBox="0 0 16 16"`, `fill="none"`, `stroke="currentColor"`,
`stroke-width="1.5"`, `stroke-linecap="round"`, `stroke-linejoin="round"`,
rendered at 16×16 in markup (scales via the button's font-size-independent
fixed size, not `em`-based):

- **Columns** — three vertical rounded bars (replaces ▤ on `#columns-btn`).
- **Bell** — bell outline with a small clapper arc at the base (replaces 🔔
  on `#notify-bell-btn`).
- **Volume on** — speaker outline with two sound-wave arcs (replaces 🔊).
- **Volume off** — the same speaker outline with an X instead of the arcs
  (replaces 🔇).
- **Refresh** — a circular arrow (partial ring + arrowhead), reusing the
  same `@keyframes refresh-spin` rotation already defined in
  `renderer/styles.css`.
- **Settings** — a simplified gear: center circle plus radiating tick marks.

Volume on/off both live inside `#notify-mute-btn` at all times; CSS shows
exactly one based on the `.muted` class (mirrors how `#notify-badge` already
toggles via the `.hidden` class) — no JS icon-swapping needed.

### Button chrome

New shared style for the icon buttons (`#columns-btn`'s icon child,
`#notify-mute-btn`, `#notify-bell-btn`, `#refresh-btn`, `#settings-btn`):
fixed ~28×28px hit area, `border-radius: var(--radius-sm)`, transparent
background by default, `background: var(--bg-surface-2)` on `:hover`, with a
`background-color` transition. `#columns-btn` keeps its existing bordered
pill (it's a labeled action button, not a bare icon) — only its glyph swaps
from ▤ text to the new SVG, sized/aligned inline with the "Columns" label.

### Mute toggle (`renderer/app.js`)

No behavior change. Delete the two lines that set
`document.getElementById('notify-mute-btn').textContent = '🔇'` /
`'🔊'` (in `toggleMute()` and the cold-start mute-restore block) — the
`.muted` class they already toggle alongside is now solely responsible for
which SVG shows, via CSS.

### Row rhythm

`#header-filters-right`'s gap and `#des-control`'s spacing are tightened to
match `#header-actions`'s gap, so the two header rows share one visual
rhythm instead of feeling like separate elements.

## Testing

Manual only, same as the two-row layout work: load the app, confirm all six
icons render consistently (same size/color/weight), confirm hovering shows
the rounded background, confirm toggling mute swaps the speaker icon
correctly, confirm the bell/badge/dropdown still work, confirm nothing
regresses in `npm test`.
