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
    priority: rec.fields['Priority'] || null,
    deadline: rec.fields['Deadline'] || null,
  };
}

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

// ── Deadline alerts ─────────────────────────────────────────────────────
// A task whose Deadline is this many days away raises a one-off alert.
const DEADLINE_ALERT_DAYS = [1, 2];

// Whole days from `today` to `deadline` (both YYYY-MM-DD), local dates. Rounded
// because a DST change makes one day 23 or 25 hours long.
function daysUntilDeadline(deadline, today) {
  const ms = new Date(`${deadline}T00:00:00`) - new Date(`${today}T00:00:00`);
  return Math.round(ms / 86400000);
}

// One alert per task per deadline: moving the deadline makes a new key, so the
// task can alert again for its new date.
function deadlineAlertKey(tableName, recordId, deadline) {
  return `${tableName}|${recordId}|${deadline}`;
}

// The selected designer's unfinished tasks due in 1-2 days that have not
// alerted yet. `alertedKeys` is a Set of deadlineAlertKey values.
function findDeadlineAlerts(records, tableName, des, today, alertedKeys) {
  if (!des) return [];
  const out = [];
  (records || []).forEach(rec => {
    const deadline = rec.fields['Deadline'];
    if (!deadline || (rec.fields['DES'] || '') !== des) return;
    if (COMPLETED_STATUSES.includes(rec.fields['Status'] || '')) return;
    const daysAway = daysUntilDeadline(deadline, today);
    if (!DEADLINE_ALERT_DAYS.includes(daysAway)) return;
    const key = deadlineAlertKey(tableName, rec.id, deadline);
    if (alertedKeys.has(key)) return;
    out.push({ rec, tableName, daysAway, key });
  });
  return out;
}

// A deadline alert is an ordinary notification marked `kind: 'deadline'`, so
// the bell list, unread count and click-through all work unchanged.
function recordToDeadlineAlert(rec, tableName, now, daysAway) {
  return {
    ...recordToNotification(rec, tableName, now),
    id: `deadline:${tableName}:${rec.id}:${now}`,
    kind: 'deadline',
    daysAway,
  };
}

// Label for a deadline alert, from the live deadline so it stays right as days
// pass: "Due in 2 days", "Due tomorrow", "Due today", "Overdue".
function deadlineAlertLabel(deadline, today) {
  if (!deadline) return null;
  const d = daysUntilDeadline(deadline, today);
  if (d < 0) return 'Overdue';
  if (d === 0) return 'Due today';
  if (d === 1) return 'Due tomorrow';
  return `Due in ${d} days`;
}

// Drops keys whose deadline has passed, so the persisted list stays small.
function pruneDeadlineAlertKeys(keys, today) {
  return keys.filter(k => (k.split('|').pop() || '') >= today);
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
    COMPLETED_STATUSES,
    recordToNotification,
    computeDeadlineUrgency,
    resolveNotificationBadges,
    diffMissedRecords,
    appendNotification,
    appendNotificationBatch,
    unreadCount,
    markAllRead,
    DEADLINE_ALERT_DAYS,
    daysUntilDeadline,
    deadlineAlertKey,
    findDeadlineAlerts,
    recordToDeadlineAlert,
    deadlineAlertLabel,
    pruneDeadlineAlertKeys,
  };
}
