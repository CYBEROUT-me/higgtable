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
