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
    computeDeadlineUrgency,
    diffMissedRecords,
    appendNotification,
    appendNotificationBatch,
    unreadCount,
    markAllRead,
  };
}
