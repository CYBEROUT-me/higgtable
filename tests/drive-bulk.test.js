const { classifyBulkResult, summarizeBulkRun } = require('../renderer/drive-bulk');

test('classifyBulkResult reads the outcome of one task', () => {
  expect(classifyBulkResult({ task: 'A', folderUrl: 'u' })).toBe('delivered');
  expect(classifyBulkResult({ task: 'A', skipped: 'no local folder' })).toBe('skipped');
  expect(classifyBulkResult({ task: 'A', error: 'boom' })).toBe('failed');
});

test('classifyBulkResult treats a missing outcome as failed rather than success', () => {
  expect(classifyBulkResult({ task: 'A' })).toBe('failed');
});

test('summarizeBulkRun counts each category', () => {
  const s = summarizeBulkRun([
    { task: 'A', folderUrl: 'u1' },
    { task: 'B', skipped: 'no Drive folder configured for code QQ' },
    { task: 'C', error: 'upload stalled' },
    { task: 'D', folderUrl: 'u2' },
  ]);
  expect(s.delivered).toBe(2);
  expect(s.skipped).toBe(1);
  expect(s.failed).toBe(1);
});

test('summarizeBulkRun lists every task with its reason', () => {
  const s = summarizeBulkRun([
    { task: 'A', folderUrl: 'u1' },
    { task: 'B', skipped: 'no local folder' },
    { task: 'C', error: 'upload stalled' },
  ]);
  expect(s.lines).toEqual([
    'OK    A',
    'SKIP  B — no local folder',
    'FAIL  C — upload stalled',
  ]);
});

test('summarizeBulkRun handles an empty run', () => {
  expect(summarizeBulkRun([])).toEqual({ delivered: 0, skipped: 0, failed: 0, lines: [] });
});
