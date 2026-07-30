const { computeHoursByDesigner } = require('../renderer/dashboard-data');

test('sums and averages hours per designer, sorted by total descending', () => {
  const result = computeHoursByDesigner([
    { des: 'Alice', hours: 2 },
    { des: 'Alice', hours: 4 },
    { des: 'Bob', hours: 10 },
  ]);
  expect(result.rows).toEqual([
    { des: 'Bob', totalHours: 10, avgHours: 10 },
    { des: 'Alice', totalHours: 6, avgHours: 3 },
  ]);
});

test('excludes blank/non-numeric hours from both the sum and the average denominator', () => {
  const result = computeHoursByDesigner([
    { des: 'Alice', hours: 5 },
    { des: 'Alice', hours: undefined },
    { des: 'Alice', hours: null },
  ]);
  expect(result.rows).toEqual([{ des: 'Alice', totalHours: 5, avgHours: 5 }]);
});

test('a designer with zero logged hours gets totalHours 0 and avgHours null', () => {
  const result = computeHoursByDesigner([{ des: 'Alice', hours: undefined }]);
  expect(result.rows).toEqual([{ des: 'Alice', totalHours: 0, avgHours: null }]);
});

test('grand total average is weighted across all entries, not an average of per-designer averages', () => {
  const result = computeHoursByDesigner([
    { des: 'Alice', hours: 10 },
    { des: 'Bob', hours: 1 },
    { des: 'Bob', hours: 1 },
    { des: 'Bob', hours: 1 },
  ]);
  // Naive average-of-averages would be (10 + 1) / 2 = 5.5 — wrong.
  // Correct weighted average is (10 + 1 + 1 + 1) / 4 = 3.25.
  expect(result.totalHours).toBe(13);
  expect(result.avgHours).toBe(3.25);
});

test('empty input returns empty rows and null grand average', () => {
  const result = computeHoursByDesigner([]);
  expect(result).toEqual({ rows: [], totalHours: 0, avgHours: null });
});
