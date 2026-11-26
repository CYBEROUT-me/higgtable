// tests/drive-index.test.js
const {
  normalizeTaskName, taskCode, monthFolder, monthsToSearch, countCodes, codeMapFromCounts,
  matchTaskFolders, driveFolderLink, folderIdFromInput,
} = require('../renderer/drive-index');

test('normalizeTaskName folds Cyrillic look-alikes, spaces and case', () => {
  expect(normalizeTaskName(' LO_7501_7500_М60_S0_EN_usr_I2_FER_Stat_VAR_9x16'))
    .toBe('LO_7501_7500_M60_S0_EN_USR_I2_FER_STAT_VAR_9X16');
  expect(normalizeTaskName('LO_10000_9999_А0_S0')).toBe(normalizeTaskName('LO_10000_9999_A0_S0'));
  expect(normalizeTaskName(null)).toBe('');
});

test('taskCode', () => {
  expect(taskCode('LiV_1_1_EN')).toBe('LIV');
  expect(taskCode(' OL_5_5')).toBe('OL');
  expect(taskCode('nothing')).toBeNull();
});

test('monthFolder and monthsToSearch', () => {
  expect(monthFolder('2026-11')).toEqual({ year: '2026', folder: '11_November' });
  expect(monthFolder('2026-13')).toBeNull();
  expect(monthsToSearch('2026-11-26', ['2026-11-02', '2026-09-30', null])).toEqual(['2026-11', '2026-10', '2026-09']);
  expect(monthsToSearch('2026-01-03', [])).toEqual(['2026-01', '2025-12']);
  expect(monthsToSearch('2026-11-26', ['2026-08-01', '2026-07-01'], 3)).toEqual(['2026-11', '2026-10', '2026-08']);
});

test('the code map follows where most of a code lives', () => {
  const counts = {};
  countCodes('Lowins_creatives', ['LO_1_1', 'LO_2_1', 'CMC_1431_212'], counts);
  countCodes('Call Me Chat_creatives', ['CMC_1_1', 'CMC_2_1'], counts);
  countCodes('Liveinvibe_creatives', ['LiV_9_9', 'junk'], counts);
  expect(codeMapFromCounts(counts)).toEqual({
    LO: 'Lowins_creatives', CMC: 'Call Me Chat_creatives', LIV: 'Liveinvibe_creatives',
  });
});

test('matchTaskFolders finds folders by name across listings, newest first', () => {
  const listings = [
    { path: 'Lowins_creatives/2026/11_November', entries: [
      { Name: 'LO_1_1_М0_EN_9x16', ID: 'a', ModTime: '2026-11-02T10:00:00Z' },
      { Name: 'LO_2_1_M0_EN_9x16', ID: 'b', ModTime: '2026-11-03T10:00:00Z' },
    ] },
    { path: 'Lowins_creatives/2026/10_October', entries: [
      { Name: 'LO_2_1_M0_EN_9x16', ID: 'c', ModTime: '2026-10-30T10:00:00Z' },
    ] },
  ];
  const r = matchTaskFolders(['LO_1_1_M0_EN_9x16', 'LO_2_1_M0_EN_9x16', 'LO_3_1'], listings);
  expect(r['LO_1_1_M0_EN_9x16']).toEqual([{ id: 'a', path: 'Lowins_creatives/2026/11_November/LO_1_1_М0_EN_9x16', modTime: '2026-11-02T10:00:00Z' }]);
  expect(r['LO_2_1_M0_EN_9x16'].map(h => h.id)).toEqual(['b', 'c']);
  expect(r['LO_3_1']).toEqual([]);
});

test('links and pasted folder URLs', () => {
  expect(driveFolderLink('X1')).toBe('https://drive.google.com/drive/folders/X1');
  expect(folderIdFromInput('https://drive.google.com/drive/folders/1Q_nNe7i5Kw?usp=drive_link')).toBe('1Q_nNe7i5Kw');
  expect(folderIdFromInput('https://drive.google.com/drive/u/2/folders/1AbCdEfGhIjK')).toBe('1AbCdEfGhIjK');
  expect(folderIdFromInput('https://drive.google.com/file/d/1AbC/view')).toBeNull();
});
