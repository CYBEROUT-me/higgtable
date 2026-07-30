# Dashboard Time-Spent-Per-Designer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second Dashboard table, below the existing "Done + To accept tasks by designer" table, showing each designer's total logged `Hours` and average hours per creative, over the same filtered record set.

**Architecture:** Extract the new aggregation logic (summing/averaging the `Hours` field per designer) into a small pure function in a new file, `renderer/dashboard-data.js` — mirroring the existing `canvas-data.js`/`notifications-data.js` split, where pure logic lives in its own file so it's testable under plain Jest, while `renderer/app.js` handles wiring it into the existing filtered-record loop and rendering the DOM. `computeDashboardStats()` (`renderer/app.js:843-873`) is extended to also collect `{des, hours}` pairs during its existing loop and hand them to the new pure function; `renderDashboard()` (`renderer/app.js:875-949`) appends a second `<table class="dash-table">` reusing the existing bar-visualization CSS classes.

**Tech Stack:** Plain JS (no framework), Jest for the pure-logic unit tests (matching `tests/notifications-data.test.js`/`tests/canvas-data.test.js`), no build step.

## Global Constraints

- Same filtered record set as the existing table (Status = Done/To accept, respecting the current period preset/date range) — no new filtering logic (per spec Goals).
- Blank/non-numeric `Hours` values are excluded from both the sum and the average's denominator, never treated as `0` (per spec Design).
- A designer with zero logged `Hours` values shows `avgHours: null` → renders as `'–'`, distinct from a real `0` average (per spec Design).
- The grand-total average is the true weighted average (`sum of all logged hours ÷ count of all logged values`), never an average of the per-designer averages (per spec Design).
- Numeric displays round to 1 decimal place (per spec Design).
- No new Airtable fields, no fetch-scope changes, no changes to the existing task-count table or period/date controls (per spec Non-goals).

---

### Task 1: Pure `computeHoursByDesigner` aggregation function

**Files:**
- Create: `renderer/dashboard-data.js`
- Test: `tests/dashboard-data.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `computeHoursByDesigner(entries)` — `entries` is an array of `{ des: string, hours: number|undefined|null }`. Returns `{ rows: Array<{ des: string, totalHours: number, avgHours: number|null }>, totalHours: number, avgHours: number|null }`. `rows` is sorted by `totalHours` descending. Task 2 imports this function by name from `renderer/dashboard-data.js`.

- [ ] **Step 1: Write the failing tests**

Create `tests/dashboard-data.test.js`:

```javascript
const { computeHoursByDesigner } = require('../renderer/dashboard-data');

test('sums and averages hours per designer, sorted by total descending', () => {
  const result = computeHoursByDesigner([
    { des: 'Alice', hours: 2 },
    { des: 'Alice', hours: 4 },
    { des: 'Bob', hours: 10 },
  ]);
  expect(result.rows).toEqual([
    { des: 'Bob', totalHours: 10, avgHours: 10 },
    { des: 'Alice', totalHours: 6, avgHours: 3 },
  ]);
});

test('excludes blank/non-numeric hours from both the sum and the average denominator', () => {
  const result = computeHoursByDesigner([
    { des: 'Alice', hours: 5 },
    { des: 'Alice', hours: undefined },
    { des: 'Alice', hours: null },
  ]);
  expect(result.rows).toEqual([{ des: 'Alice', totalHours: 5, avgHours: 5 }]);
});

test('a designer with zero logged hours gets totalHours 0 and avgHours null', () => {
  const result = computeHoursByDesigner([{ des: 'Alice', hours: undefined }]);
  expect(result.rows).toEqual([{ des: 'Alice', totalHours: 0, avgHours: null }]);
});

test('grand total average is weighted across all entries, not an average of per-designer averages', () => {
  const result = computeHoursByDesigner([
    { des: 'Alice', hours: 10 },
    { des: 'Bob', hours: 1 },
    { des: 'Bob', hours: 1 },
    { des: 'Bob', hours: 1 },
  ]);
  // Naive average-of-averages would be (10 + 1) / 2 = 5.5 — wrong.
  // Correct weighted average is (10 + 1 + 1 + 1) / 4 = 3.25.
  expect(result.totalHours).toBe(13);
  expect(result.avgHours).toBe(3.25);
});

test('empty input returns empty rows and null grand average', () => {
  const result = computeHoursByDesigner([]);
  expect(result).toEqual({ rows: [], totalHours: 0, avgHours: null });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/dashboard-data.test.js`
Expected: FAIL with `Cannot find module '../renderer/dashboard-data'`.

- [ ] **Step 3: Implement `renderer/dashboard-data.js`**

```javascript
// renderer/dashboard-data.js
// Pure data-layer logic for the Dashboard's "time spent per designer"
// table: aggregating the Hours field per designer. No DOM access here —
// mirrors the canvas-data.js / notifications-data.js split so this can run
// under plain Jest.

// `entries` is an array of { des, hours } pairs, one per in-scope record
// (already filtered to the desired Status/period by the caller) — `hours`
// may be undefined/null/non-numeric when a record has no logged value.
function computeHoursByDesigner(entries) {
  const byDES = {};
  entries.forEach(({ des, hours }) => {
    if (!byDES[des]) byDES[des] = { sum: 0, count: 0 };
    if (typeof hours === 'number' && Number.isFinite(hours)) {
      byDES[des].sum += hours;
      byDES[des].count++;
    }
  });

  const rows = Object.entries(byDES)
    .map(([des, { sum, count }]) => ({
      des,
      totalHours: sum,
      avgHours: count ? sum / count : null,
    }))
    .sort((a, b) => b.totalHours - a.totalHours);

  const grandSum = rows.reduce((s, r) => s + r.totalHours, 0);
  const grandCount = Object.values(byDES).reduce((s, d) => s + d.count, 0);

  return {
    rows,
    totalHours: grandSum,
    avgHours: grandCount ? grandSum / grandCount : null,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeHoursByDesigner };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/dashboard-data.test.js`
Expected: PASS (5/5 tests).

- [ ] **Step 5: Commit**

```bash
git add renderer/dashboard-data.js tests/dashboard-data.test.js
git commit -m "Add pure hours-per-designer aggregation for the dashboard"
```

---

### Task 2: Wire hours stats into the Dashboard

**Files:**
- Modify: `renderer/index.html:207` (script tag order)
- Modify: `renderer/app.js:843-873` (`computeDashboardStats()`)
- Modify: `renderer/app.js:875-949` (`renderDashboard()`)

**Interfaces:**
- Consumes: `computeHoursByDesigner(entries)` from Task 1 (`renderer/dashboard-data.js`), returning `{ rows, totalHours, avgHours }` as specified there.
- Produces: nothing further depends on this (last task).

- [ ] **Step 1: Load `dashboard-data.js` before `app.js`**

In `renderer/index.html`, the script tags currently read (line 207-210):

```html
  <script src="notifications-data.js"></script>
  <script src="app.js"></script>
  <script src="canvas-data.js"></script>
  <script src="canvas.js"></script>
```

Change to:

```html
  <script src="notifications-data.js"></script>
  <script src="dashboard-data.js"></script>
  <script src="app.js"></script>
  <script src="canvas-data.js"></script>
  <script src="canvas.js"></script>
```

- [ ] **Step 2: Extend `computeDashboardStats()` to collect hours entries**

In `renderer/app.js`, replace:

```javascript
function computeDashboardStats() {
  const { from, to } = getDashboardRange();
  const notLoaded = TARGET_TABLES.filter(name => !recordsCache[name]);
  const byDES = {};
  const allTypes = new Set();

  TARGET_TABLES.forEach(name => {
    (recordsCache[name] || []).forEach(r => {
      const status = r.fields['Status'] || '';
      if (status !== 'Done' && status !== 'To accept') return;
      const dateDone = r.fields['Date Done'];
      if (from || to) {
        if (!dateDone) return; // no date to place it in a specific range
        if (from && dateDone < from) return;
        if (to && dateDone > to) return;
      }
      const des = r.fields['DES'] || '(unassigned)';
      const type = r.fields['Type'] || '(unspecified)';
      allTypes.add(type);
      if (!byDES[des]) byDES[des] = { total: 0, types: {} };
      byDES[des].total++;
      byDES[des].types[type] = (byDES[des].types[type] || 0) + 1;
    });
  });

  const rows = Object.entries(byDES)
    .map(([des, data]) => ({ des, total: data.total, types: data.types }))
    .sort((a, b) => b.total - a.total);

  return { rows, allTypes: [...allTypes].sort(), notLoaded, from, to };
}
```

with:

```javascript
function computeDashboardStats() {
  const { from, to } = getDashboardRange();
  const notLoaded = TARGET_TABLES.filter(name => !recordsCache[name]);
  const byDES = {};
  const allTypes = new Set();
  const hoursEntries = [];

  TARGET_TABLES.forEach(name => {
    (recordsCache[name] || []).forEach(r => {
      const status = r.fields['Status'] || '';
      if (status !== 'Done' && status !== 'To accept') return;
      const dateDone = r.fields['Date Done'];
      if (from || to) {
        if (!dateDone) return; // no date to place it in a specific range
        if (from && dateDone < from) return;
        if (to && dateDone > to) return;
      }
      const des = r.fields['DES'] || '(unassigned)';
      const type = r.fields['Type'] || '(unspecified)';
      allTypes.add(type);
      if (!byDES[des]) byDES[des] = { total: 0, types: {} };
      byDES[des].total++;
      byDES[des].types[type] = (byDES[des].types[type] || 0) + 1;
      hoursEntries.push({ des, hours: r.fields['Hours'] });
    });
  });

  const rows = Object.entries(byDES)
    .map(([des, data]) => ({ des, total: data.total, types: data.types }))
    .sort((a, b) => b.total - a.total);

  const { rows: hoursRows, totalHours, avgHours } = computeHoursByDesigner(hoursEntries);

  return { rows, allTypes: [...allTypes].sort(), notLoaded, from, to, hoursRows, totalHours, avgHours };
}
```

- [ ] **Step 3: Append the hours table in `renderDashboard()`**

In `renderer/app.js`, find:

```javascript
function renderDashboard() {
  const { rows, allTypes, notLoaded, from, to } = computeDashboardStats();
```

and change the destructuring to:

```javascript
function renderDashboard() {
  const { rows, allTypes, notLoaded, from, to, hoursRows, totalHours, avgHours } = computeDashboardStats();
```

Then find the end of the function:

```javascript
  const totalRow = tbody.insertRow();
  totalRow.className = 'total-row';
  totalRow.insertCell().textContent = '';
  totalRow.insertCell().textContent = 'Total';
  totalRow.insertCell().textContent = rows.reduce((s, r) => s + r.total, 0);
  allTypes.forEach(type => {
    const td = totalRow.insertCell();
    const count = rows.reduce((s, r) => s + (r.types[type] || 0), 0);
    td.className = count ? 'dash-type-count' : 'dash-type-count zero';
    td.textContent = count || '–';
  });

  area.appendChild(table);
}
```

and replace the final two lines (`area.appendChild(table);` and the closing `}`) with:

```javascript
  area.appendChild(table);

  const hoursTable = document.createElement('table');
  hoursTable.className = 'dash-table';

  const hoursCaption = document.createElement('caption');
  hoursCaption.textContent = 'Time spent per designer (same filter as above)';
  hoursTable.appendChild(hoursCaption);

  const hoursHr = hoursTable.createTHead().insertRow();
  ['#', 'Designer', 'Total Hours', 'Avg Hours / Creative'].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    hoursHr.appendChild(th);
  });

  const hoursTbody = hoursTable.createTBody();
  const maxHours = hoursRows.length ? hoursRows[0].totalHours : 0;
  hoursRows.forEach((row, i) => {
    const tr = hoursTbody.insertRow();
    const tdRank = tr.insertCell(); tdRank.textContent = i + 1; tdRank.className = 'dash-rank';
    const tdName = tr.insertCell(); tdName.textContent = row.des; tdName.className = 'dash-name';

    const tdBar = tr.insertCell(); tdBar.className = 'dash-bar-cell';
    const track = document.createElement('div'); track.className = 'dash-bar-track';
    const fill = document.createElement('div'); fill.className = 'dash-bar-fill';
    fill.style.width = `${maxHours ? Math.max(4, (row.totalHours / maxHours) * 100) : 4}%`;
    const label = document.createElement('span'); label.className = 'dash-bar-label'; label.textContent = row.totalHours.toFixed(1);
    track.appendChild(fill); track.appendChild(label);
    tdBar.appendChild(track);

    const tdAvg = tr.insertCell();
    tdAvg.textContent = row.avgHours === null ? '–' : row.avgHours.toFixed(1);
  });

  const hoursTotalRow = hoursTbody.insertRow();
  hoursTotalRow.className = 'total-row';
  hoursTotalRow.insertCell().textContent = '';
  hoursTotalRow.insertCell().textContent = 'Total';
  hoursTotalRow.insertCell().textContent = totalHours.toFixed(1);
  hoursTotalRow.insertCell().textContent = avgHours === null ? '–' : avgHours.toFixed(1);

  area.appendChild(hoursTable);
}
```

Note: the existing early-return for the empty case (`if (!rows.length) { ...; return; }`, earlier in the function) already skips both tables together — `hoursRows` is empty in exactly the same cases `rows` is (same source loop), so no separate empty-state handling is needed for the hours table.

- [ ] **Step 4: Manually verify in the browser**

Load `file:///Users/pc-63/Desktop/HiggTable/renderer/index.html`, open DevTools console, and seed fake data to exercise the new table without needing real Airtable data:

```js
recordsCache['VCP Creatives'] = [
  { id: '1', fields: { Status: 'Done', DES: 'Alice', Type: 'Video', Hours: 2 } },
  { id: '2', fields: { Status: 'Done', DES: 'Alice', Type: 'Video', Hours: 4 } },
  { id: '3', fields: { Status: 'To accept', DES: 'Bob', Type: 'Static', Hours: 10 } },
  { id: '4', fields: { Status: 'Done', DES: 'Bob', Type: 'Static' } }, // no Hours logged
];
['PLM Creatives', 'CMC Creatives', 'LB Creatives'].forEach(t => { recordsCache[t] = []; });
showDashboard();
```

Expected: two tables render. The second, captioned "Time spent per designer (same filter as above)", shows Bob first (10.0 total, 10.0 avg — only the 10-hour record counts since the second Bob record has no `Hours`), then Alice (6.0 total, 3.0 avg), with a bold total row reading `16.0` / `5.3` (16 ÷ 3 logged entries, the true weighted average — not `(10+3)/2 = 6.5`, which would be the naive-but-wrong average-of-averages).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, now 33/33 (28 existing + 5 new from Task 1).

- [ ] **Step 6: Commit**

```bash
git add renderer/index.html renderer/app.js
git commit -m "Add time-spent-per-designer table to the dashboard"
```
