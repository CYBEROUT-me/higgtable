// tests/workload-data.test.js
const { WORKLOAD_UNASSIGNED, computeWorkload, listWorkloadProducts } = require('../renderer/workload-data');

function rec(fields) { return { id: Math.random().toString(36), fields }; }

const sources = [
  { tableName: 'VCP Creatives', records: [
    rec({ DES: 'Ann', Status: 'In work', Priority: 'High', Project: 'OL' }),
    rec({ DES: 'Ann', Status: 'Ready for Design', Priority: 'Low', Project: 'TL' }),
    rec({ DES: 'Bob', Status: 'In work', Project: 'OL' }),
    rec({ DES: 'Bob', Status: 'Done', Priority: 'High', Project: 'OL' }),
    rec({ DES: 'Bob', Status: 'To accept', Project: 'OL' }),
    rec({ DES: 'Bob', Status: 'Backlog', Project: 'OL' }),
    rec({ Status: 'In work', Priority: 'High', Project: 'OL' }),
  ] },
  { tableName: 'PLM Creatives', records: [
    rec({ DES: 'Bob', Status: 'In work', Priority: 'High', Project: 'PL' }),
    rec({ DES: 'Bob', Status: 'Ready for Design', Project: 'PL' }),
  ] },
];

test('computeWorkload counts open tasks and High ones per designer across all tables', () => {
  const { rows, totals } = computeWorkload(sources);
  expect(rows.map(r => [r.des, r.open, r.high])).toEqual([
    ['Bob', 3, 1],
    ['Ann', 2, 1],
    [WORKLOAD_UNASSIGNED, 1, 1],
  ]);
  expect(rows[0].statuses).toEqual({ 'Ready for Design': 1, 'In work': 2 });
  expect(totals).toEqual({ open: 6, high: 3, statuses: { 'Ready for Design': 2, 'In work': 4 } });
});

test('computeWorkload filters to one table', () => {
  const { rows } = computeWorkload(sources, { table: 'PLM Creatives' });
  expect(rows.map(r => [r.des, r.open, r.high])).toEqual([['Bob', 2, 1]]);
});

test('computeWorkload filters to one product (Project)', () => {
  const { rows } = computeWorkload(sources, { product: 'OL' });
  expect(rows.map(r => [r.des, r.open, r.high])).toEqual([
    ['Ann', 1, 1],
    ['Bob', 1, 0],
    [WORKLOAD_UNASSIGNED, 1, 1],
  ]);
});

test('computeWorkload returns empty rows and zero totals with no open work', () => {
  expect(computeWorkload([{ tableName: 'X', records: null }])).toEqual({
    rows: [], totals: { open: 0, high: 0, statuses: { 'Ready for Design': 0, 'In work': 0 } },
  });
});

test('listWorkloadProducts lists Project values, optionally for one table', () => {
  expect(listWorkloadProducts(sources)).toEqual(['OL', 'PL', 'TL']);
  expect(listWorkloadProducts(sources, 'PLM Creatives')).toEqual(['PL']);
});
