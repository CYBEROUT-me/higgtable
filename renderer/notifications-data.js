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
