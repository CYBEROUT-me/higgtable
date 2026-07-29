# In-App Notifications with Sound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a header bell icon + dropdown that shows new-task notifications with a sound, alongside the existing OS notification, and catches up on anything assigned while the app was closed.

**Architecture:** A new pure-logic module (`renderer/notifications-data.js`, unit-tested, mirroring the existing `canvas-data.js`/`canvas.js` split) handles diffing and list-capping with no DOM/localStorage access. `renderer/app.js` owns all IO: persisting seen-IDs and the notification list to `localStorage`, rendering the bell/badge/dropdown, synthesizing the sound, and wiring it into the existing `init()` and `pollOneTable()` flows.

**Tech Stack:** Vanilla JS (no bundler — files share global scope via `<script>` tags, same pattern as `canvas-data.js`/`canvas.js`), Jest for the pure-logic tests, Web Audio API for the sound, `localStorage` for persistence.

## Global Constraints

- No DES selected (`state.selectedDES` falsy) → no notifications of any kind, live or catch-up. This matches the existing gate in `pollOneTable` (`renderer/app.js:391`) and must not change.
- Notification list is capped at 50 entries (oldest dropped).
- First-ever run (no persisted seen-IDs at all) must NOT generate catch-up notifications — there's no prior baseline, and treating a fresh install as a backlog of missed tasks would be spam.
- The notification sound is synthesized via the Web Audio API — no bundled audio file/asset.
- The mute toggle only silences our synthesized sound. It must not touch the existing OS-native `Notification` (`notifyNewTask`, `renderer/app.js:407`), which keeps firing exactly as it does today.
- Cold-open catch-up plays the sound at most once for the whole batch, not once per missed task.
- Pure logic (diffing, list capping, read-marking) lives in `renderer/notifications-data.js` with zero DOM/`localStorage`/`Date.now()` calls internally, so it can run under Jest's default `node` test environment (this repo has no `jest-environment-jsdom` installed — confirmed via `package.json`, `canvas-data.js`/`canvas-data.test.js` already rely on this).

---

## Task 1: Notification data module (pure logic)

**Files:**
- Create: `renderer/notifications-data.js`
- Test: `tests/notifications-data.test.js`

**Interfaces:**
- Consumes: nothing (pure module, no dependencies on other app code)
- Produces (used by Task 2 and Task 3):
  - `MAX_NOTIFICATIONS: number` — cap constant, value `50`
  - `recordToNotification(rec: {id, fields}, tableName: string, now: number): {id, recordId, tableName, taskName, timestamp, read}`
  - `diffMissedRecords(persistedIds: string[], freshRecords: Array<{id, fields}>, des: string): Array<{id, fields}>`
  - `appendNotification(list: Array, entry: Object): Array` — returns a new array, newest-first, capped
  - `appendNotificationBatch(list: Array, entries: Array): Array` — returns a new array, newest-first, capped
  - `unreadCount(list: Array<{read: boolean}>): number`
  - `markAllRead(list: Array<{read: boolean}>): Array` — returns a new array, does not mutate input

- [ ] **Step 1: Write the failing tests**

Create `tests/notifications-data.test.js`:

```js
// tests/notifications-data.test.js
const {
  MAX_NOTIFICATIONS,
  recordToNotification,
  diffMissedRecords,
  appendNotification,
  appendNotificationBatch,
  unreadCount,
  markAllRead,
} = require('../renderer/notifications-data');

function rec(id, fields = {}) {
  return { id, fields };
}

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

test('recordToNotification falls back to "Untitled task" when Name is blank', () => {
  const entry = recordToNotification(rec('rec1', {}), 'VCP Creatives', 1000);
  expect(entry.taskName).toBe('Untitled task');
});

test('diffMissedRecords returns nothing when no DES is selected', () => {
  const fresh = [rec('rec1', { DES: 'Alex' })];
  expect(diffMissedRecords([], fresh, '')).toEqual([]);
});

test('diffMissedRecords returns records not in the persisted ID set, filtered by DES', () => {
  const fresh = [
    rec('rec1', { DES: 'Alex' }),
    rec('rec2', { DES: 'Sam' }),
    rec('rec3', { DES: 'Alex' }),
  ];
  const missed = diffMissedRecords(['rec1'], fresh, 'Alex');
  expect(missed.map(r => r.id)).toEqual(['rec3']);
});

test('diffMissedRecords returns nothing when every record is already in the persisted set', () => {
  const fresh = [rec('rec1', { DES: 'Alex' })];
  expect(diffMissedRecords(['rec1'], fresh, 'Alex')).toEqual([]);
});

test('appendNotification prepends newest-first', () => {
  const list = appendNotification([{ id: 'old' }], { id: 'new' });
  expect(list.map(n => n.id)).toEqual(['new', 'old']);
});

test('appendNotification caps the list at MAX_NOTIFICATIONS', () => {
  const full = Array.from({ length: MAX_NOTIFICATIONS }, (_, i) => ({ id: `n${i}` }));
  const list = appendNotification(full, { id: 'newest' });
  expect(list).toHaveLength(MAX_NOTIFICATIONS);
  expect(list[0].id).toBe('newest');
  expect(list.find(n => n.id === `n${MAX_NOTIFICATIONS - 1}`)).toBeUndefined();
});

test('appendNotificationBatch prepends a whole batch newest-first, capped', () => {
  const list = appendNotificationBatch([{ id: 'old' }], [{ id: 'a' }, { id: 'b' }]);
  expect(list.map(n => n.id)).toEqual(['a', 'b', 'old']);
});

test('unreadCount counts only unread entries', () => {
  const list = [{ read: true }, { read: false }, { read: false }];
  expect(unreadCount(list)).toBe(2);
});

test('markAllRead sets read on every entry without mutating the input', () => {
  const list = [{ id: 'a', read: false }, { id: 'b', read: true }];
  const result = markAllRead(list);
  expect(result.every(n => n.read)).toBe(true);
  expect(list[0].read).toBe(false); // original untouched
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/notifications-data.test.js`
Expected: FAIL — `Cannot find module '../renderer/notifications-data'`

- [ ] **Step 3: Write the implementation**

Create `renderer/notifications-data.js`:

```js
// renderer/notifications-data.js
// Pure data-layer logic for the in-app notification bell: diffing "seen"
// record IDs against fresh records, and maintaining the capped notification
// list. No DOM/localStorage access here — see app.js for the IO/rendering
// side. Mirrors the canvas-data.js / canvas.js split: pure logic lives here
// so it can run under plain Jest (no jsdom) the same way canvas-data.js does.

const MAX_NOTIFICATIONS = 50;

// Builds one notification entry from a record. `now` is passed in (rather
// than read via Date.now() here) so this stays a pure, deterministically
// testable function.
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

// Given the record IDs persisted from the last session and the current
// fresh record list for one table, returns the records that are new since
// then — filtered to the same `des` a live poll already uses. `des`
// empty/falsy means no assignee is selected, so nothing is "missed" (matches
// pollOneTable's existing state.selectedDES gate).
function diffMissedRecords(persistedIds, freshRecords, des) {
  if (!des) return [];
  const seen = new Set(persistedIds);
  return freshRecords.filter(r => !seen.has(r.id) && (r.fields['DES'] || '') === des);
}

// Prepends one notification, newest-first, capped at MAX_NOTIFICATIONS.
function appendNotification(list, entry) {
  return [entry, ...list].slice(0, MAX_NOTIFICATIONS);
}

// Prepends a whole batch (callers pass entries in newest-first order among
// themselves, same as recordsCache already is), newest-first, capped.
function appendNotificationBatch(list, entries) {
  return [...entries, ...list].slice(0, MAX_NOTIFICATIONS);
}

function unreadCount(list) {
  return list.filter(n => !n.read).length;
}

function markAllRead(list) {
  return list.map(n => (n.read ? n : { ...n, read: true }));
}

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/notifications-data.test.js`
Expected: PASS — 10 tests passed

- [ ] **Step 5: Commit**

```bash
git add renderer/notifications-data.js tests/notifications-data.test.js
git commit -m "Add pure notification-data module for the in-app notification bell"
```

---

## Task 2: Bell icon UI, dropdown, sound, and mute toggle

**Files:**
- Modify: `renderer/index.html` (header markup, script tag)
- Modify: `renderer/styles.css` (bell/badge/dropdown/mute styles)
- Modify: `renderer/app.js` (rendering, sound, mute, event wiring)

**Interfaces:**
- Consumes from Task 1: `unreadCount`, `markAllRead`, `appendNotification`, `recordToNotification` (all imported via shared global scope — `notifications-data.js` is loaded as a `<script>` tag, same as `canvas-data.js`, so its exported functions are plain globals in the renderer, not `require`d)
- Consumes from existing app.js: `state`, `recordsCache`, `goToRecord(rec, tableName)` (`renderer/app.js:419`), `log(msg)` (`renderer/app.js:81`)
- Produces (used by Task 3):
  - `let notifications` — in-memory array of notification entries (module-level in app.js)
  - `function renderNotificationBell()` — updates badge text/visibility from `notifications`
  - `function renderNotificationDropdown()` — rebuilds the dropdown list DOM from `notifications`
  - `function addLiveNotification(rec, tableName)` — appends one notification, re-renders, plays sound
  - `function playNotificationSound()` — synthesizes and plays the chime (no-op if muted)

- [ ] **Step 1: Add header markup**

In `renderer/index.html`, add the `notifications-data.js` script tag right before `app.js` (find the existing script tags near the bottom of `<body>`):

```html
  <script src="notifications-data.js"></script>
  <script src="app.js"></script>
```

In `renderer/index.html`, inside `<div id="controls">`, insert the bell/mute markup right before the existing `<button id="refresh-btn" ...>` line:

```html
      <div id="notifications-control">
        <button id="notify-mute-btn" title="Mute notification sound">🔊</button>
        <button id="notify-bell-btn" title="Notifications">
          🔔
          <span id="notify-badge" class="hidden">0</span>
        </button>
        <div id="notify-dropdown" class="hidden">
          <div id="notify-dropdown-empty">No notifications yet</div>
          <div id="notify-dropdown-list"></div>
        </div>
      </div>
```

- [ ] **Step 2: Add styles**

In `renderer/styles.css`, add after the existing `#refresh-btn.spinning { ... }` / `@keyframes refresh-spin` block (end of the header section, before `/* ── Records table ── */`):

```css
#notifications-control { position: relative; display: flex; align-items: center; gap: var(--space-1); }
#notify-mute-btn, #notify-bell-btn { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 16px; padding: var(--space-1) var(--space-2); line-height: 1; position: relative; }
#notify-mute-btn:hover, #notify-bell-btn:hover { color: var(--text-primary); }
#notify-mute-btn.muted { opacity: 0.4; }
#notify-badge { position: absolute; top: -2px; right: -2px; background: var(--accent); color: #0a0a0a; font-size: 9px; font-weight: 700; line-height: 1; padding: 2px 4px; border-radius: 999px; min-width: 14px; text-align: center; }
#notify-dropdown { position: absolute; top: calc(100% + var(--space-2)); right: 0; width: 320px; max-height: 400px; overflow-y: auto; background: var(--bg-surface); border: 1px solid var(--border-strong); border-radius: var(--radius-md); box-shadow: var(--shadow-modal); z-index: 50; }
#notify-dropdown-empty { padding: var(--space-5); color: var(--text-muted); font-size: 12px; text-align: center; }
#notify-dropdown-empty.hidden { display: none; }
.notify-item { display: block; width: 100%; text-align: left; background: none; border: none; border-bottom: 1px solid var(--border); color: var(--text-primary); padding: var(--space-3) var(--space-4); cursor: pointer; font-size: 12px; }
.notify-item:last-child { border-bottom: none; }
.notify-item:hover { background: var(--bg-surface-2); }
.notify-item.read { color: var(--text-muted); }
.notify-item .notify-item-table { color: var(--text-secondary); font-size: 11px; margin-left: var(--space-2); }
.notify-item .notify-item-time { color: var(--text-muted); font-size: 10px; float: right; }
```

- [ ] **Step 3: Add rendering, sound, and mute functions to app.js**

In `renderer/app.js`, replace the existing notifications section header comment and the block from `snapshotSeenIds` through `notifyNewTask` (`renderer/app.js:330-414`) is NOT touched yet in this step — instead, insert a new block directly after the existing `notifyNewTask` function (after `renderer/app.js:414`, right before the `goToRecord` comment):

```js
// ── In-app notification bell ───────────────────────────────────────────
// Runs alongside notifyNewTask's OS banner (unchanged, above) — this adds
// a persistent, sound-backed, in-app history so a missed/dismissed OS
// banner isn't the only record a new task ever existed.

const MUTE_KEY = 'higgtable_notify_muted';
let notifications = [];
let notifyDropdownOpen = false;

function isNotificationsMuted() {
  return localStorage.getItem(MUTE_KEY) === 'true';
}

function toggleMute() {
  const next = !isNotificationsMuted();
  localStorage.setItem(MUTE_KEY, String(next));
  document.getElementById('notify-mute-btn').classList.toggle('muted', next);
  document.getElementById('notify-mute-btn').textContent = next ? '🔇' : '🔊';
}

// Synthesizes a short two-tone chime via the Web Audio API — no bundled
// audio asset to ship or license. No-ops while muted.
function playNotificationSound() {
  if (isNotificationsMuted()) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const now = ctx.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    const start = now + i * 0.09;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.2);
  });
  setTimeout(() => ctx.close(), 500);
}

function renderNotificationBell() {
  const badge = document.getElementById('notify-badge');
  const count = unreadCount(notifications);
  badge.textContent = String(count);
  badge.classList.toggle('hidden', count === 0);
}

function renderNotificationDropdown() {
  const listEl = document.getElementById('notify-dropdown-list');
  const emptyEl = document.getElementById('notify-dropdown-empty');
  emptyEl.classList.toggle('hidden', notifications.length > 0);
  listEl.innerHTML = '';
  notifications.forEach(n => {
    const btn = document.createElement('button');
    btn.className = `notify-item${n.read ? ' read' : ''}`;
    const shortTable = n.tableName.replace(' Creatives', '');
    btn.innerHTML = `<span class="notify-item-time">${new Date(n.timestamp).toLocaleString()}</span>${n.taskName}<span class="notify-item-table">${shortTable}</span>`;
    btn.addEventListener('click', () => {
      const rec = (recordsCache[n.tableName] || []).find(r => r.id === n.recordId);
      if (!rec) {
        btn.innerHTML = '<em>This task is no longer available.</em>';
        return;
      }
      toggleNotificationDropdown();
      goToRecord(rec, n.tableName);
    });
    listEl.appendChild(btn);
  });
}

function toggleNotificationDropdown() {
  notifyDropdownOpen = !notifyDropdownOpen;
  document.getElementById('notify-dropdown').classList.toggle('hidden', !notifyDropdownOpen);
  if (notifyDropdownOpen) {
    notifications = markAllRead(notifications);
    renderNotificationBell();
    renderNotificationDropdown();
  }
}

function addLiveNotification(rec, tableName) {
  notifications = appendNotification(notifications, recordToNotification(rec, tableName, Date.now()));
  renderNotificationBell();
  if (notifyDropdownOpen) renderNotificationDropdown();
  playNotificationSound();
}
```

- [ ] **Step 4: Wire up event listeners**

In `renderer/app.js`, add these lines right after the existing `document.getElementById('columns-btn').addEventListener(...)` line (`renderer/app.js:1728`):

```js
document.getElementById('notify-bell-btn').addEventListener('click', e => {
  e.stopPropagation();
  toggleNotificationDropdown();
});
document.getElementById('notify-mute-btn').addEventListener('click', toggleMute);
document.addEventListener('click', e => {
  if (!notifyDropdownOpen) return;
  if (e.target.closest('#notifications-control')) return;
  toggleNotificationDropdown();
});
```

And initialize the mute button's starting appearance — add this line right before the final `boot();` call (`renderer/app.js:1785`):

```js
if (isNotificationsMuted()) {
  document.getElementById('notify-mute-btn').classList.add('muted');
  document.getElementById('notify-mute-btn').textContent = '🔇';
}
```

- [ ] **Step 5: Manual verification**

Run: `npm start`

In DevTools console (View → Toggle Developer Tools):

```js
addLiveNotification({ id: 'rec_test', fields: { Name: 'Test task' } }, 'VCP Creatives')
```

Expected:
- Bell badge shows "1"
- A chime plays
- Clicking the bell opens the dropdown showing "Test task · VCP" and the badge clears
- Clicking that row shows "This task is no longer available." inline (since `rec_test` isn't a real cached record) instead of navigating or throwing
- Clicking the speaker icon toggles between 🔊/🔇, and re-running the console command above no longer plays a sound while muted
- Clicking outside the dropdown closes it

- [ ] **Step 6: Commit**

```bash
git add renderer/index.html renderer/styles.css renderer/app.js
git commit -m "Add notification bell UI, sound, and mute toggle"
```

---

## Task 3: Persist seen-IDs + notifications, wire live and cold-start detection

**Files:**
- Modify: `renderer/app.js`

**Interfaces:**
- Consumes from Task 1: `diffMissedRecords`, `recordToNotification`, `appendNotificationBatch`
- Consumes from Task 2: `notifications` (module-level array), `renderNotificationBell()`, `renderNotificationDropdown()`, `playNotificationSound()`, `notifyDropdownOpen`
- Consumes from existing app.js: `TARGET_TABLES`, `state.selectedDES`, `recordsCache`, `seenTaskIds`, `snapshotSeenIds()` (`renderer/app.js:332`), `init()` (`renderer/app.js:154`), `pollOneTable()` (`renderer/app.js:370`), `log()`
- Produces: nothing new consumed elsewhere — this is the final wiring task

- [ ] **Step 1: Add persistence constants and helpers**

In `renderer/app.js`, add right after the existing `const POLL_INTERVAL_MS = 5 * 60 * 1000;` line (`renderer/app.js:72`):

```js
const SEEN_IDS_KEY = 'higgtable_seen_ids_v1';
const NOTIFICATIONS_KEY = 'higgtable_notifications_v1';

// Returns { [tableName]: string[] } from the last session, or null if this
// is the first time the app has ever run (nothing persisted yet).
function loadPersistedSeenIds() {
  const raw = localStorage.getItem(SEEN_IDS_KEY);
  return raw ? JSON.parse(raw) : null;
}

function persistSeenIds() {
  const out = {};
  TARGET_TABLES.forEach(name => {
    if (seenTaskIds[name]) out[name] = [...seenTaskIds[name]];
  });
  localStorage.setItem(SEEN_IDS_KEY, JSON.stringify(out));
}

function loadNotifications() {
  const raw = localStorage.getItem(NOTIFICATIONS_KEY);
  return raw ? JSON.parse(raw) : [];
}

function persistNotifications() {
  localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifications));
}
```

- [ ] **Step 2: Load persisted notifications on startup, and render the restored state**

In `renderer/app.js`, change the `let notifications = [];` line added in Task 2 to:

```js
let notifications = loadNotifications();
```

Loading persisted notifications alone isn't enough — if there were unread
entries left over from a session where the dropdown was never opened, the
badge needs to reflect that immediately, not just after the next new
notification. In `renderer/app.js`, add this line right before the final
`boot();` call (`renderer/app.js:1785`), alongside the mute-button
initialization added in Task 2 Step 4:

```js
renderNotificationBell();
```

(`renderNotificationDropdown()` doesn't need an initial call here — the
dropdown itself is hidden until the user opens it, and `toggleNotificationDropdown`
already renders on open.)

- [ ] **Step 3: Persist seen-IDs whenever they're updated**

In `renderer/app.js`, modify `snapshotSeenIds` (`renderer/app.js:332-336`) from:

```js
function snapshotSeenIds() {
  TARGET_TABLES.forEach(name => {
    if (recordsCache[name]) seenTaskIds[name] = new Set(recordsCache[name].map(r => r.id));
  });
}
```

to:

```js
function snapshotSeenIds() {
  TARGET_TABLES.forEach(name => {
    if (recordsCache[name]) seenTaskIds[name] = new Set(recordsCache[name].map(r => r.id));
  });
  persistSeenIds();
}
```

And in `pollOneTable` (`renderer/app.js:396`), change:

```js
  seenTaskIds[name] = new Set(fresh.map(r => r.id));
```

to:

```js
  seenTaskIds[name] = new Set(fresh.map(r => r.id));
  persistSeenIds();
```

- [ ] **Step 4: Record live notifications from the existing poll diff**

In `renderer/app.js`, modify the notify loop inside `pollOneTable` (`renderer/app.js:391-395`) from:

```js
  const prevSeen = seenTaskIds[name];
  if (prevSeen && state.selectedDES) {
    fresh
      .filter(r => !prevSeen.has(r.id) && (r.fields['DES'] || '') === state.selectedDES)
      .forEach(r => notifyNewTask(r, name));
  }
```

to:

```js
  const prevSeen = seenTaskIds[name];
  if (prevSeen && state.selectedDES) {
    fresh
      .filter(r => !prevSeen.has(r.id) && (r.fields['DES'] || '') === state.selectedDES)
      .forEach(r => { notifyNewTask(r, name); addLiveNotification(r, name); });
  }
```

- [ ] **Step 5: Add cold-start catch-up**

In `renderer/app.js`, add this function right after `persistNotifications` (defined in Step 1):

```js
// Surfaces anything assigned while the app was closed: diffs the seen-ID
// set persisted from the last session against what's now in recordsCache,
// per table, using the same DES filter a live poll already applies. Must
// run after tables are loaded (recordsCache populated) but before
// snapshotSeenIds() overwrites the persisted set with the fresh one.
function runColdStartCatchUp() {
  const persisted = loadPersistedSeenIds();
  if (!persisted) return; // first-ever run — no baseline, don't spam

  const missedEntries = TARGET_TABLES.flatMap(name => {
    const fresh = recordsCache[name] || [];
    return diffMissedRecords(persisted[name] || [], fresh, state.selectedDES)
      .map(r => recordToNotification(r, name, Date.now()));
  });
  if (!missedEntries.length) return;

  notifications = appendNotificationBatch(notifications, missedEntries);
  persistNotifications();
  renderNotificationBell();
  playNotificationSound();
  log(`runColdStartCatchUp: ${missedEntries.length} notification(s) for tasks assigned while closed`);
}
```

- [ ] **Step 6: Call it from init()**

In `renderer/app.js`, modify `init()` (`renderer/app.js:181-186`) from:

```js
    await loadTable(state.activeTable);
    log(`init: active table ready (${Date.now() - t0}ms elapsed), preloading the rest in background`);
    await preloadOtherTables();
    log(`init: all tables preloaded, total init took ${Date.now() - t0}ms`);
    snapshotSeenIds();
    startPolling();
    requestNotificationPermission();
```

to:

```js
    await loadTable(state.activeTable);
    log(`init: active table ready (${Date.now() - t0}ms elapsed), preloading the rest in background`);
    await preloadOtherTables();
    log(`init: all tables preloaded, total init took ${Date.now() - t0}ms`);
    runColdStartCatchUp();
    snapshotSeenIds();
    startPolling();
    requestNotificationPermission();
```

- [ ] **Step 7: Manual verification**

Run: `npm start`, with a DES selected in the "You:" dropdown.

**Cold-start catch-up:**
1. In DevTools console, inspect `localStorage.getItem('higgtable_seen_ids_v1')` to confirm it's now populated after a normal run.
2. In Airtable's web UI, create (or reassign) a task with `DES` set to your selected value.
3. Quit and relaunch HiggTable (don't wait for the 5-minute poll first).
4. Expected: bell badge shows the new count, exactly one chime plays, opening the dropdown shows the new task, clicking it navigates to and highlights the row via `goToRecord`.

**Live update (existing poll path, now also recording in-app):**
1. With the app open and idle, create another task assigned to your DES in Airtable.
2. In DevTools console, run `pollForUpdates()` directly rather than waiting 5 minutes.
3. Expected: the existing OS notification banner appears (unchanged), a chime plays, and the bell badge/dropdown also pick up the new entry.

**Persistence across restarts:**
1. After either scenario above, quit and relaunch with no new tasks.
2. Expected: bell badge shows 0 (nothing new), but opening the dropdown still shows the earlier notification(s), rendered as read (dimmed).

**First-run safety:**
1. In DevTools console, run `localStorage.removeItem('higgtable_seen_ids_v1'); localStorage.removeItem('higgtable_notifications_v1')` then reload the app (Cmd/Ctrl+R).
2. Expected: no catch-up notifications or sound fire on this reload, even though every currently-loaded record is "new" relative to the now-empty storage — matches the first-ever-run behavior in `runColdStartCatchUp`.

- [ ] **Step 8: Commit**

```bash
git add renderer/app.js
git commit -m "Persist seen-IDs and notifications, wire live and cold-start detection"
```
