# Clickable-open for URL-valued text fields

## Problem

The record detail modal's generic text-field fallback
(`buildFieldInput()`, `renderer/app.js:1192-1198` — used for
`singleLineText`, `url`, `email`, `phoneNumber`, and any other
unrecognized field type) renders a plain `<input type="text">` with no
way to open its value if it happens to be a link. This affects any field
whose content is a URL — `REF` (a plain field, not one of the three
already-pinned URL-ish fields) is the reported case, but the same gap
applies to `Creative Link`/`Figma/Canvas link`/`Preview` and any other
field, present or future.

## Goals

- Any text-type field whose *current value* starts with `http://` or
  `https://` gets a small "open externally" icon button next to its input
  — auto-detected by content, not by a hardcoded field-name list.
- The input itself stays exactly as it is today: a normal, directly
  editable text box, unaffected by whether the icon is shown.
- Opening applies the same Drive account-index rewriting the Description
  links already use (`rewriteDriveLink`), for consistency — a Drive REF
  link behaves the same whether it's in a Description or a plain field.
- Fields whose value isn't a URL render exactly as today — no wrapper, no
  icon, no layout change.

## Non-goals

- No live-updating of the icon while typing/pasting — it's computed from
  the value present when the field renders (i.e. when the record modal
  opens, or on the next re-render after a save). Typing a URL into a
  previously-blank field won't show the icon until the field re-renders.
- No change to which fields exist in `PINNED_GRID_FIELDS`/
  `PINNED_STACK_FIELDS` or how they're grouped — this only changes what a
  field's *value cell* renders, not the modal's layout/sectioning.
- No shared `.icon-btn` class extracted from the header's existing
  icon-button CSS — the new button gets its own small, standalone rule
  with the same visual properties, to avoid touching already-shipped
  header markup for an unrelated feature.

## Design

### Detection and markup (`renderer/app.js`, `buildFieldInput`'s fallback branch)

The existing fallback still creates the same `<input type="text">` with
its existing `onblur` save handler, unchanged. After creating it: if
`typeof val === 'string' && /^https?:\/\//i.test(val)`, wrap the input
together with a new icon `<button type="button" class="field-open-link-btn">`
in a flex container (`div.record-text-field-with-link`) and return that
wrapper instead of the bare input; otherwise return the input exactly as
today (no wrapper at all — zero change for non-URL fields). The wrapper
uses `display:flex;align-items:center;gap` with the input set to `flex:1`,
matching how `#working-dir-row` already lays out its input + button pair.

### Icon and click behavior

The button's icon is a new small inline SVG (external-link glyph: an open
square with an arrow breaking out of its top-right corner), 16×16,
stroke-based, matching the style already established for the header's
icon set (reusing the existing `.icon-svg` sizing class). Clicking it
calls `window.app.openExternal(rewriteDriveLink(inp.value, state.driveAccountIndex))`
— reading the input's *live* value (so it opens whatever's currently
typed, even before a blur/save has happened), reusing both
`rewriteDriveLink` (`renderer/drive-links.js`) and `openExternal`
(`preload.js`/`main.js`) exactly as already shipped for Description links.

### Styling

`.field-open-link-btn` gets its own small rule with the same visual
treatment as the header's icon buttons (28×28 hit area, transparent by
default, `var(--bg-surface-2)` rounded background on hover, `var(--text-muted)`
→ `var(--text-primary)` color) — duplicated rather than shared via a new
class on the header's existing buttons, per Non-goals.

## Testing

Manual only, consistent with how `buildFieldInput`/the record modal are
verified today (no existing test coverage for this DOM-rendering layer).
Verify: a field whose value is a Drive URL (like the reported `REF` case)
shows the icon and opens it (with account-index rewriting applied) without
disturbing the input's normal editability; a plain non-URL field (e.g.
`Name`) renders with no wrapper/icon, unchanged from today; editing a URL
field's value and clicking the icon before blurring opens the newly-typed
value, not the stale saved one.
