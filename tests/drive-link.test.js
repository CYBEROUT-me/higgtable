const {
  planLinkRun, matchTasksToFolders, monthSearchOrder,
  classifyPeriodFolders, yearSearchOrder,
} = require('../renderer/drive-link');

const cand = (over = {}) => ({
  recordId: 'rec1', taskName: 'HC_1952_Stat_NEW_9x16',
  code: 'HC', appFolderId: 'appHC', existingLink: '', ...over,
});

describe('planLinkRun', () => {
  test('plans a task whose app folder is configured', () => {
    const r = planLinkRun({ candidates: [cand()], testFolderId: '', testMode: false });
    expect(r.plans).toEqual([{ recordId: 'rec1', taskName: 'HC_1952_Stat_NEW_9x16', destFolderId: 'appHC' }]);
    expect(r.skipped).toEqual([]);
  });

  test('skips an unconfigured app code and names it', () => {
    const r = planLinkRun({ candidates: [cand({ code: 'ZZ', appFolderId: null })], testFolderId: '', testMode: false });
    expect(r.plans).toEqual([]);
    expect(r.skipped).toEqual([{ taskName: 'HC_1952_Stat_NEW_9x16', reason: 'no Drive folder configured for "ZZ"' }]);
  });

  test('reports a missing app code as "?" rather than guessing', () => {
    const r = planLinkRun({ candidates: [cand({ code: '', appFolderId: null })], testFolderId: '', testMode: false });
    expect(r.skipped[0].reason).toBe('no Drive folder configured for "?"');
  });

  test('skips a task that already has a Creative Link', () => {
    const r = planLinkRun({ candidates: [cand({ existingLink: 'https://drive.google.com/drive/folders/x' })], testFolderId: '', testMode: false });
    expect(r.plans).toEqual([]);
    expect(r.skipped).toEqual([{ taskName: 'HC_1952_Stat_NEW_9x16', reason: 'already has a Creative Link' }]);
  });

  test('treats a whitespace-only Creative Link as empty', () => {
    const r = planLinkRun({ candidates: [cand({ existingLink: '   ' })], testFolderId: '', testMode: false });
    expect(r.plans).toHaveLength(1);
  });

  test('test mode redirects every plan to the test folder', () => {
    const r = planLinkRun({
      candidates: [cand(), cand({ recordId: 'rec2', code: 'PL', appFolderId: 'appPL' })],
      testFolderId: 'testF', testMode: true,
    });
    expect(r.plans.map(p => p.destFolderId)).toEqual(['testF', 'testF']);
  });

  test('test mode still skips unconfigured codes', () => {
    const r = planLinkRun({ candidates: [cand({ code: 'ZZ', appFolderId: null })], testFolderId: 'testF', testMode: true });
    expect(r.plans).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });

  test('returns empty results for no candidates', () => {
    expect(planLinkRun({ candidates: [], testFolderId: '', testMode: false })).toEqual({ plans: [], skipped: [] });
  });
});

describe('matchTasksToFolders', () => {
  const items = [
    { id: 'f1', name: 'HC_1952_Stat_NEW_9x16', isFolder: true },
    { id: 'f2', name: 'HC_1953_Stat_VAR_9x16', isFolder: true },
    { id: 'x1', name: 'HC_1954_Stat_VAR_9x16', isFolder: false },
  ];

  test('matches exactly and reports the rest as unmatched', () => {
    const r = matchTasksToFolders(['HC_1952_Stat_NEW_9x16', 'HC_9999_Stat_NEW_9x16'], items);
    expect(r.matched).toEqual({ HC_1952_Stat_NEW_9x16: 'f1' });
    expect(r.unmatched).toEqual(['HC_9999_Stat_NEW_9x16']);
    expect(r.duplicates).toEqual([]);
  });

  test('ignores files, matching only folders', () => {
    const r = matchTasksToFolders(['HC_1954_Stat_VAR_9x16'], items);
    expect(r.matched).toEqual({});
    expect(r.unmatched).toEqual(['HC_1954_Stat_VAR_9x16']);
  });

  test('never matches on a prefix', () => {
    const r = matchTasksToFolders(['HC_1952_Stat'], items);
    expect(r.unmatched).toEqual(['HC_1952_Stat']);
  });

  test('reports duplicates instead of picking one', () => {
    const dup = [...items, { id: 'f9', name: 'HC_1952_Stat_NEW_9x16', isFolder: true }];
    const r = matchTasksToFolders(['HC_1952_Stat_NEW_9x16'], dup);
    expect(r.matched).toEqual({});
    expect(r.duplicates).toEqual(['HC_1952_Stat_NEW_9x16']);
    expect(r.unmatched).toEqual([]);
  });

  test('handles an empty listing', () => {
    const r = matchTasksToFolders(['HC_1952_Stat_NEW_9x16'], []);
    expect(r.matched).toEqual({});
    expect(r.unmatched).toEqual(['HC_1952_Stat_NEW_9x16']);
  });

  test('a folder and a file sharing a name is not a duplicate', () => {
    const mixed = [
      { id: 'f1', name: 'HC_1952_Stat_NEW_9x16', isFolder: true },
      { id: 'x9', name: 'HC_1952_Stat_NEW_9x16', isFolder: false },
    ];
    const r = matchTasksToFolders(['HC_1952_Stat_NEW_9x16'], mixed);
    expect(r.matched).toEqual({ HC_1952_Stat_NEW_9x16: 'f1' });
    expect(r.duplicates).toEqual([]);
  });
});

describe('monthSearchOrder', () => {
  const items = [
    { id: 'm7', name: '07_July', isFolder: true },
    { id: 'm8', name: '08_August', isFolder: true },
    { id: 'm6', name: '06_June', isFolder: true },
    { id: 'file', name: 'notes.txt', isFolder: false },
  ];

  test('puts the current month first, then the rest newest-first', () => {
    expect(monthSearchOrder(items, '08_August')).toEqual([
      { id: 'm8', name: '08_August' },
      { id: 'm7', name: '07_July' },
      { id: 'm6', name: '06_June' },
    ]);
  });

  test('omits files', () => {
    expect(monthSearchOrder(items, '08_August').some(f => f.name === 'notes.txt')).toBe(false);
  });

  test('still returns every folder when the current month is absent', () => {
    expect(monthSearchOrder(items, '12_December').map(f => f.name)).toEqual(['08_August', '07_July', '06_June']);
  });

  test('returns an empty list for an empty listing', () => {
    expect(monthSearchOrder([], '08_August')).toEqual([]);
  });
});

describe('classifyPeriodFolders', () => {
  const items = [
    { id: 'y6', name: '2026', isFolder: true },
    { id: 'y5', name: '2025', isFolder: true },
    { id: 'm8', name: '08_August', isFolder: true },
    { id: 'junk', name: 'Archive', isFolder: true },
    { id: 'f1', name: '2026', isFolder: false },
  ];

  test('separates year folders from month folders', () => {
    const r = classifyPeriodFolders(items);
    expect(r.years).toEqual([{ id: 'y6', name: '2026' }, { id: 'y5', name: '2025' }]);
    expect(r.months).toEqual([{ id: 'm8', name: '08_August' }]);
  });

  test('ignores folders that are neither a year nor a month', () => {
    expect(classifyPeriodFolders(items).years.some(y => y.name === 'Archive')).toBe(false);
    expect(classifyPeriodFolders(items).months.some(m => m.name === 'Archive')).toBe(false);
  });

  test('ignores files even when they look like a year', () => {
    expect(classifyPeriodFolders(items).years).toHaveLength(2);
  });

  test('does not treat a five-digit name as a year', () => {
    expect(classifyPeriodFolders([{ id: 'x', name: '20265', isFolder: true }]).years).toEqual([]);
  });

  test('handles an empty listing', () => {
    expect(classifyPeriodFolders([])).toEqual({ years: [], months: [] });
  });
});

describe('yearSearchOrder', () => {
  const years = [{ id: 'y4', name: '2024' }, { id: 'y6', name: '2026' }, { id: 'y5', name: '2025' }];

  test('puts the current year first, then the rest newest-first', () => {
    expect(yearSearchOrder(years, 2025).map(y => y.name)).toEqual(['2025', '2026', '2024']);
  });

  test('accepts the current year as a string', () => {
    expect(yearSearchOrder(years, '2026').map(y => y.name)).toEqual(['2026', '2025', '2024']);
  });

  test('still returns every year when the current one is absent', () => {
    expect(yearSearchOrder(years, 2030).map(y => y.name)).toEqual(['2026', '2025', '2024']);
  });

  test('handles an empty list', () => {
    expect(yearSearchOrder([], 2026)).toEqual([]);
  });
});
