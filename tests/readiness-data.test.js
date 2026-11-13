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
