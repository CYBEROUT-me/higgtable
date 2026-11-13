const {
  RECORDS_CACHE_VERSION, SYNC_OVERLAP_MS, FULL_SYNC_EVERY_MS, mergeChangedRecords, incrementalSince, usableCache,
} = require('../renderer/records-sync');

describe('mergeChangedRecords', () => {
  test('updates existing records in place and puts new ones first, newest first', () => {
    const a = { id: 'a', fields: { Status: 'In work' } };
    const b = { id: 'b', fields: { Status: 'In work' } };
    const list = [b, a];
    const { records, added } = mergeChangedRecords(list, [
      { id: 'a', fields: { Status: 'Done' } },
      { id: 'c', fields: {} }, // created first
      { id: 'd', fields: {} }, // created last → newest
    ]);
    expect(records).toBe(list);
    expect(records.map(r => r.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(records[3]).toBe(a);
    expect(a.fields.Status).toBe('Done');
    expect(added.map(r => r.id)).toEqual(['c', 'd']);
  });

  test('no changes leaves the list alone', () => {
    const list = [{ id: 'a', fields: {} }];
    expect(mergeChangedRecords(list, []).added).toEqual([]);
    expect(list).toHaveLength(1);
  });
});

describe('incrementalSince', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  test('asks from the last sync minus an overlap', () => {
    const meta = { syncedAt: now - 5 * 60000, fullSyncedAt: now - 60 * 60000 };
    expect(incrementalSince(meta, now)).toBe(new Date(meta.syncedAt - SYNC_OVERLAP_MS).toISOString());
  });
  test('a full download is due when there is no sync yet or the last full one is old', () => {
    expect(incrementalSince(null, now)).toBeNull();
    expect(incrementalSince({ syncedAt: now, fullSyncedAt: now - FULL_SYNC_EVERY_MS - 1 }, now)).toBeNull();
  });
});

describe('usableCache', () => {
  const ok = { v: RECORDS_CACHE_VERSION, tableId: 'tbl1', records: [], syncedAt: 1, fullSyncedAt: 1 };
  test('accepts this format for this table only', () => {
    expect(usableCache(ok, 'tbl1')).toBe(true);
    expect(usableCache(ok, 'tbl2')).toBe(false);
    expect(usableCache({ ...ok, v: 0 }, 'tbl1')).toBe(false);
    expect(usableCache(null, 'tbl1')).toBe(false);
  });
});
