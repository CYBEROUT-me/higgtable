# Lineage Canvas — Design Spec

**Date:** 2026-07-09
**Status:** Approved, pending implementation

## Problem

Creatives in Airtable form chains of iteration: a `NEW` creative gets revised into `VAR`/`ITR`/`NOD` follow-ups, which themselves get revised again. This lineage is currently only visible by manually following the `Old ID` → `New ID` links field-by-field inside Airtable. There's no way to see a whole chain's shape (how many branches, how deep, what happened to each branch) at a glance.

`Old ID` semantics (per the field's own Airtable description): it holds the `New ID` of the existing creative a record continues/refines. For a truly original creative — no lineage at all — `Old ID` duplicates `New ID`, i.e. a root's Old ID equals its own New ID.

**Root detection is based only on comparing the `Old ID`/`New ID` field values — never on the `Type` field.** A record can be labeled `Type = NEW` while still having a real parent: `Type` describes the creative's category/workflow stage, not its lineage. A `NEW`-typed record only counts as a root when its Old ID equals its own New ID; if its Old ID points elsewhere, it's a real child of that other creative regardless of what Type says.

## Goals

- Visualize one creative's full lineage tree as a pannable/zoomable node canvas.
- Let a user browse all lineages in the active table and jump into one.
- Let a user jump straight from any task's detail view into its lineage.
- Reuse existing visual language (Status/Type pill colors, thumbnails, record modal) rather than inventing a parallel design system.

## Non-goals

- Editing records from the canvas (clicking a card opens the existing record modal for that).
- Cross-table lineages (Old ID/New ID linking is assumed table-scoped, matching how these fields are actually used).
- Rendering every lineage in a table simultaneously — tables can have thousands of records; one chain at a time keeps this fast and readable.
- Any new IPC/main-process work — this is pure renderer-side computation over records already in `state.records`, plus attachment URLs the app already has.

## Data model

Given the active table's `state.records`, build two lookups once per Canvas-tab visit:

- `byNewId: Map<string, record>` — keyed by each record's `New ID` field value.
- `childrenByOldId: Map<string, record[]>` — keyed by `Old ID`, listing every record pointing at that id.

A record is a **chain root** when (checked in this order, `Type` never consulted):
- its `Old ID` equals its own `New ID`, **or**
- its `Old ID` is blank/doesn't match any record's `New ID` (dangling reference — treated as its own root rather than dropped, since this is likely pre-existing data entered before Old ID was consistently filled in).

A **chain** is a root plus its full descendant tree, walked recursively via `childrenByOldId`. Chain grouping always includes every record regardless of the currently-active Status filter chips — the point of this view is full history, so filtering by status would fracture chains into disconnected pieces.

A chain of size 1 (root with no children found) still renders as a single card with no connectors — not an error case.

Both the descendant walk (root → children) and the root-finding walk (task → up to its root, used by "View lineage") track visited ids and stop rather than looping forever, guarding against malformed data creating a cycle (e.g. A's Old ID pointing to B, B's pointing back to A).

## Entry points

1. **New "🕸 Canvas" tab**, alongside the existing Dashboard tab in the header nav. Shows a list of all chains in the active table: root task name, chain size ("15 creatives"), root's Status. Sorted by size descending. Clicking a row renders that chain.
2. **"View lineage" button** in the record detail modal header (next to the existing ⚙ fields-settings and × close buttons). Walks up from that task to its root via `Old ID` (repeatedly looking up `byNewId` until a root is reached), switches to the Canvas tab, and renders that chain with the originating card highlighted and scrolled into view.

## Layout algorithm

A simple recursive layered-tree layout — columns = generation depth, rows = sibling order:

- The root sits at column 0. Each child is one column to the right of its parent (matches the reference screenshot's left-to-right generations).
- A leaf occupies one fixed card-slot height. A parent's vertical center is the midpoint of its children's combined vertical span; a subtree's total height is the sum of its children's subtree heights plus spacing between siblings.
- Computed once from the tree's shape alone (record count + branching), no DOM measurement or reflow — card dimensions are fixed by CSS, so positions are deterministic before anything is painted.

## Card design

Each card (~220×110px):
- **Thumbnail** (top-left, ~48×48px), from the record's `Preview` attachment URL if set, a placeholder icon otherwise.
- **Type badge** (VAR/NEW/ITR/NOD) — reuses the existing pill styling.
- **Status pill** (top-right) — reuses the exact `selectColors`/`airtableColorToCss` mechanism already built for the main table, so colors are consistent app-wide with zero duplicated color logic.
- **Task name**, truncated with ellipsis; full name via `title` tooltip.
- **Model ID / Format** line and **Network** tags in smaller muted text.

Clicking a card opens the existing record detail modal (`openRecordModal`) — no new modal for viewing/editing a task's fields; the canvas is a navigation/visualization layer on top of data that's edited the same way as everywhere else in the app.

## Interactions

- **Pan**: click-drag on empty canvas background, or two-finger trackpad scroll / mouse wheel, translates the view via a CSS `transform` on the canvas container.
- **Zoom**: pinch gesture on a trackpad, ctrl+scroll wheel, or the +/− buttons scales that same transform. Wheel-driven zoom is centered on the cursor position; the buttons zoom around the canvas origin.
- **Connectors**: a single SVG overlay behind the cards, one smooth curved `<path>` per parent→child edge, colored to match the child's Status pill color (subtle, not distracting).
- Entering via "View lineage" auto-scrolls/centers on the originating card and applies the existing `highlight-flash` CSS animation (already used for notification-driven navigation to a record) so it's easy to spot in a large chain.

## File structure

- New `renderer/canvas.js`, loaded via a `<script>` tag after `app.js` in `index.html`. No bundler exists in this project, so this follows the existing pattern: both files share one global scope, letting `canvas.js` call `state`, `openRecordModal`, `airtableColorToCss`, `stripAspectRatio`-style helpers, etc. directly without imports/exports.
- New functions (exact names may shift slightly during implementation, but responsibilities are fixed):
  - `buildChains(records)` — groups records into root→descendants trees. Pure function, no DOM — this is the one piece worth a real unit test.
  - `layoutChain(root)` — assigns `{x, y}` per node given the tree shape.
  - `renderCanvas(chain, highlightId?)` — draws cards + SVG connectors into the Canvas tab's container.
  - `showCanvasTab()` / `renderChainList()` — tab wiring and the browsable chain list.
  - `openLineageFor(record)` — walks up to the root and switches to the Canvas tab, used by the "View lineage" button.
- New CSS in `renderer/styles.css` for `.canvas-*` classes, following the existing design-token system (`--bg-surface`, `--accent`, `--radius-*`, etc.) — no new colors invented outside that system.

## Testing

This codebase's only existing test file (`tests/airtable.test.js`) covers the API module — there's no established UI-testing setup, and the layout/rendering pieces are inherently visual. Plan:

- Add a Jest test file for `buildChains()` alone: given fake records with various `New ID`/`Old ID` combinations, verify correct grouping into trees, the self-referencing-root case, the dangling-reference-treated-as-root case, and single-node chains. This is pure data logic with no DOM dependency, so it's genuinely worth automating.
- Verify layout and rendering live via the CDP screenshot technique used throughout this project's development (launch with `--remote-debugging-port`, drive via `Runtime.evaluate`, confirm visually via `Page.captureScreenshot`) rather than unit-testing pixel positions.
