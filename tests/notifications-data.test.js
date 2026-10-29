// tests/notifications-data.test.js
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
    expect(r.priority).toBe('High');
    expect(r.deadline).toBe('2026-08-01');
    expect(r.urgency).toBeNull();
    expect(r.isUrgent).toBe(false);
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

const {
  daysUntilDeadline,
  deadlineAlertKey,
  findDeadlineAlerts,
  recordToDeadlineAlert,
  deadlineAlertLabel,
  pruneDeadlineAlertKeys,
} = require('../renderer/notifications-data');

test('daysUntilDeadline counts whole local days, across a month end', () => {
  expect(daysUntilDeadline('2026-11-01', '2026-10-30')).toBe(2);
  expect(daysUntilDeadline('2026-10-30', '2026-10-30')).toBe(0);
  expect(daysUntilDeadline('2026-10-29', '2026-10-30')).toBe(-1);
});

test('findDeadlineAlerts picks the designer\'s unfinished tasks due in 1-2 days, once', () => {
  const today = '2026-10-29';
  const records = [
    rec('a', { DES: 'Ann', Deadline: '2026-10-30', Status: 'In work' }),
    rec('b', { DES: 'Ann', Deadline: '2026-10-31', Status: 'Ready for Design' }),
    rec('c', { DES: 'Ann', Deadline: '2026-11-01', Status: 'In work' }),
    rec('d', { DES: 'Ann', Deadline: '2026-10-29', Status: 'In work' }),
    rec('e', { DES: 'Ann', Deadline: '2026-10-30', Status: 'To accept' }),
    rec('f', { DES: 'Ann', Deadline: '2026-10-30', Status: 'Done' }),
    rec('g', { DES: 'Bob', Deadline: '2026-10-30', Status: 'In work' }),
    rec('h', { DES: 'Ann', Status: 'In work' }),
  ];
  const found = findDeadlineAlerts(records, 'VCP Creatives', 'Ann', today, new Set());
  expect(found.map(f => [f.rec.id, f.daysAway])).toEqual([['a', 1], ['b', 2]]);
  expect(found[0].key).toBe(deadlineAlertKey('VCP Creatives', 'a', '2026-10-30'));

  const alerted = new Set(found.map(f => f.key));
  expect(findDeadlineAlerts(records, 'VCP Creatives', 'Ann', today, alerted)).toEqual([]);
  expect(findDeadlineAlerts(records, 'VCP Creatives', '', today, new Set())).toEqual([]);
});

test('findDeadlineAlerts alerts again when the deadline moves', () => {
  const alerted = new Set([deadlineAlertKey('VCP Creatives', 'a', '2026-10-30')]);
  const moved = [rec('a', { DES: 'Ann', Deadline: '2026-10-31', Status: 'In work' })];
  expect(findDeadlineAlerts(moved, 'VCP Creatives', 'Ann', '2026-10-29', alerted)).toHaveLength(1);
});

test('recordToDeadlineAlert marks the entry as a deadline alert', () => {
  const entry = recordToDeadlineAlert(rec('a', { Name: 'T', Deadline: '2026-10-30' }), 'VCP Creatives', 5, 1);
  expect(entry).toMatchObject({ id: 'deadline:VCP Creatives:a:5', kind: 'deadline', daysAway: 1, recordId: 'a', deadline: '2026-10-30', read: false });
});

test('deadlineAlertLabel describes the live deadline', () => {
  expect(deadlineAlertLabel('2026-10-31', '2026-10-29')).toBe('Due in 2 days');
  expect(deadlineAlertLabel('2026-10-30', '2026-10-29')).toBe('Due tomorrow');
  expect(deadlineAlertLabel('2026-10-29', '2026-10-29')).toBe('Due today');
  expect(deadlineAlertLabel('2026-10-28', '2026-10-29')).toBe('Overdue');
  expect(deadlineAlertLabel(null, '2026-10-29')).toBeNull();
});

test('pruneDeadlineAlertKeys drops keys whose deadline has passed', () => {
  const keys = ['T|a|2026-10-28', 'T|b|2026-10-29', 'T|c|2026-10-31'];
  expect(pruneDeadlineAlertKeys(keys, '2026-10-29')).toEqual(['T|b|2026-10-29', 'T|c|2026-10-31']);
});
