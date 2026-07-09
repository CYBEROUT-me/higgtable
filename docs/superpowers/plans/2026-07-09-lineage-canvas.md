# Lineage Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pannable/zoomable canvas that visualizes a creative's full lineage (its chain of `NEW` → `VAR`/`ITR`/`NOD` iterations), reachable from a browsable "Canvas" tab or a "View lineage" button on any task.

**Architecture:** Pure data logic (grouping records into trees via the `Old ID`/`New ID` convention, and laying out a tree's node positions) lives in a new dependency-free file that Jest can `require()` directly. DOM rendering, pan/zoom, and tab wiring live in a second new file that shares the existing app's global scope (no bundler, no imports — same pattern `app.js` already uses). No new npm dependency, no main-process/IPC changes.

**Tech Stack:** Vanilla JS, DOM, inline SVG for connectors, CSS transforms for pan/zoom. Jest for the one pure-logic test file (matching the existing `tests/airtable.test.js` pattern).

## Global Constraints

- Root detection compares only `Old ID`/`New ID` field values — the `Type` field is never consulted (a `Type = NEW` record can still have a real parent).
- Chain grouping always includes every record regardless of the active Status filter chips.
- No new IPC or main-process code — this is renderer-only, over data already in `state.records` plus existing `Preview` attachment URLs.
- Reuse existing patterns: `airtableColorToCss` for pill colors, `openRecordModal` for editing, the `highlight-flash` animation concept for drawing attention to a card, and the `showDashboard`/`hideDashboard` show/hide pattern for tab switching.
- Both new walks (root → descendants, and task → up to its root) must guard against cycles in malformed data and terminate rather than hang.

---

## File Structure

- **Create** `renderer/canvas-data.js` — pure functions only, no DOM: `isChainRoot`, `buildChains`, `layoutChain`, plus the layout constants. Guarded CommonJS export at the bottom so `tests/canvas-data.test.js` can `require()` it directly (mirrors how `airtable.js` is required by `tests/airtable.test.js` — this file must never reference `document`/`window` at the top level, or requiring it under Jest's Node environment will throw).
- **Create** `renderer/canvas.js` — DOM rendering, pan/zoom, tab wiring, and the "View lineage" entry point. Loaded after `app.js` and `canvas-data.js`, sharing their global scope (calls `state`, `openRecordModal`, `airtableColorToCss`, `singleSelectSwatch`, `hideDashboard`, `clearTaskSelection`, `updateBulkActionsBar`, `setStatus`, `currentDetailRecord`, `currentDetailTable`, `closeRecordModal` directly — no imports).
- **Modify** `renderer/app.js` — add a small reusable `singleSelectSwatch(tableName, fieldName, value)` helper next to `airtableColorToCss` (factors out logic the main table's `render()` already computes inline, so the canvas can reuse it instead of duplicating it); modify the `#tabs` click handler to route the new Canvas tab button and to hide/show the canvas view alongside the dashboard view.
- **Modify** `renderer/index.html` — add the "🕸 Canvas" tab button, the `#canvas-container` markup (chain list + tree view), a "View lineage" button in the record modal header, and the two new `<script>` tags.
- **Modify** `renderer/styles.css` — new `.canvas-*` rules using existing design tokens only.
- **Create** `tests/canvas-data.test.js` — Jest tests for `buildChains`/`layoutChain`/`isChainRoot`.

---

### Task 1: Chain-building data logic (`isChainRoot` + `buildChains`)

**Files:**
- Create: `renderer/canvas-data.js`
- Test: `tests/canvas-data.test.js`

**Interfaces:**
- Produces: `isChainRoot(record, byNewId): boolean`, `buildChains(records): Array<{record, children: Array<same shape>}>`. Both consumed by Task 2 (layout), Task 4 (rendering), and Task 6 ("View lineage").

- [ ] **Step 1: Write the failing tests**

Create `tests/canvas-data.test.js`:

```js
// tests/canvas-data.test.js
const { buildChains } = require('../renderer/canvas-data');

function rec(id, newId, oldId, extra = {}) {
  return { id, fields: { 'New ID': newId, 'Old ID': oldId, Name: id, ...extra } };
}

test('a self-referencing record (Old ID === New ID) is a root with no children', () => {
  const chains = buildChains([rec('rec1', '100', '100')]);
  expect(chains).toHaveLength(1);
  expect(chains[0].record.id).toBe('rec1');
  expect(chains[0].children).toEqual([]);
});

test('a child is nested under its parent via Old ID -> New ID', () => {
  const root = rec('root', '100', '100');
  const child = rec('child', '101', '100');
  const chains = buildChains([root, child]);
  expect(chains).toHaveLength(1);
  expect(chains[0].record.id).toBe('root');
  expect(chains[0].children).toHaveLength(1);
  expect(chains[0].children[0].record.id).toBe('child');
});

test('a record whose Old ID matches nothing is treated as its own root, not dropped', () => {
  const orphan = rec('orphan', '200', '999');
  const chains = buildChains([orphan]);
  expect(chains).toHaveLength(1);
  expect(chains[0].record.id).toBe('orphan');
});

test('a record with a blank Old ID is treated as a root', () => {
  const noParent = rec('noParent', '300', null);
  const chains = buildChains([noParent]);
  expect(chains).toHaveLength(1);
  expect(chains[0].record.id).toBe('noParent');
});

test('a NEW-typed record with a real parent is nested under it, not treated as a root', () => {
  const root = rec('root', '100', '100');
  const fakeNew = rec('fakeNew', '101', '100', { Type: 'NEW' });
  const chains = buildChains([root, fakeNew]);
  expect(chains).toHaveLength(1);
  expect(chains[0].children[0].record.id).toBe('fakeNew');
});

test('fan-out: one root with multiple direct children', () => {
  const root = rec('root', '100', '100');
  const kids = [rec('k1', '101', '100'), rec('k2', '102', '100'), rec('k3', '103', '100')];
  const chains = buildChains([root, ...kids]);
  expect(chains[0].children).toHaveLength(3);
});

test('multi-generation chain: grandchild nests under child, not root', () => {
  const root = rec('root', '100', '100');
  const child = rec('child', '101', '100');
  const grandchild = rec('grandchild', '102', '101');
  const chains = buildChains([root, child, grandchild]);
  expect(chains[0].children[0].record.id).toBe('child');
  expect(chains[0].children[0].children[0].record.id).toBe('grandchild');
});

test('a two-node cycle with no valid root anchors to nothing, and does not hang', () => {
  const a = rec('a', '1', '2');
  const b = rec('b', '2', '1');
  const chains = buildChains([a, b]);
  expect(chains).toEqual([]);
});

test('a duplicate New ID reappearing deeper in the same chain is excluded by the cycle guard', () => {
  const root = rec('root', '0', '0');
  const child = rec('child', '1', '0');
  const duplicateOfRoot = rec('dup', '0', '1');
  const chains = buildChains([root, child, duplicateOfRoot]);
  expect(chains).toHaveLength(1);
  expect(chains[0].children).toHaveLength(1);
  expect(chains[0].children[0].record.id).toBe('child');
  expect(chains[0].children[0].children).toEqual([]);
});

test('multiple independent chains in the same table stay separate', () => {
  const rootA = rec('rootA', '100', '100');
  const rootB = rec('rootB', '200', '200');
  const childA = rec('childA', '101', '100');
  const chains = buildChains([rootA, rootB, childA]);
  expect(chains).toHaveLength(2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/canvas-data.test.js`
Expected: FAIL — `Cannot find module '../renderer/canvas-data'`

- [ ] **Step 3: Implement `canvas-data.js`**

Create `renderer/canvas-data.js`:

```js
// renderer/canvas-data.js
// Pure data logic for the Lineage Canvas — no DOM references anywhere in
// this file, so it can be required directly by Jest as well as loaded via
// <script> in the renderer. See:
// docs/superpowers/specs/2026-07-09-lineage-canvas-design.md

// A record is a chain root when compared purely by Old ID/New ID values —
// the Type field is never consulted (a Type=NEW record can still have a
// real parent). `byNewId` maps every record's New ID (as a string) to
// that record, used to detect a dangling Old ID (points at nothing).
function isChainRoot(record, byNewId) {
  const newId = record.fields['New ID'];
  const oldId = record.fields['Old ID'];
  if (newId == null || newId === '') return true;
  if (oldId == null || oldId === '') return true;
  if (String(oldId) === String(newId)) return true;
  if (!byNewId.has(String(oldId))) return true;
  return false;
}

// Groups `records` into root -> descendants trees using the Old ID / New ID
// linking convention. Returns an array of tree roots, each shaped
// { record, children: [ ...same shape... ] }.
function buildChains(records) {
  const byNewId = new Map();
  records.forEach(r => {
    const newId = r.fields['New ID'];
    if (newId != null && newId !== '') byNewId.set(String(newId), r);
  });

  const childrenByOldId = new Map();
  records.forEach(r => {
    const oldId = r.fields['Old ID'];
    if (oldId == null || oldId === '') return;
    const key = String(oldId);
    if (!childrenByOldId.has(key)) childrenByOldId.set(key, []);
    childrenByOldId.get(key).push(r);
  });

  function keyOf(record) {
    const newId = record.fields['New ID'];
    return newId == null || newId === '' ? null : String(newId);
  }

  // `path` is the set of New IDs from the root down to (and including) the
  // current node — used to drop a child whose own New ID already appears
  // as one of its own ancestors, so malformed cyclic data can't recurse
  // forever.
  function buildNode(record, path) {
    const key = keyOf(record);
    const nextPath = key == null ? path : new Set(path).add(key);
    const kids = key == null ? [] : (childrenByOldId.get(key) || []);
    const children = kids
      .filter(child => child.id !== record.id)
      .filter(child => {
        const childKey = keyOf(child);
        return childKey == null || !nextPath.has(childKey);
      })
      .map(child => buildNode(child, nextPath));
    return { record, children };
  }

  return records
    .filter(r => isChainRoot(r, byNewId))
    .map(root => buildNode(root, new Set()));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isChainRoot, buildChains };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/canvas-data.test.js`
Expected: PASS — all 10 tests green

- [ ] **Step 5: Commit**

```bash
git add renderer/canvas-data.js tests/canvas-data.test.js
git commit -m "Add chain-building data logic for lineage canvas"
```

---

### Task 2: Tree layout algorithm (`layoutChain`)

**Files:**
- Modify: `renderer/canvas-data.js`
- Test: `tests/canvas-data.test.js`

**Interfaces:**
- Consumes: the tree shape produced by `buildChains` (Task 1) — `{record, children}`.
- Produces: `layoutChain(root): Array<{node, x, y}>` (one flat entry per tree node, `node` being the exact same `{record, children}` object reference so callers can build a `Map` from node → position); exported constants `CANVAS_CARD_WIDTH`, `CANVAS_CARD_HEIGHT`, `CANVAS_COL_GAP`, `CANVAS_ROW_GAP`. Consumed by Task 4 (rendering) and Task 4's edge-drawing code.

- [ ] **Step 1: Write the failing tests**

Add to `tests/canvas-data.test.js` (append, keep the existing `require` line but add the new names to it):

```js
const { buildChains, layoutChain, CANVAS_CARD_HEIGHT } = require('../renderer/canvas-data');
```

Replace the top `require` line with the one above, then append these tests to the end of the file:

```js
test('layoutChain positions every node exactly once, children strictly right of their parent', () => {
  const root = rec('root', '0', '0');
  const child = rec('child', '1', '0');
  const chains = buildChains([root, child]);
  const positions = layoutChain(chains[0]);
  expect(positions).toHaveLength(2);
  const rootPos = positions.find(p => p.node.record.id === 'root');
  const childPos = positions.find(p => p.node.record.id === 'child');
  expect(childPos.x).toBeGreaterThan(rootPos.x);
});

test('layoutChain vertically centers a parent between two children', () => {
  const root = rec('root', '0', '0');
  const kidA = rec('a', '1', '0');
  const kidB = rec('b', '2', '0');
  const chains = buildChains([root, kidA, kidB]);
  const positions = layoutChain(chains[0]);
  const rootPos = positions.find(p => p.node.record.id === 'root');
  const aPos = positions.find(p => p.node.record.id === 'a');
  const bPos = positions.find(p => p.node.record.id === 'b');
  const half = CANVAS_CARD_HEIGHT / 2;
  const rootCenter = rootPos.y + half;
  const expectedCenter = ((aPos.y + half) + (bPos.y + half)) / 2;
  expect(rootCenter).toBeCloseTo(expectedCenter, 5);
});

test('layoutChain on a single-node chain (no children) still returns one position', () => {
  const chains = buildChains([rec('solo', '5', '5')]);
  const positions = layoutChain(chains[0]);
  expect(positions).toHaveLength(1);
  expect(positions[0].x).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/canvas-data.test.js`
Expected: FAIL — `layoutChain is not a function` (and `CANVAS_CARD_HEIGHT` is `undefined`)

- [ ] **Step 3: Implement `layoutChain`**

In `renderer/canvas-data.js`, add these constants near the top (after the file's opening comment) and the function + updated export block at the end:

```js
const CANVAS_CARD_WIDTH = 220;
const CANVAS_CARD_HEIGHT = 110;
const CANVAS_COL_GAP = 80;
const CANVAS_ROW_GAP = 24;
```

```js
// Assigns {x, y} (top-left, px) to every node in a tree returned by
// buildChains() — left-to-right by generation (x), siblings stacked
// top-to-bottom (y), parent vertically centered on its children's span.
// Pure function: computed from the tree's shape alone, no DOM involved.
function layoutChain(root) {
  const positions = [];

  function subtreeHeight(node) {
    if (!node.children.length) return CANVAS_CARD_HEIGHT;
    const total = node.children.reduce((sum, child) => sum + subtreeHeight(child), 0);
    return total + CANVAS_ROW_GAP * (node.children.length - 1);
  }

  // Returns the vertical center (px) of the node it just placed, so the
  // caller (its parent) can average its children's centers.
  function place(node, depth, top) {
    const x = depth * (CANVAS_CARD_WIDTH + CANVAS_COL_GAP);

    if (!node.children.length) {
      positions.push({ node, x, y: top });
      return top + CANVAS_CARD_HEIGHT / 2;
    }

    let childTop = top;
    const childCenters = node.children.map(child => {
      const center = place(child, depth + 1, childTop);
      childTop += subtreeHeight(child) + CANVAS_ROW_GAP;
      return center;
    });

    const y = (childCenters[0] + childCenters[childCenters.length - 1]) / 2 - CANVAS_CARD_HEIGHT / 2;
    positions.push({ node, x, y });
    return y + CANVAS_CARD_HEIGHT / 2;
  }

  place(root, 0, 0);
  return positions;
}
```

Update the export block to:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isChainRoot, buildChains, layoutChain,
    CANVAS_CARD_WIDTH, CANVAS_CARD_HEIGHT, CANVAS_COL_GAP, CANVAS_ROW_GAP,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/canvas-data.test.js`
Expected: PASS — all 13 tests green

- [ ] **Step 5: Commit**

```bash
git add renderer/canvas-data.js tests/canvas-data.test.js
git commit -m "Add tree layout algorithm for lineage canvas"
```

---

### Task 3: HTML/CSS scaffolding and tab wiring (no rendering yet)

**Files:**
- Modify: `renderer/index.html`
- Modify: `renderer/app.js:1612-1623` (the `#tabs` click handler) and near `airtableColorToCss` (add `singleSelectSwatch`)
- Create: `renderer/canvas.js` (just the show/hide + chain-list scaffolding for now — rendering comes in Task 4)
- Modify: `renderer/styles.css`

**Interfaces:**
- Produces: `showCanvasTab()`, `hideCanvasTab()`, `singleSelectSwatch(tableName, fieldName, value): {bg, text} | null` (in `app.js`). Consumed by Task 4, 5, 6.
- Consumes: `state`, `clearTaskSelection()`, `updateBulkActionsBar()`, `setStatus(msg)`, `hideDashboard()` (all pre-existing in `app.js`).

- [ ] **Step 1: Add the Canvas tab button and canvas markup to `index.html`**

In `renderer/index.html`, find this block:

```html
    <nav id="tabs">
      <button class="tab active" data-table="VCP Creatives">VCP</button>
      <button class="tab" data-table="PLM Creatives">PLM</button>
      <button class="tab" data-table="CMC Creatives">CMC</button>
      <button class="tab" data-table="LB Creatives">LB</button>
      <button id="dashboard-btn" class="tab" title="Task completion dashboard">📊 Dashboard</button>
    </nav>
```

Replace it with:

```html
    <nav id="tabs">
      <button class="tab active" data-table="VCP Creatives">VCP</button>
      <button class="tab" data-table="PLM Creatives">PLM</button>
      <button class="tab" data-table="CMC Creatives">CMC</button>
      <button class="tab" data-table="LB Creatives">LB</button>
      <button id="dashboard-btn" class="tab" title="Task completion dashboard">📊 Dashboard</button>
      <button id="canvas-btn" class="tab" title="Lineage canvas — see how creatives branch from one another">🕸 Canvas</button>
    </nav>
```

Find this block (right after `#dashboard-container`'s closing `</div>`):

```html
  <div id="rename-panel" class="hidden">
```

Insert this new block immediately before it:

```html
  <div id="canvas-container" class="hidden">
    <div id="canvas-list-view">
      <p class="dash-controls-label">Lineages in this table</p>
      <div id="canvas-chain-list"></div>
    </div>
    <div id="canvas-tree-view" class="hidden">
      <div id="canvas-tree-header">
        <button id="canvas-back-btn" title="Back to lineage list">← Back</button>
        <span id="canvas-tree-title"></span>
        <button id="canvas-zoom-out-btn" title="Zoom out">−</button>
        <button id="canvas-zoom-in-btn" title="Zoom in">+</button>
      </div>
      <div id="canvas-viewport">
        <div id="canvas-content">
          <svg id="canvas-edges"></svg>
          <div id="canvas-cards"></div>
        </div>
      </div>
    </div>
  </div>

  <div id="rename-panel" class="hidden">
```

Find the record modal header:

```html
      <div class="record-modal-header">
        <h2 id="record-modal-title">Task details</h2>
        <button id="record-fields-settings-btn" title="Choose which fields to show">⚙</button>
        <button id="record-modal-close" title="Close">×</button>
      </div>
```

Replace it with:

```html
      <div class="record-modal-header">
        <h2 id="record-modal-title">Task details</h2>
        <button id="view-lineage-btn" title="See this task's full lineage">🕸 View lineage</button>
        <button id="record-fields-settings-btn" title="Choose which fields to show">⚙</button>
        <button id="record-modal-close" title="Close">×</button>
      </div>
```

Find the closing script tag:

```html
  <script src="app.js"></script>
</body>
```

Replace it with:

```html
  <script src="app.js"></script>
  <script src="canvas-data.js"></script>
  <script src="canvas.js"></script>
</body>
```

- [ ] **Step 2: Add `singleSelectSwatch` to `app.js`**

In `renderer/app.js`, find the `airtableColorToCss` function (it ends with `return { bg: ..., text: ... };` followed by a closing `}`). Immediately after that closing `}`, add:

```js

// Looks up the Airtable choice color for a single-select field's current
// value — factors out what render()'s selectColors computation already
// does inline, so the lineage canvas can reuse the exact same colors
// without duplicating the lookup.
function singleSelectSwatch(tableName, fieldName, value) {
  if (!value) return null;
  const field = (state.tables[tableName]?.fields || []).find(f => f.name === fieldName);
  const choice = field?.options?.choices?.find(c => c.name === value);
  return choice ? airtableColorToCss(choice.color) : null;
}
```

- [ ] **Step 3: Update the `#tabs` click handler in `app.js`**

Find this block (around line 1612):

```js
document.getElementById('tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  if (btn.id === 'dashboard-btn') {
    showDashboard();
  } else {
    hideDashboard();
    loadTable(btn.dataset.table);
  }
});
```

Replace it with:

```js
document.getElementById('tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  if (btn.id === 'dashboard-btn') {
    hideCanvasTab();
    showDashboard();
  } else if (btn.id === 'canvas-btn') {
    hideDashboard();
    showCanvasTab();
  } else {
    hideDashboard();
    hideCanvasTab();
    loadTable(btn.dataset.table);
  }
});
```

- [ ] **Step 4: Create `renderer/canvas.js` with just the show/hide + empty chain list**

Create `renderer/canvas.js`:

```js
// renderer/canvas.js
// DOM rendering, pan/zoom, and tab wiring for the Lineage Canvas. Loaded
// after app.js and canvas-data.js, sharing their global scope (no
// bundler in this project — same pattern app.js itself uses). See:
// docs/superpowers/specs/2026-07-09-lineage-canvas-design.md

function showCanvasTab() {
  clearTaskSelection();
  state.selectedIds.clear();
  updateBulkActionsBar();
  document.getElementById('records-container').classList.add('hidden');
  document.getElementById('status-filters').classList.add('hidden');
  document.getElementById('des-control').classList.add('hidden');
  document.getElementById('multiselect-hint').classList.add('hidden');
  document.getElementById('columns-btn').classList.add('hidden');
  document.getElementById('refresh-btn').classList.add('hidden');
  document.getElementById('canvas-container').classList.remove('hidden');
  setStatus('Canvas: lineage view');
  renderChainList();
}

function hideCanvasTab() {
  document.getElementById('canvas-container').classList.add('hidden');
  document.getElementById('records-container').classList.remove('hidden');
  document.getElementById('status-filters').classList.remove('hidden');
  document.getElementById('des-control').classList.remove('hidden');
  document.getElementById('multiselect-hint').classList.remove('hidden');
  document.getElementById('columns-btn').classList.remove('hidden');
  document.getElementById('refresh-btn').classList.remove('hidden');
}

function countChainNodes(node) {
  return 1 + node.children.reduce((sum, child) => sum + countChainNodes(child), 0);
}

// Renders the browsable list of every lineage in the active table,
// biggest first. Rendering (Task 4) fills in what clicking a row does.
function renderChainList() {
  document.getElementById('canvas-tree-view').classList.add('hidden');
  document.getElementById('canvas-list-view').classList.remove('hidden');

  const container = document.getElementById('canvas-chain-list');
  container.innerHTML = '';

  const chains = buildChains(state.records)
    .map(root => ({ root, size: countChainNodes(root) }))
    .sort((a, b) => b.size - a.size);

  if (!chains.length) {
    container.innerHTML = '<p class="empty">No records to build lineages from.</p>';
    return;
  }

  chains.forEach(({ root, size }) => {
    const row = document.createElement('div');
    row.className = 'canvas-chain-row';
    const name = document.createElement('span');
    name.className = 'canvas-chain-name';
    name.textContent = root.record.fields['Name'] || '(untitled)';
    const count = document.createElement('span');
    count.className = 'canvas-chain-count';
    count.textContent = size === 1 ? '1 creative' : `${size} creatives`;
    row.appendChild(name);
    row.appendChild(count);
    container.appendChild(row);
  });
}

document.getElementById('canvas-back-btn').addEventListener('click', renderChainList);
```

- [ ] **Step 5: Add CSS for the new elements to `renderer/styles.css`**

Append to `renderer/styles.css`:

```css
/* ── Lineage Canvas ──────────────────────────────────────────────────── */
#canvas-container { flex: 1; overflow: hidden; min-height: 0; display: flex; flex-direction: column; margin: var(--space-4); background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-panel); }
#canvas-container.hidden { display: none; }

#canvas-list-view { flex: 1; overflow: auto; padding: var(--space-6) var(--space-7); }
#canvas-list-view.hidden { display: none; }
#canvas-chain-list { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-4); }
.canvas-chain-row { display: flex; justify-content: space-between; align-items: center; padding: var(--space-3) var(--space-4); background: var(--bg-surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
.canvas-chain-row:hover { border-color: var(--accent); }
.canvas-chain-name { color: var(--text-primary); font-size: 12px; }
.canvas-chain-count { color: var(--text-muted); font-size: 11px; }

#canvas-tree-view { flex: 1; display: flex; flex-direction: column; min-height: 0; }
#canvas-tree-view.hidden { display: none; }
#canvas-tree-header { display: flex; align-items: center; gap: var(--space-4); padding: var(--space-3) var(--space-5); border-bottom: 1px solid var(--border); flex-shrink: 0; }
#canvas-tree-title { flex: 1; color: var(--text-primary); font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

#canvas-viewport { flex: 1; overflow: hidden; position: relative; cursor: grab; background: var(--bg-app); min-height: 0; }
#canvas-viewport:active { cursor: grabbing; }
#canvas-content { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
#canvas-edges { position: absolute; top: 0; left: 0; pointer-events: none; overflow: visible; }
.canvas-edge { fill: none; stroke-width: 2; stroke: var(--border-strong); opacity: 0.7; }

#canvas-cards { position: absolute; top: 0; left: 0; }
.canvas-card {
  position: absolute; width: 220px; height: 110px; background: var(--bg-surface); border: 1px solid var(--border-strong);
  border-radius: var(--radius-md); box-shadow: var(--shadow-panel); padding: var(--space-3); cursor: pointer;
  display: flex; gap: var(--space-3); overflow: hidden;
}
.canvas-card:hover { border-color: var(--accent); }
.canvas-card.highlight-flash { animation: canvas-card-flash 1.4s ease-out 2; }
@keyframes canvas-card-flash { 0% { background: rgba(79, 214, 173, 0.45); } 100% { background: var(--bg-surface); } }

.canvas-card-thumb { width: 48px; height: 48px; object-fit: cover; border-radius: var(--radius-sm); background: var(--bg-app); border: 1px solid var(--border); flex-shrink: 0; }
.canvas-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.canvas-card-top { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); }
.canvas-card-type { font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); }
.canvas-card-name { font-size: 11px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.canvas-card-meta, .canvas-card-network { font-size: 10px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

- [ ] **Step 6: Verify with `node --check` and a live screenshot**

Run: `node --check renderer/app.js && node --check renderer/canvas.js && node --check renderer/canvas-data.js`
Expected: no output, exit code 0 (all three files parse)

Then launch the app with remote debugging (same technique used throughout this project's development) and verify live:

```bash
nohup ./node_modules/.bin/electron . --user-data-dir=/tmp/higgtable-cdp-profile --remote-debugging-port=9333 > /tmp/higgtable-cdp.log 2>&1 &
```

Wait a few seconds, then drive it via `Runtime.evaluate` (see any earlier CDP script in this project's scratchpad for the exact WebSocket harness) to: click the "🕸 Canvas" tab button, confirm `#canvas-container` loses `.hidden` and `#records-container` gains it, confirm `#canvas-chain-list` has one `.canvas-chain-row` per lineage with a name and count, click a VCP/CMC tab afterward and confirm `#canvas-container` gets `.hidden` back. Take a `Page.captureScreenshot` to confirm it visually resembles a plain list (no tree rendering yet — that's Task 4).

- [ ] **Step 7: Commit**

```bash
git add renderer/index.html renderer/app.js renderer/canvas.js renderer/styles.css
git commit -m "Add Canvas tab scaffolding: chain list, tab wiring, styles"
```

---

### Task 4: Rendering a chain's tree (cards + connectors)

**Files:**
- Modify: `renderer/canvas.js`

**Interfaces:**
- Consumes: `layoutChain(root)` and `CANVAS_CARD_WIDTH`/`CANVAS_CARD_HEIGHT` (Task 2), `singleSelectSwatch` (Task 3), `openRecordModal(rec, tableName)` (pre-existing in `app.js`).
- Produces: `openChain(root, highlightRecordId?)`, `renderCanvas(root, highlightRecordId?)`, `collectEdges(root)`, `buildCanvasCard(record, x, y)`. Consumed by Task 5 (pan/zoom needs `renderCanvasTransform`, added there) and Task 6 ("View lineage" calls `openChain`).

- [ ] **Step 1: Add rendering functions to `canvas.js`**

In `renderer/canvas.js`, add this at the end of the file (after `renderChainList` and its listener, before nothing — this is the new bottom of the file for now):

```js
// ── Tree rendering ──────────────────────────────────────────────────────

function collectEdges(root) {
  const edges = [];
  (function walk(node) {
    node.children.forEach(child => {
      edges.push({ parent: node, child });
      walk(child);
    });
  })(root);
  return edges;
}

function buildCanvasCard(record, x, y) {
  const card = document.createElement('div');
  card.className = 'canvas-card';
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.title = record.fields['Name'] || '';
  card.onclick = () => openRecordModal(record, state.activeTable);

  const thumb = document.createElement('img');
  thumb.className = 'canvas-card-thumb';
  const previewUrl = record.fields['Preview']?.[0]?.url;
  if (previewUrl) thumb.src = previewUrl;
  card.appendChild(thumb);

  const body = document.createElement('div');
  body.className = 'canvas-card-body';

  const top = document.createElement('div');
  top.className = 'canvas-card-top';
  const typeBadge = document.createElement('span');
  typeBadge.className = 'canvas-card-type';
  typeBadge.textContent = record.fields['Type'] || '';
  top.appendChild(typeBadge);
  const statusVal = record.fields['Status'];
  if (statusVal) {
    const statusPill = document.createElement('span');
    statusPill.className = 'select-pill';
    statusPill.textContent = statusVal;
    const swatch = singleSelectSwatch(state.activeTable, 'Status', statusVal);
    if (swatch) { statusPill.style.background = swatch.bg; statusPill.style.color = swatch.text; }
    top.appendChild(statusPill);
  }
  body.appendChild(top);

  const name = document.createElement('div');
  name.className = 'canvas-card-name';
  name.textContent = record.fields['Name'] || '(untitled)';
  body.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'canvas-card-meta';
  meta.textContent = [record.fields['Model ID'], record.fields['Format']].filter(Boolean).join(' · ');
  body.appendChild(meta);

  const network = document.createElement('div');
  network.className = 'canvas-card-network';
  const nets = record.fields['Network'];
  network.textContent = Array.isArray(nets) ? nets.join(', ') : (nets || '');
  body.appendChild(network);

  card.appendChild(body);
  return card;
}

function renderCanvas(root, highlightRecordId) {
  const positions = layoutChain(root);
  const edges = collectEdges(root);
  const posByNode = new Map(positions.map(p => [p.node, p]));

  const maxX = Math.max(...positions.map(p => p.x)) + CANVAS_CARD_WIDTH;
  const maxY = Math.max(...positions.map(p => p.y)) + CANVAS_CARD_HEIGHT;

  const content = document.getElementById('canvas-content');
  content.style.width = `${maxX}px`;
  content.style.height = `${maxY}px`;

  const cardsLayer = document.getElementById('canvas-cards');
  cardsLayer.innerHTML = '';
  let highlightEl = null;
  positions.forEach(({ node, x, y }) => {
    const card = buildCanvasCard(node.record, x, y);
    if (highlightRecordId && node.record.id === highlightRecordId) {
      card.classList.add('highlight-flash');
      highlightEl = card;
    }
    cardsLayer.appendChild(card);
  });

  const svg = document.getElementById('canvas-edges');
  svg.setAttribute('width', String(maxX));
  svg.setAttribute('height', String(maxY));
  svg.innerHTML = '';
  edges.forEach(({ parent, child }) => {
    const p1 = posByNode.get(parent);
    const p2 = posByNode.get(child);
    const x1 = p1.x + CANVAS_CARD_WIDTH;
    const y1 = p1.y + CANVAS_CARD_HEIGHT / 2;
    const x2 = p2.x;
    const y2 = p2.y + CANVAS_CARD_HEIGHT / 2;
    const midX = (x1 + x2) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', 'canvas-edge');
    const swatch = singleSelectSwatch(state.activeTable, 'Status', child.record.fields['Status']);
    if (swatch) path.setAttribute('stroke', swatch.bg);
    svg.appendChild(path);
  });

  if (highlightEl) {
    highlightEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }
}

function openChain(root, highlightRecordId) {
  document.getElementById('canvas-list-view').classList.add('hidden');
  document.getElementById('canvas-tree-view').classList.remove('hidden');
  document.getElementById('canvas-tree-title').textContent = root.record.fields['Name'] || '(untitled)';
  renderCanvas(root, highlightRecordId);
}
```

- [ ] **Step 2: Wire chain-list rows to open a chain**

In `renderer/canvas.js`, find (from Task 3):

```js
    row.appendChild(name);
    row.appendChild(count);
    container.appendChild(row);
```

Replace with:

```js
    row.appendChild(name);
    row.appendChild(count);
    row.onclick = () => openChain(root);
    container.appendChild(row);
```

- [ ] **Step 3: Verify with `node --check` and live against real data**

Run: `node --check renderer/canvas.js`
Expected: no output, exit code 0

Launch with remote debugging as in Task 3 Step 6, click the Canvas tab, click a chain row with more than one record, and verify via `Runtime.evaluate` that `document.querySelectorAll('.canvas-card').length` matches the chain's reported size, and that `document.querySelectorAll('#canvas-edges path').length` equals that size minus 1 (one edge per non-root node). Take a `Page.captureScreenshot` and visually confirm cards are laid out left-to-right by generation with curved connectors, thumbnails show where a `Preview` attachment exists, and clicking a card opens the existing record modal (`document.getElementById('record-modal').classList.contains('hidden')` should become `false` after a simulated click).

- [ ] **Step 4: Commit**

```bash
git add renderer/canvas.js
git commit -m "Render lineage chains as cards with SVG connectors"
```

---

### Task 5: Pan and zoom

**Files:**
- Modify: `renderer/canvas.js`

**Interfaces:**
- Produces: `renderCanvasTransform()`. Consumed by Task 4's `openChain` (reset pan/zoom on opening a new chain) and Task 6.

- [ ] **Step 1: Add pan/zoom state and handlers to `canvas.js`**

In `renderer/canvas.js`, add near the top of the file (after the opening comment, before `showCanvasTab`):

```js
let canvasZoom = 1;
let canvasPanX = 0;
let canvasPanY = 0;
let canvasIsDragging = false;
let canvasDragStartX = 0;
let canvasDragStartY = 0;

function renderCanvasTransform() {
  const content = document.getElementById('canvas-content');
  content.style.transform = `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasZoom})`;
}

document.getElementById('canvas-viewport').addEventListener('mousedown', e => {
  if (e.target.closest('.canvas-card')) return;
  canvasIsDragging = true;
  canvasDragStartX = e.clientX - canvasPanX;
  canvasDragStartY = e.clientY - canvasPanY;
});
document.addEventListener('mousemove', e => {
  if (!canvasIsDragging) return;
  canvasPanX = e.clientX - canvasDragStartX;
  canvasPanY = e.clientY - canvasDragStartY;
  renderCanvasTransform();
});
document.addEventListener('mouseup', () => { canvasIsDragging = false; });

document.getElementById('canvas-viewport').addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.1 : 0.1;
  canvasZoom = Math.min(2, Math.max(0.3, canvasZoom + delta));
  renderCanvasTransform();
}, { passive: false });

document.getElementById('canvas-zoom-in-btn').addEventListener('click', () => {
  canvasZoom = Math.min(2, canvasZoom + 0.2);
  renderCanvasTransform();
});
document.getElementById('canvas-zoom-out-btn').addEventListener('click', () => {
  canvasZoom = Math.max(0.3, canvasZoom - 0.2);
  renderCanvasTransform();
});
```

- [ ] **Step 2: Reset pan/zoom whenever a chain is (re-)opened**

In `renderer/canvas.js`, find (from Task 4):

```js
function openChain(root, highlightRecordId) {
  document.getElementById('canvas-list-view').classList.add('hidden');
  document.getElementById('canvas-tree-view').classList.remove('hidden');
  document.getElementById('canvas-tree-title').textContent = root.record.fields['Name'] || '(untitled)';
  renderCanvas(root, highlightRecordId);
}
```

Replace with:

```js
function openChain(root, highlightRecordId) {
  document.getElementById('canvas-list-view').classList.add('hidden');
  document.getElementById('canvas-tree-view').classList.remove('hidden');
  document.getElementById('canvas-tree-title').textContent = root.record.fields['Name'] || '(untitled)';
  canvasZoom = 1;
  canvasPanX = 0;
  canvasPanY = 0;
  renderCanvasTransform();
  renderCanvas(root, highlightRecordId);
}
```

- [ ] **Step 3: Verify with `node --check` and live drag/zoom simulation**

Run: `node --check renderer/canvas.js`
Expected: no output, exit code 0

Launch with remote debugging, open a chain, then via `Runtime.evaluate` dispatch a `mousedown` on `#canvas-viewport`, a `mousemove` on `document` with different `clientX`/`clientY`, and a `mouseup`; confirm `document.getElementById('canvas-content').style.transform` changed to reflect the drag distance. Separately dispatch a `wheel` event and confirm the `scale(...)` portion of the transform changed within the `[0.3, 2]` clamp. Click the zoom +/− buttons and confirm the same.

- [ ] **Step 4: Commit**

```bash
git add renderer/canvas.js
git commit -m "Add pan and zoom to the lineage canvas"
```

---

### Task 6: "View lineage" entry point from the task detail modal

**Files:**
- Modify: `renderer/canvas.js`

**Interfaces:**
- Consumes: `isChainRoot` (Task 1), `buildChains` (Task 1), `openChain` (Task 4), `hideDashboard()`, `closeRecordModal()`, `currentDetailRecord`, `currentDetailTable` (all pre-existing in `app.js`).
- Produces: `findRoot(record, byNewId)`, `openLineageFor(record)`.

- [ ] **Step 1: Add the root-finding walk and entry point to `canvas.js`**

In `renderer/canvas.js`, add at the end of the file:

```js
// ── "View lineage" entry point ──────────────────────────────────────────

// Walks from `record` up through Old ID -> New ID until isChainRoot()
// says to stop (self-referencing, blank Old ID, or a dangling reference).
// Guards against a malformed cycle the same way buildChains does: if a
// New ID we've already visited on this walk reappears, stop there instead
// of looping forever.
function findRoot(record, byNewId) {
  const visited = new Set();
  let current = record;
  while (!isChainRoot(current, byNewId)) {
    const newId = current.fields['New ID'];
    const key = newId == null || newId === '' ? null : String(newId);
    if (key != null) {
      if (visited.has(key)) return current;
      visited.add(key);
    }
    current = byNewId.get(String(current.fields['Old ID']));
  }
  return current;
}

function openLineageFor(record) {
  const byNewId = new Map();
  state.records.forEach(r => {
    const id = r.fields['New ID'];
    if (id != null && id !== '') byNewId.set(String(id), r);
  });

  const rootRecord = findRoot(record, byNewId);
  const chains = buildChains(state.records);
  const rootNode = chains.find(c => c.record.id === rootRecord.id);
  if (!rootNode) return;

  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('canvas-btn').classList.add('active');
  hideDashboard();
  showCanvasTab();
  openChain(rootNode, record.id);
}

document.getElementById('view-lineage-btn').addEventListener('click', () => {
  if (!currentDetailRecord || !currentDetailTable) return;
  const record = currentDetailRecord;
  closeRecordModal();
  openLineageFor(record);
});
```

- [ ] **Step 2: Verify with `node --check` and live end-to-end**

Run: `node --check renderer/canvas.js`
Expected: no output, exit code 0

Launch with remote debugging, open any task's record modal (`openRecordModal(rec, state.activeTable)` via `Runtime.evaluate`, or a real double-click), click "🕸 View lineage", and confirm via `Runtime.evaluate`: the Canvas tab button now has the `active` class, `#canvas-container` is visible, `#canvas-tree-view` is visible (not the list), and the card whose `record.id` matches the originating task has `highlight-flash` in its `classList`. Take a `Page.captureScreenshot` to confirm the highlighted card is visible in the viewport (scrolled into view).

- [ ] **Step 3: Commit**

```bash
git add renderer/canvas.js
git commit -m "Add \"View lineage\" entry point from the task detail modal"
```

---

## Self-Review Notes

- **Spec coverage:** Data model (Task 1), layout algorithm (Task 2), entry points — Canvas tab (Task 3/4) and "View lineage" button (Task 6), card design (Task 4), interactions — pan/zoom (Task 5) and connectors/click-to-open (Task 4), file structure (all tasks; `canvas-data.js` vs. spec's single `canvas.js` is a deliberate, spec-permitted deviation so the pure logic stays Jest-requirable without risking a `document is not defined` crash on `require()`), testing (Task 1 & 2's Jest tests, plus the live-verification step in every task that touches the DOM).
- **Type/name consistency check:** `buildChains`/`layoutChain`/`isChainRoot` signatures are defined once in Task 1/2 and used identically in every later task; `openChain(root, highlightRecordId)` defined in Task 4 is called the same way in Task 6; `renderCanvasTransform()` defined in Task 5 is called from Task 5's own `openChain` edit, not redefined elsewhere.
- **No placeholders:** every step above contains complete, runnable code — nothing deferred to "later" or described without being shown.
