// tests/airtable.test.js
const { fetchBases, fetchTables, fetchRecords } = require('../airtable');

global.fetch = jest.fn();
afterEach(() => jest.clearAllMocks());

test('fetchBases returns bases array', async () => {
  global.fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ bases: [{ id: 'appXXX', name: 'Test Base' }] })
  });
  const result = await fetchBases('fakekey');
  expect(result).toEqual([{ id: 'appXXX', name: 'Test Base' }]);
  expect(fetch).toHaveBeenCalledWith(
    'https://api.airtable.com/v0/meta/bases',
    expect.objectContaining({ headers: { Authorization: 'Bearer fakekey' } })
  );
});

test('fetchBases throws on non-ok response', async () => {
  global.fetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' });
  await expect(fetchBases('badkey')).rejects.toThrow('Airtable error: 401 Unauthorized');
});

test('fetchTables returns tables array', async () => {
  global.fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ tables: [{ id: 'tblXXX', name: 'Tasks', fields: [{ name: 'Name' }] }] })
  });
  const result = await fetchTables('fakekey', 'appXXX');
  expect(result).toEqual([{ id: 'tblXXX', name: 'Tasks', fields: [{ name: 'Name' }] }]);
  expect(fetch).toHaveBeenCalledWith(
    'https://api.airtable.com/v0/meta/bases/appXXX/tables',
    expect.objectContaining({ headers: { Authorization: 'Bearer fakekey' } })
  );
});

test('fetchRecords handles pagination', async () => {
  global.fetch
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ records: [{ id: 'recA', fields: { Name: 'Task A' } }], offset: 'page2' })
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ records: [{ id: 'recB', fields: { Name: 'Task B' } }] })
    });
  const result = await fetchRecords('fakekey', 'appXXX', 'tblXXX');
  expect(result).toHaveLength(2);
  expect(result[0].id).toBe('recA');
  expect(result[1].id).toBe('recB');
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('fetchRecords throws on non-ok response', async () => {
  global.fetch.mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden' });
  await expect(fetchRecords('fakekey', 'appXXX', 'tblXXX')).rejects.toThrow('Airtable error: 403 Forbidden');
});

// The concurrency cap must cover the BODY download, not just the headers.
// fetch() resolves on headers, so releasing the slot there let an unbounded
// number of bodies stream at once — the cap capped nothing that mattered.
test('the request cap limits concurrent body reads, not just headers', async () => {
  let inFlightBodies = 0;
  let peak = 0;
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => {
      inFlightBodies += 1;
      peak = Math.max(peak, inFlightBodies);
      await new Promise(r => setTimeout(r, 20));
      inFlightBodies -= 1;
      return { records: [] };
    },
  }));
  await Promise.all(Array.from({ length: 8 }, () => fetchRecords('key', 'base', 'table')));
  expect(peak).toBeLessThanOrEqual(3);
});
