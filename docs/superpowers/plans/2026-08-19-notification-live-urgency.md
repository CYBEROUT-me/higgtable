# Live Urgency Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notification badges reflect the task's current Priority/Deadline from `recordsCache`, suppress urgency for finished tasks, and render a deadline label only when genuinely urgent.

**Architecture:** One new pure function, `resolveNotificationBadges(n, rec, today)`, in the existing `renderer/notifications-data.js` module (Jest-tested alongside `computeDeadlineUrgency`), consumed by `renderNotificationDropdown` in `renderer/app.js` using the same `recordsCache` lookup its click handler already performs. No CSS changes, no persistence changes.

**Tech Stack:** Plain JS, Jest, no new dependencies.

## Global Constraints

- Resolution rule, verbatim from the spec: live record found → use its `Priority`/`Deadline`, suppress urgency if `Status` is `Done`/`To accept`; live record absent → use the stored snapshot, urgency included.
- Record-level fallback, **not** field-level: a cleared live field yields `null`, never the snapshot value.
- Deadline label renders **only** for `'overdue'`/`'today'`/`'tomorrow'` — `'normal'` and `null` render nothing.
- Priority pill renders for **all** levels (High/Medium/Low), not just High.
- `today` is always passed in, never read from the clock inside the pure module.
- No changes to `notifyNewTask`, to persistence/`recordToNotification`, or to `renderer/styles.css`.

---

### Task 1: Pure `resolveNotificationBadges`

**Files:**
- Modify: `renderer/notifications-data.js`
- Modify: `tests/notifications-data.test.js`

**Interfaces:**
- Consumes: the existing `computeDeadlineUrgency(deadline, today)` in the same module.
- Produces: `resolveNotificationBadges(n, rec, today)` → `{ priority: string|null, deadline: string|null, urgency: null|'overdue'|'today'|'tomorrow'|'normal', isUrgent: boolean }`. `n` is a stored notification, `rec` is the live Airtable record or a falsy value when unavailable, `today` is a `YYYY-MM-DD` string. Task 2 calls it by name from `renderer/app.js` (already a global via the existing `<script src="notifications-data.js">` tag).

- [ ] **Step 1: Write the failing tests**

Append to `tests/notifications-data.test.js`:

```javascript
const liveRec = (fields) => ({ id: 'rec1', fields });
const snapshot = (over = {}) => ({
  id: 'CMC Creatives:rec1:1000', recordId: 'rec1', tableName: 'CMC Creatives',
  taskName: 'Task', timestamp: 1000, read: false,
  priority: 'Low', deadline: '2026-12-31', ...over,
});

test('resolveNotificationBadges prefers the live record over a stale snapshot', () => {
  const r = resolveNotificationBadges(
    snapshot({ priority: 'Low', deadline: '2026-12-31' }),
    liveRec({ Priority: 'High', Deadline: '2026-08-19', Status: 'In work' }),
    '2026-08-19'
  );
  expect(r.priority).toBe('High');
  expect(r.deadline).toBe('2026-08-19');
  expect(r.urgency).toBe('today');
  expect(r.isUrgent).toBe(true);
});

test('resolveNotificationBadges uses record-level fallback: a cleared live field is null, not the snapshot value', () => {
  const r = resolveNotificationBadges(
    snapshot({ priority: 'High', deadline: '2026-08-01' }),
    liveRec({ Status: 'In work' }),
    '2026-08-19'
  );
  expect(r.priority).toBeNull();
  expect(r.deadline).toBeNull();
  expect(r.urgency).toBeNull();
  expect(r.isUrgent).toBe(false);
});

test('resolveNotificationBadges suppresses urgency for a completed task even when overdue and High', () => {
  for (const status of ['Done', 'To accept']) {
    const r = resolveNotificationBadges(
      snapshot(),
      liveRec({ Priority: 'High', Deadline: '2026-08-01', Status: status }),
      '2026-08-19'
    );
    expect(r.priority).toBe('High');   // pill still shows
    expect(r.deadline).toBe('2026-08-01');
    expect(r.urgency).toBeNull();      // no label
    expect(r.isUrgent).toBe(false);    // no red stripe
  }
});

test('resolveNotificationBadges falls back to the snapshot with urgency when the record is absent', () => {
  const r = resolveNotificationBadges(
    snapshot({ priority: 'Medium', deadline: '2026-08-01' }),
    null,
    '2026-08-19'
  );
  expect(r.priority).toBe('Medium');
  expect(r.deadline).toBe('2026-08-01');
  expect(r.urgency).toBe('overdue');
  expect(r.isUrgent).toBe(true);
});

test('resolveNotificationBadges marks High priority urgent without an overdue deadline', () => {
  const r = resolveNotificationBadges(
    snapshot(),
    liveRec({ Priority: 'High', Deadline: '2026-12-31', Status: 'In work' }),
    '2026-08-19'
  );
  expect(r.urgency).toBe('normal');
  expect(r.isUrgent).toBe(true);
});

test('resolveNotificationBadges leaves a distant deadline non-urgent', () => {
  const r = resolveNotificationBadges(
    snapshot(),
    liveRec({ Priority: 'Low', Deadline: '2026-12-31', Status: 'In work' }),
    '2026-08-19'
  );
  expect(r.urgency).toBe('normal');
  expect(r.isUrgent).toBe(false);
});
```

Then add `resolveNotificationBadges` to the destructured `require(...)` at the top of the file, so it reads:

```javascript
const {
  MAX_NOTIFICATIONS,
  recordToNotification,
  computeDeadlineUrgency,
  resolveNotificationBadges,
  diffMissedRecords,
  appendNotification,
  appendNotificationBatch,
  unreadCount,
  markAllRead,
} = require('../renderer/notifications-data');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/notifications-data.test.js`
Expected: FAIL — `resolveNotificationBadges is not a function` for the 6 new tests. The 16 pre-existing tests still pass.

- [ ] **Step 3: Implement in `renderer/notifications-data.js`**

Add after `computeDeadlineUrgency`:

```javascript
// A task in one of these statuses is finished, so it is never "urgent"
// regardless of its deadline — same completed-status pair the dashboard
// already treats as done work.
const COMPLETED_STATUSES = ['Done', 'To accept'];

// Decides what badges one notification should display. `rec` is the live
// Airtable record from recordsCache, or falsy when it isn't available (table
// still preloading, or the record was deleted).
//
// Live record found -> use its current Priority/Deadline, and suppress
// urgency when its Status is completed. Record-level fallback: if the record
// is present but a field was cleared, that field is null — it does NOT fall
// back to the snapshot, since the snapshot means "couldn't ask", not
// "didn't like the answer".
//
// Record absent -> fall back to the notification's stored snapshot, urgency
// included: a missing record is usually just a table that hasn't finished
// preloading, and hiding a real alert is worse than briefly showing a stale
// one.
function resolveNotificationBadges(n, rec, today) {
  const priority = rec ? (rec.fields['Priority'] || null) : (n.priority || null);
  const deadline = rec ? (rec.fields['Deadline'] || null) : (n.deadline || null);
  const completed = !!rec && COMPLETED_STATUSES.includes(rec.fields['Status'] || '');
  const urgency = completed ? null : computeDeadlineUrgency(deadline, today);
  const isUrgent = !completed && (priority === 'High' || urgency === 'overdue');
  return { priority, deadline, urgency, isUrgent };
}
```

Then extend the exports block to include both new names:

```javascript
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MAX_NOTIFICATIONS,
    COMPLETED_STATUSES,
    recordToNotification,
    computeDeadlineUrgency,
    resolveNotificationBadges,
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
Expected: PASS (22/22 — 16 existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add renderer/notifications-data.js tests/notifications-data.test.js
git commit -m "Resolve notification badges from live records, suppressing urgency when finished"
```

---

### Task 2: Wire live resolution into the dropdown

**Files:**
- Modify: `renderer/app.js` (`renderNotificationDropdown`)

**Interfaces:**
- Consumes: `resolveNotificationBadges(n, rec, today)` from Task 1, plus the existing `toISO` (`renderer/app.js`), `singleSelectSwatch`, and `recordsCache`.
- Produces: nothing further depends on this; last task.

- [ ] **Step 1: Update `renderNotificationDropdown`**

Find this block inside the `notifications.forEach(n => {` loop:

```javascript
    const urgency = computeDeadlineUrgency(n.deadline, today);
    const isUrgentRow = n.priority === 'High' || urgency === 'overdue';
    const btn = document.createElement('button');
    btn.className = `notify-item${n.read ? ' read' : ''}${isUrgentRow ? ' urgent' : ''}`;
```

Change to:

```javascript
    const liveRec = (recordsCache[n.tableName] || []).find(r => r.id === n.recordId);
    const { priority, deadline, urgency, isUrgent } = resolveNotificationBadges(n, liveRec, today);
    const btn = document.createElement('button');
    btn.className = `notify-item${n.read ? ' read' : ''}${isUrgent ? ' urgent' : ''}`;
```

Then find the Priority pill block:

```javascript
    if (n.priority) {
      const priorityPill = document.createElement('span');
      priorityPill.className = 'select-pill';
      priorityPill.textContent = n.priority;
      const swatch = singleSelectSwatch(n.tableName, 'Priority', n.priority);
      if (swatch) { priorityPill.style.background = swatch.bg; priorityPill.style.color = swatch.text; }
      btn.appendChild(priorityPill);
    }
```

Change to (reads the resolved `priority` instead of the snapshot):

```javascript
    if (priority) {
      const priorityPill = document.createElement('span');
      priorityPill.className = 'select-pill';
      priorityPill.textContent = priority;
      const swatch = singleSelectSwatch(n.tableName, 'Priority', priority);
      if (swatch) { priorityPill.style.background = swatch.bg; priorityPill.style.color = swatch.text; }
      btn.appendChild(priorityPill);
    }
```

Then find the deadline block:

```javascript
    if (n.deadline) {
      const deadlineSpan = document.createElement('span');
      deadlineSpan.className = `notify-deadline${urgency !== 'normal' ? ` ${urgency}` : ''}`;
      deadlineSpan.textContent = DEADLINE_LABELS[urgency] || n.deadline;
      btn.appendChild(deadlineSpan);
    }
```

Change to (renders only for the three urgent states — no label at all otherwise):

```javascript
    if (DEADLINE_LABELS[urgency]) {
      const deadlineSpan = document.createElement('span');
      deadlineSpan.className = `notify-deadline ${urgency}`;
      deadlineSpan.textContent = DEADLINE_LABELS[urgency];
      btn.appendChild(deadlineSpan);
    }
```

`DEADLINE_LABELS` already contains exactly the three urgent keys
(`overdue`/`today`/`tomorrow`), so this single lookup replaces both the
`n.deadline` guard and the `urgency !== 'normal'` class logic — a `'normal'`
or `null` urgency simply has no entry and renders nothing.

- [ ] **Step 2: Manually verify in a fresh browser tab**

Load `file:///Users/pc-63/Desktop/HiggTable/renderer/index.html` in a **fresh browser tab** (a used tab may serve cached `app.js`/`notifications-data.js` — open a new one if anything looks stale), then in the DevTools console:

```js
(function(){
  const today = toISO(new Date());
  recordsCache['CMC Creatives'] = [
    { id: 'r1', fields: { Name: 'live-high-overdue', Priority: 'High', Deadline: addDaysISO(today, -3), Status: 'In work' } },
    { id: 'r2', fields: { Name: 'live-done-overdue', Priority: 'High', Deadline: addDaysISO(today, -3), Status: 'Done' } },
    { id: 'r3', fields: { Name: 'live-cleared-fields', Status: 'In work' } },
    { id: 'r4', fields: { Name: 'live-low-distant', Priority: 'Low', Deadline: addDaysISO(today, 30), Status: 'In work' } },
  ];
  notifications = ['r1','r2','r3','r4','r9'].map((id,i) => ({
    id: String(i), recordId: id, tableName: 'CMC Creatives', taskName: id,
    timestamp: Date.now(), read: false,
    priority: 'Medium', deadline: addDaysISO(today, -5),   // stale snapshot on every one
  }));
  renderNotificationDropdown();
  document.getElementById('notify-dropdown').classList.remove('hidden');
  return JSON.stringify([...document.querySelectorAll('.notify-item')].map(el => ({
    task: el.textContent.match(/(r\d)/)?.[1],
    urgentStripe: el.classList.contains('urgent'),
    pill: el.querySelector('.select-pill')?.textContent ?? null,
    deadline: el.querySelector('.notify-deadline')?.textContent ?? null,
  })), null, 1);
})()
```

Expected, one row per record:
- `r1` live High + overdue, In work → `urgentStripe: true`, `pill: "High"`, `deadline: "Overdue"`.
- `r2` same but `Status: 'Done'` → `urgentStripe: false`, `pill: "High"`, `deadline: null` (urgency suppressed; pill kept).
- `r3` live record with cleared fields → `urgentStripe: false`, `pill: null`, `deadline: null` (record-level fallback — the stale `Medium`/overdue snapshot is **not** used).
- `r4` live Low + 30 days out → `urgentStripe: false`, `pill: "Low"`, `deadline: null` (non-urgent renders no label).
- `r9` no live record → `urgentStripe: true`, `pill: "Medium"`, `deadline: "Overdue"` (snapshot fallback, urgency included).

Clean up: `document.getElementById('notify-dropdown').classList.add('hidden'); notifications = []; delete recordsCache['CMC Creatives'];`

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS, 66/66 (60 existing + 6 new from Task 1).

- [ ] **Step 4: Commit**

```bash
git add renderer/app.js
git commit -m "Render notification badges from live record state"
```
