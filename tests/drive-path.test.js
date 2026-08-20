const {
  appCodeFromTaskName,
  monthFolderName,
  resolveAppFolderId,
  parseFolderIdFromUrl,
  partitionUploadFiles,
} = require('../renderer/drive-path');

test('appCodeFromTaskName takes the first underscore-separated token', () => {
  expect(appCodeFromTaskName('CMC_1427_1426_A0_S0_EN_usr_ALB_JUP_Video_VAR_9x16')).toBe('CMC');
  expect(appCodeFromTaskName('LO_12955_12955_A85_S1492_EN_usr_ARI_PRI_Video_VAR_9x16')).toBe('LO');
  expect(appCodeFromTaskName('LV_1961_1957_A0_S0_EN_usr_ALB_PRI_Stat_VAR_9x16')).toBe('LV');
});

test('appCodeFromTaskName returns null for unusable names', () => {
  expect(appCodeFromTaskName('')).toBeNull();
  expect(appCodeFromTaskName(null)).toBeNull();
  expect(appCodeFromTaskName(undefined)).toBeNull();
  expect(appCodeFromTaskName('NoUnderscores')).toBeNull();
  expect(appCodeFromTaskName('_leadingUnderscore')).toBeNull();
});

test('monthFolderName formats as zero-padded number + English month name', () => {
  expect(monthFolderName('2026-08-19')).toBe('08_August');
  expect(monthFolderName('2026-01-01')).toBe('01_January');
  expect(monthFolderName('2026-12-31')).toBe('12_December');
});

test('monthFolderName covers all twelve months', () => {
  const expected = [
    '01_January', '02_February', '03_March', '04_April', '05_May', '06_June',
    '07_July', '08_August', '09_September', '10_October', '11_November', '12_December',
  ];
  expected.forEach((label, i) => {
    const mm = String(i + 1).padStart(2, '0');
    expect(monthFolderName(`2026-${mm}-15`)).toBe(label);
  });
});

test('monthFolderName returns null for malformed input', () => {
  expect(monthFolderName('')).toBeNull();
  expect(monthFolderName(null)).toBeNull();
  expect(monthFolderName('2026-13-01')).toBeNull();
  expect(monthFolderName('2026-00-01')).toBeNull();
  expect(monthFolderName('19-08-2026')).toBeNull();
});

test('resolveAppFolderId looks up a configured code', () => {
  const mapping = { CMC: 'folder-cmc', LO: 'folder-lo' };
  expect(resolveAppFolderId('CMC', mapping)).toBe('folder-cmc');
  expect(resolveAppFolderId('LO', mapping)).toBe('folder-lo');
});

test('resolveAppFolderId returns null for an unrecognized or unconfigured code', () => {
  const mapping = { CMC: 'folder-cmc', LO: '' };
  expect(resolveAppFolderId('LV', mapping)).toBeNull();   // mirror app, not configured
  expect(resolveAppFolderId('LO', mapping)).toBeNull();   // present but blank
  expect(resolveAppFolderId('CMC', {})).toBeNull();
  expect(resolveAppFolderId(null, mapping)).toBeNull();
});

test('parseFolderIdFromUrl extracts the id from real Drive folder URLs', () => {
  expect(parseFolderIdFromUrl('https://drive.google.com/drive/folders/1AbC-dEfG_123'))
    .toBe('1AbC-dEfG_123');
  expect(parseFolderIdFromUrl('https://drive.google.com/drive/u/2/folders/1AbC-dEfG_123'))
    .toBe('1AbC-dEfG_123');
  expect(parseFolderIdFromUrl('https://drive.google.com/drive/u/0/folders/1AbC-dEfG_123?usp=sharing'))
    .toBe('1AbC-dEfG_123');
});

test('parseFolderIdFromUrl accepts a bare id, so pasting either form works', () => {
  expect(parseFolderIdFromUrl('1AbC-dEfG_123')).toBe('1AbC-dEfG_123');
});

test('parseFolderIdFromUrl returns null for non-folder URLs', () => {
  expect(parseFolderIdFromUrl('https://drive.google.com/file/d/1XYZ/view')).toBeNull();
  expect(parseFolderIdFromUrl('https://example.com/drive/folders/1XYZ')).toBeNull();
  expect(parseFolderIdFromUrl('')).toBeNull();
  expect(parseFolderIdFromUrl(null)).toBeNull();
});

test('partitionUploadFiles excludes project files when the flag is off', () => {
  const files = [
    '/t/CMC_1_9x16.mp4',
    '/t/CMC_1_1x1.png',
    '/t/CMC_1.aep',
    '/t/CMC_1.psd',
  ];
  const { include, excluded } = partitionUploadFiles(files, false);
  expect(include).toEqual(['/t/CMC_1_9x16.mp4', '/t/CMC_1_1x1.png']);
  expect(excluded).toEqual(['/t/CMC_1.aep', '/t/CMC_1.psd']);
});

test('partitionUploadFiles includes everything when the flag is on', () => {
  const files = ['/t/a.mp4', '/t/b.aep'];
  const { include, excluded } = partitionUploadFiles(files, true);
  expect(include).toEqual(files);
  expect(excluded).toEqual([]);
});

test('partitionUploadFiles matches extensions case-insensitively', () => {
  const { include, excluded } = partitionUploadFiles(['/t/A.AEP', '/t/b.MP4'], false);
  expect(excluded).toEqual(['/t/A.AEP']);
  expect(include).toEqual(['/t/b.MP4']);
});

test('partitionUploadFiles keeps extensionless files as deliverables', () => {
  const { include, excluded } = partitionUploadFiles(['/t/README'], false);
  expect(include).toEqual(['/t/README']);
  expect(excluded).toEqual([]);
});

const { buildFolderMap, parseMirrorCodes } = require('../renderer/drive-path');

test('buildFolderMap maps mirror codes onto their base app folder', () => {
  const map = buildFolderMap({ PL: 'plamfy-id', CMC: 'cmc-id' }, { PL: ['BL', 'XX'] });
  expect(map.PL).toBe('plamfy-id');
  expect(map.BL).toBe('plamfy-id');
  expect(map.XX).toBe('plamfy-id');
  expect(map.CMC).toBe('cmc-id');
});

test('buildFolderMap ignores mirrors of an unconfigured base, so they abort', () => {
  const map = buildFolderMap({ CMC: 'cmc-id' }, { PL: ['BL'] });
  expect(map.BL).toBeUndefined();
  expect(map.PL).toBeUndefined();
});

test('buildFolderMap never lets a mirror override a real base entry', () => {
  const map = buildFolderMap({ PL: 'plamfy-id', BL: 'its-own-id' }, { PL: ['BL'] });
  expect(map.BL).toBe('its-own-id');
});

test('buildFolderMap tolerates missing arguments', () => {
  expect(buildFolderMap(undefined, undefined)).toEqual({});
  expect(buildFolderMap({ PL: 'x' }, undefined)).toEqual({ PL: 'x' });
});

test('parseMirrorCodes splits on commas and spaces, uppercases, dedupes', () => {
  expect(parseMirrorCodes('BL, XX bl')).toEqual(['BL', 'XX']);
  expect(parseMirrorCodes('  hc ')).toEqual(['HC']);
  expect(parseMirrorCodes('')).toEqual([]);
  expect(parseMirrorCodes(null)).toEqual([]);
  expect(parseMirrorCodes('BL, !!, 9X')).toEqual(['BL', '9X']);
});
