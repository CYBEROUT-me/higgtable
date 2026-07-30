const { computeHoursByDesigner, parseHoursValue } = require('../renderer/dashboard-data');

test('parseHoursValue converts an Airtable Duration "H:MM" string to decimal hours', () => {
  expect(parseHoursValue('01:00')).toBe(1);
  expect(parseHoursValue('00:15')).toBe(0.25);
  expect(parseHoursValue('00:30')).toBe(0.5);
  expect(parseHoursValue('00:45')).toBe(0.75);
  expect(parseHoursValue('02:00')).toBe(2);
});

test('parseHoursValue passes plain finite numbers through unchanged', () => {
  expect(parseHoursValue(3)).toBe(3);
  expect(parseHoursValue(0)).toBe(0);
});

test('parseHoursValue returns undefined for blank, non-numeric, or unparseable values', () => {
  expect(parseHoursValue(undefined)).toBeUndefined();
  expect(parseHoursValue(null)).toBeUndefined();
  expect(parseHoursValue('')).toBeUndefined();
  expect(parseHoursValue('not a duration')).toBeUndefined();
  expect(parseHoursValue(NaN)).toBeUndefined();
});

test('computeHoursByDesigner correctly aggregates real Airtable Duration-string data', () => {
  // Mirrors the real bug: Hours arrives as "H:MM" strings, plus a blank
  // (undefined) entry for a record with nothing logged.
  const result = computeHoursByDesigner([
    { des: 'POL', hours: '01:00' },
    { des: 'POL', hours: '00:30' },
    { des: 'JUP', hours: '02:00' },
    { des: 'JUP', hours: undefined },
  ]);
  expect(result.rows).toEqual([
    { des: 'JUP', totalHours: 2, avgHours: 2 },
    { des: 'POL', totalHours: 1.5, avgHours: 0.75 },
  ]);
});

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
