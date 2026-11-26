const {
  buildFileIndex, taskFiles, taskReadiness, readinessLabel, stepSummary,
} = require('../renderer/readiness-data');

const FIELDS = { creativeLink: 'Creative Link', figmaLink: 'Figma/Canvas link' };
const base = 'TLN_3536_X_Mix';
const idx = buildFileIndex([
  [`${base}_9x16.mp4`.toLowerCase(), 32716005, '/w/a_9x16.mp4'],
  [`${base}_1x1.mp4`.toLowerCase(), 30000000, '/w/a_1x1.mp4'],
  [`${base}_4x5.mp4`.toLowerCase(), 30000000, '/w/a_4x5.mp4'],
  [`${base}_1x1.png`.toLowerCase(), 600000, '/w/a_1x1.png'],
]);
const video = (fields = {}) => ({ id: 'r1', fields: { Name: `${base}_9x16`, Format: 'Video', Status: 'In work', ...fields } });

describe('taskFiles', () => {
  test('finds each standard video regardless of case, with its size', () => {
    const f = taskFiles(base, idx);
    expect(f.videos.map(v => [v.label, v.bytes])).toEqual([
      ['9x16', 32716005], ['1x1', 30000000], ['4x5', 30000000], ['16x9', null],
    ]);
    expect(f.preview).toMatchObject({ bytes: 600000 });
  });
});

describe('taskReadiness', () => {
  test('lists what is missing and which step fixes it', () => {
    const r = taskReadiness(video({ Timing: '30s' }), taskFiles(base, idx), FIELDS);
    expect(r.ready).toBe(false);
    expect(r.missing.map(i => [i.label, i.step])).toEqual([
      ['no 16x9', 'resize'], ['9x16 over 32 MB', 'compress'],
      ['Creative Link', 'autofill'], ['Preview', 'autofill'], ['Hours', 'autofill'],
    ]);
    expect(readinessLabel(r)).toBe('5 left');
  });

  test('everything present and filled is ready', () => {
    const full = buildFileIndex(['9x16', '1x1', '4x5', '16x9'].map(l => [`${base}_${l}.mp4`.toLowerCase(), 1, 'p']));
    const r = taskReadiness(video({
      Timing: '30s', 'Creative Link': 'https://x', Preview: [{ url: 'u' }], Hours: 3600,
    }), taskFiles(base, full), FIELDS);
    expect(r.ready).toBe(true);
    expect(readinessLabel(r)).toBe('ready');
  });

  test('a Stat task needs only Figma link, Preview and Hours', () => {
    const r = taskReadiness({ id: 's', fields: { Format: 'Stat', 'Figma/Canvas link': 'https://f' } },
      taskFiles('S', idx), FIELDS);
    expect(r.missing.map(i => i.label)).toEqual(['Preview', 'Hours']);
  });

  test('handed-in tasks count as ready', () => {
    const r = taskReadiness(video({ Status: 'To accept' }), taskFiles(base, idx), FIELDS);
    expect(r.ready).toBe(true);
    expect(readinessLabel(r)).toBe('handed in');
  });
});

describe('stepSummary', () => {
  test('counts per step and points at the first step with work', () => {
    const files = taskFiles(base, idx);
    const s = stepSummary([
      taskReadiness(video(), files, FIELDS),
      taskReadiness(video({ Status: 'Done' }), files, FIELDS),
    ]);
    expect(s).toMatchObject({ total: 2, resize: 1, compress: 1, autofill: 1, accept: 1, next: 'resize' });
    expect(s.autofillFields).toEqual(['Timing', 'Creative Link', 'Preview', 'Hours']);
  });

  test('when everything is filled the next step is To Accept, then nothing', () => {
    const ready = { handedIn: false, missing: [], ready: true };
    expect(stepSummary([ready]).next).toBe('accept');
    expect(stepSummary([{ handedIn: true, missing: [], ready: true }]).next).toBeNull();
  });
});

describe('repeat renders (_9x16_1)', () => {
  const { findRepeatRenders, repeatToPromote, masterNameForRepeat, repeatWarning } = require('../renderer/readiness-data');
  const b = 'LO_15945_13140_M0_S0_GR_usr_ARI_ILU_Video_VAR_Mix';
  const l = s => `${b}${s}`.toLowerCase();

  test('a newer _9x16_1 next to the master is flagged and promoted', () => {
    const index = buildFileIndex([[l('_9x16.mp4'), 1, '/w/m', 100], [l('_9x16_1.mp4'), 2, '/w/r1', 200]]);
    const reps = findRepeatRenders(b, index);
    expect(reps).toEqual([{ n: 1, name: l('_9x16_1.mp4'), bytes: 2, path: '/w/r1', mtime: 200, newer: true }]);
    expect(repeatToPromote(reps).path).toBe('/w/r1');
    expect(repeatWarning(reps)).toBe('newer render in _9x16_1');
  });

  test('an older repeat is only a note, with nothing to promote', () => {
    const index = buildFileIndex([[l('_9x16.mp4'), 1, '/w/m', 300], [l('_9x16_1.mp4'), 2, '/w/r1', 200]]);
    const reps = findRepeatRenders(b, index);
    expect(reps[0].newer).toBe(false);
    expect(repeatToPromote(reps)).toBeNull();
    expect(repeatWarning(reps)).toBe('old _9x16_1 next to the master');
  });

  test('picks the newest of several newer repeats; a missing master or time counts as newer', () => {
    const index = buildFileIndex([
      [l('_9x16.mp4'), 1, '/w/m', 100], [l('_9x16_1.mp4'), 2, '/w/r1', 300], [l('_9x16_2.mp4'), 2, '/w/r2', 200],
    ]);
    expect(repeatToPromote(findRepeatRenders(b, index)).n).toBe(1);
    const noMaster = buildFileIndex([[l('_9x16_1.mp4'), 2, '/w/r1', 5]]);
    expect(findRepeatRenders(b, noMaster)[0].newer).toBe(true);
    const noTime = buildFileIndex([[l('_9x16.mp4'), 1, '/w/m'], [l('_9x16_1.mp4'), 2, '/w/r1']]);
    expect(findRepeatRenders(b, noTime)[0].newer).toBe(true);
  });

  test('no repeats, no warning', () => {
    expect(findRepeatRenders(b, buildFileIndex([[l('_9x16.mp4'), 1, '/w/m', 1]]))).toEqual([]);
    expect(repeatWarning([])).toBeNull();
  });

  test('masterNameForRepeat strips the repeat number only', () => {
    expect(masterNameForRepeat('X_9x16_1.mp4')).toBe('X_9x16.mp4');
    expect(masterNameForRepeat('X_1.91x1_12.MP4')).toBe('X_1.91x1.MP4');
    expect(masterNameForRepeat('X_9x16.mp4')).toBeNull();
    expect(masterNameForRepeat('X_9x16_1.png')).toBeNull();
  });

  test('readiness carries the warning without blocking ready; stepSummary counts it', () => {
    const index = buildFileIndex([
      ...['9x16', '1x1', '4x5', '16x9'].map(s => [l(`_${s}.mp4`), 1, 'p', 100]),
      [l('_9x16_1.mp4'), 2, '/w/r1', 200],
    ]);
    const rec = { id: 'x', fields: { Name: `${b}_9x16`, Format: 'Video', Status: 'In work',
      Timing: '30s', 'Creative Link': 'https://x', Preview: [{}], Hours: '01:00' } };
    const r = taskReadiness(rec, taskFiles(b, index), FIELDS);
    expect(r.ready).toBe(true);
    expect(r.warning).toBe('newer render in _9x16_1');
    expect(r.promote.path).toBe('/w/r1');
    expect(stepSummary([r]).warnings).toBe(1);
    const handed = taskReadiness({ ...rec, fields: { ...rec.fields, Status: 'Done' } }, taskFiles(b, index), FIELDS);
    expect(handed.warning).toBeNull();
  });
});
