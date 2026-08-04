# Notification Priority/Deadline Urgency Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each notification in the dropdown shows a Priority pill and a color-coded Deadline label, and the whole row gets a red left-border highlight when the task is overdue or High priority.

**Architecture:** Extend the existing pure `renderer/notifications-data.js` module (`recordToNotification` gains `priority`/`deadline`; a new `computeDeadlineUrgency` pure function classifies a deadline) with full Jest coverage, then wire the result into `renderNotificationDropdown()` in `renderer/app.js`, reusing the existing `.select-pill`/`singleSelectSwatch` machinery the main records table already uses for Priority coloring.

**Tech Stack:** Plain JS, Jest for the pure-logic tests, no new dependencies.

## Global Constraints

- `computeDeadlineUrgency(deadline, today)` takes `today` as a parameter — never reads the system clock internally — matching how `recordToNotification` already takes `now` as a parameter (per spec Design).
- Priority pill coloring reuses the exact existing `.select-pill` class and `singleSelectSwatch` helper — no new/hardcoded color scheme (per spec Goals).
- The row-level `urgent` highlight triggers only on `priority === 'High'` or `urgency === 'overdue'` — a `'today'`/`'tomorrow'` deadline alone does not trigger it (per spec Design).
- No changes to `notifyNewTask` (OS banner) or any backfill/migration for already-persisted notifications — missing `priority`/`deadline` on old entries just means their badges don't render (per spec Non-goals).

---

### Task 1: Pure data layer — `priority`/`deadline` capture and urgency classification

**Files:**
- Modify: `renderer/notifications-data.js`
- Modify: `tests/notifications-data.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `recordToNotification(rec, tableName, now)` now also returns `priority` (string or `null`) and `deadline` (string or `null`). New `computeDeadlineUrgency(deadline, today)` → `null | 'overdue' | 'today' | 'tomorrow' | 'normal'`, both `deadline` and `today` being plain `YYYY-MM-DD` strings. Task 2 calls `computeDeadlineUrgency` by name from `renderer/app.js` (already a global via the existing `<script src="notifications-data.js">` tag) and reads `.priority`/`.deadline` off notification objects.

- [ ] **Step 1: Update the existing test and write the new failing tests**

In `tests/notifications-data.test.js`, replace:

```javascript
const {
  MAX_NOTIFICATIONS,
  recordToNotification,
  diffMissedRecords,
  appendNotification,
  appendNotificationBatch,
  unreadCount,
  markAllRead,
} = require('../renderer/notifications-data');
```

with:

```javascript
const {
  MAX_NOTIFICATIONS,
  recordToNotification,
  computeDeadlineUrgency,
  diffMissedRecords,
  appendNotification,
  appendNotificationBatch,
  unreadCount,
  markAllRead,
} = require('../renderer/notifications-data');
```

Then replace the existing test (its expectation needs `priority`/`deadline` added — `toEqual` checks every key):

```javascript
test('recordToNotification maps a record into a notification entry', () => {
  const entry = recordToNotification(rec('rec1', { Name: 'Cut the trailer' }), 'VCP Creatives', 1000);
  expect(entry).toEqual({
    id: 'VCP Creatives:rec1:1000',
    recordId: 'rec1',
    tableName: 'VCP Creatives',
    taskName: 'Cut the trailer',
    timestamp: 1000,
    read: false,
  });
});
```

with:

```javascript
test('recordToNotification maps a record into a notification entry', () => {
  const entry = recordToNotification(rec('rec1', { Name: 'Cut the trailer' }), 'VCP Creatives', 1000);
  expect(entry).toEqual({
    id: 'VCP Creatives:rec1:1000',
    recordId: 'rec1',
    tableName: 'VCP Creatives',
    taskName: 'Cut the trailer',
    timestamp: 1000,
    read: false,
    priority: null,
    deadline: null,
  });
});

test('recordToNotification captures priority and deadline when present', () => {
  const entry = recordToNotification(
    rec('rec1', { Name: 'Cut the trailer', Priority: 'High', Deadline: '2026-08-01' }),
    'VCP Creatives',
    1000
  );
  expect(entry.priority).toBe('High');
  expect(entry.deadline).toBe('2026-08-01');
});
```

Then append these new tests to the end of the file:

```javascript
test('computeDeadlineUrgency returns "overdue" for a past date', () => {
  expect(computeDeadlineUrgency('2026-07-30', '2026-07-31')).toBe('overdue');
});

test('computeDeadlineUrgency returns "today" for the exact same date', () => {
  expect(computeDeadlineUrgency('2026-07-31', '2026-07-31')).toBe('today');
});

test('computeDeadlineUrgency returns "tomorrow" for the next day, across a year rollover', () => {
  expect(computeDeadlineUrgency('2027-01-01', '2026-12-31')).toBe('tomorrow');
});

test('computeDeadlineUrgency returns "normal" for a date further out', () => {
  expect(computeDeadlineUrgency('2026-08-15', '2026-07-31')).toBe('normal');
});

test('computeDeadlineUrgency returns null when there is no deadline', () => {
  expect(computeDeadlineUrgency(null, '2026-07-31')).toBeNull();
  expect(computeDeadlineUrgency('', '2026-07-31')).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify the new/changed ones fail**

Run: `npx jest tests/notifications-data.test.js`
Expected: FAIL — the updated `recordToNotification` test fails (extra keys not yet returned), `computeDeadlineUrgency` is not a function for the 5 new tests. All other pre-existing tests still pass unchanged.

- [ ] **Step 3: Implement in `renderer/notifications-data.js`**

Change:

```javascript
function recordToNotification(rec, tableName, now) {
  return {
    id: `${tableName}:${rec.id}:${now}`,
    recordId: rec.id,
    tableName,
    taskName: rec.fields['Name'] || 'Untitled task',
    timestamp: now,
    read: false,
  };
}
```

to:

```javascript
function recordToNotification(rec, tableName, now) {
  return {
    id: `${tableName}:${rec.id}:${now}`,
    recordId: rec.id,
    tableName,
    taskName: rec.fields['Name'] || 'Untitled task',
    timestamp: now,
    read: false,
    priority: rec.fields['Priority'] || null,
    deadline: rec.fields['Deadline'] || null,
  };
}
```

Then add, right after `recordToNotification`:

```javascript
function pad2(n) { return String(n).padStart(2, '0'); }

// Adds `days` to a plain YYYY-MM-DD string, using local date components
// throughout (never UTC/.toISOString()) so it can't shift by a day in
// timezones ahead of UTC — matches how app.js's own toISO() works.
function addDaysISO(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Classifies a deadline relative to `today` (both plain YYYY-MM-DD strings,
// `today` passed in rather than read from the clock, for determinism).
function computeDeadlineUrgency(deadline, today) {
  if (!deadline) return null;
  if (deadline < today) return 'overdue';
  if (deadline === today) return 'today';
  if (deadline === addDaysISO(today, 1)) return 'tomorrow';
  return 'normal';
}
```

Finally, update the exports. Change:

```javascript
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MAX_NOTIFICATIONS,
    recordToNotification,
    diffMissedRecords,
    appendNotification,
    appendNotificationBatch,
    unreadCount,
    markAllRead,
  };
}
```

to:

```javascript
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MAX_NOTIFICATIONS,
    recordToNotification,
    computeDeadlineUrgency,
    diffMissedRecords,
    appendNotification,
    appendNotificationBatch,
    unreadCount,
    markAllRead,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/notifications-data.test.js`
Expected: PASS (16/16 — the original 10 tests, with 1 updated in place, plus 6 new: 1 `recordToNotification` test + 5 `computeDeadlineUrgency` tests).

- [ ] **Step 5: Commit**

```bash
git add renderer/notifications-data.js tests/notifications-data.test.js
git commit -m "Capture priority/deadline on notifications, add deadline urgency classifier"
```

---

### Task 2: Render Priority pill, Deadline label, and row-level urgency highlight

**Files:**
- Modify: `renderer/app.js:531-560` (`renderNotificationDropdown`)
- Modify: `renderer/styles.css`

**Interfaces:**
- Consumes: `computeDeadlineUrgency(deadline, today)` from Task 1 (`renderer/notifications-data.js`, already a global via its `<script>` tag), plus the existing `toISO(new Date())` (`renderer/app.js:161`), `singleSelectSwatch(tableName, fieldName, value)` (`renderer/app.js:36-41`), and the existing `.select-pill` CSS class (`renderer/styles.css:80`).
- Produces: nothing later depends on this; last task.

- [ ] **Step 1: Update `renderNotificationDropdown()`**

In `renderer/app.js`, find:

```javascript
function renderNotificationDropdown() {
  const listEl = document.getElementById('notify-dropdown-list');
  const emptyEl = document.getElementById('notify-dropdown-empty');
  emptyEl.classList.toggle('hidden', notifications.length > 0);
  listEl.innerHTML = '';
  notifications.forEach(n => {
    const btn = document.createElement('button');
    btn.className = `notify-item${n.read ? ' read' : ''}`;
    const shortTable = n.tableName.replace(' Creatives', '');
    const timeSpan = document.createElement('span');
    timeSpan.className = 'notify-item-time';
    timeSpan.textContent = new Date(n.timestamp).toLocaleString();
    btn.appendChild(timeSpan);
    btn.appendChild(document.createTextNode(n.taskName));
    const tableSpan = document.createElement('span');
    tableSpan.className = 'notify-item-table';
    tableSpan.textContent = shortTable;
    btn.appendChild(tableSpan);
    btn.addEventListener('click', () => {
      const rec = (recordsCache[n.tableName] || []).find(r => r.id === n.recordId);
      if (!rec) {
        btn.textContent = 'This task is no longer available.';
        return;
      }
      toggleNotificationDropdown();
      goToRecord(rec, n.tableName);
    });
    listEl.appendChild(btn);
  });
}
```

Change to:

```javascript
function renderNotificationDropdown() {
  const listEl = document.getElementById('notify-dropdown-list');
  const emptyEl = document.getElementById('notify-dropdown-empty');
  emptyEl.classList.toggle('hidden', notifications.length > 0);
  listEl.innerHTML = '';
  const today = toISO(new Date());
  const DEADLINE_LABELS = { overdue: 'Overdue', today: 'Due today', tomorrow: 'Due tomorrow' };
  notifications.forEach(n => {
    const urgency = computeDeadlineUrgency(n.deadline, today);
    const isUrgentRow = n.priority === 'High' || urgency === 'overdue';
    const btn = document.createElement('button');
    btn.className = `notify-item${n.read ? ' read' : ''}${isUrgentRow ? ' urgent' : ''}`;
    const shortTable = n.tableName.replace(' Creatives', '');
    const timeSpan = document.createElement('span');
    timeSpan.className = 'notify-item-time';
    timeSpan.textContent = new Date(n.timestamp).toLocaleString();
    btn.appendChild(timeSpan);
    btn.appendChild(document.createTextNode(n.taskName));
    if (n.priority) {
      const priorityPill = document.createElement('span');
      priorityPill.className = 'select-pill';
      priorityPill.textContent = n.priority;
      const swatch = singleSelectSwatch(n.tableName, 'Priority', n.priority);
      if (swatch) { priorityPill.style.background = swatch.bg; priorityPill.style.color = swatch.text; }
      btn.appendChild(priorityPill);
    }
    if (n.deadline) {
      const deadlineSpan = document.createElement('span');
      deadlineSpan.className = `notify-deadline${urgency !== 'normal' ? ` ${urgency}` : ''}`;
      deadlineSpan.textContent = DEADLINE_LABELS[urgency] || n.deadline;
      btn.appendChild(deadlineSpan);
    }
    const tableSpan = document.createElement('span');
    tableSpan.className = 'notify-item-table';
    tableSpan.textContent = shortTable;
    btn.appendChild(tableSpan);
    btn.addEventListener('click', () => {
      const rec = (recordsCache[n.tableName] || []).find(r => r.id === n.recordId);
      if (!rec) {
        btn.textContent = 'This task is no longer available.';
        return;
      }
      toggleNotificationDropdown();
      goToRecord(rec, n.tableName);
    });
    listEl.appendChild(btn);
  });
}
```

- [ ] **Step 2: Add the CSS**

In `renderer/styles.css`, find:

```css
.notify-item .notify-item-time { display: block; color: var(--text-muted); font-size: 10px; margin-bottom: var(--space-1); }
```

Add immediately after it:

```css
.notify-item.urgent { border-left: 3px solid #f66; }
.notify-deadline { font-size: 10px; margin-left: var(--space-2); color: var(--text-muted); }
.notify-deadline.overdue { color: #f66; font-weight: 600; }
.notify-deadline.today, .notify-deadline.tomorrow { color: #fa0; font-weight: 600; }
```

- [ ] **Step 3: Manually verify in a fresh browser tab**

Load `file:///Users/pc-63/Desktop/HiggTable/renderer/index.html` in a **fresh browser tab** (a previously-used tab may serve cached `app.js`/`notifications-data.js`/`styles.css` — open a new tab if anything looks stale), open DevTools console, and run:

```js
(function(){
  const today = toISO(new Date());
  notifications = [
    { id: '1', recordId: 'r1', tableName: 'CMC Creatives', taskName: 'Overdue High-priority task', timestamp: Date.now(), read: false, priority: 'High', deadline: addDaysISO(today, -2) },
    { id: '2', recordId: 'r2', tableName: 'CMC Creatives', taskName: 'Due tomorrow, Medium priority', timestamp: Date.now(), read: false, priority: 'Medium', deadline: addDaysISO(today, 1) },
    { id: '3', recordId: 'r3', tableName: 'CMC Creatives', taskName: 'No deadline or priority set', timestamp: Date.now(), read: false, priority: null, deadline: null },
  ];
  renderNotificationDropdown();
  document.getElementById('notify-dropdown').classList.remove('hidden');
  const items = [...document.querySelectorAll('.notify-item')];
  return JSON.stringify(items.map(el => ({
    isUrgent: el.classList.contains('urgent'),
    priorityPillText: el.querySelector('.select-pill')?.textContent ?? null,
    deadlineText: el.querySelector('.notify-deadline')?.textContent ?? null,
    deadlineClass: el.querySelector('.notify-deadline')?.className ?? null,
  })));
})()
```

Expected: three entries — (1) `isUrgent: true` (overdue + High), pill text `"High"`, deadline text `"Overdue"`, deadline class includes `overdue`; (2) `isUrgent: false` (Medium priority, only due tomorrow — not overdue, not High), pill text `"Medium"`, deadline text `"Due tomorrow"`, class includes `tomorrow`; (3) `isUrgent: false`, no `.select-pill` and no `.notify-deadline` element at all (both `null`/`undefined` fields, per the graceful-degradation requirement). Clean up afterward: `document.getElementById('notify-dropdown').classList.add('hidden'); notifications = [];`.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS, 60/60 (54 existing + 6 new from Task 1).

- [ ] **Step 5: Commit**

```bash
git add renderer/app.js renderer/styles.css
git commit -m "Show priority/deadline urgency indicators in the notification dropdown"
```
