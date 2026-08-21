const {
  RATIOS, PREVIEW_RATIO_ORDER, VIDEO_RATIO_ORDER, PREVIEW_EXTS, VIDEO_EXTS,
  buildWantedFilenames, pickByRatioPreference,
} = require('../renderer/autofill-data');

test('buildWantedFilenames covers every ratio for every extension', () => {
  const wanted = buildWantedFilenames(['T'], ['1x1', '9x16']);
  expect(wanted).toEqual([
    'T_1x1.png', 'T_1x1.jpg', 'T_1x1.jpeg', 'T_1x1.mp4',
    'T_9x16.png', 'T_9x16.jpg', 'T_9x16.jpeg', 'T_9x16.mp4',
  ]);
});

test('buildWantedFilenames dedupes repeated bases', () => {
  expect(buildWantedFilenames(['T', 'T'], ['1x1']))
    .toEqual(['T_1x1.png', 'T_1x1.jpg', 'T_1x1.jpeg', 'T_1x1.mp4']);
});

test('buildWantedFilenames honours an explicit extension list', () => {
  expect(buildWantedFilenames(['T'], ['1x1'], ['png'])).toEqual(['T_1x1.png']);
  expect(buildWantedFilenames(['T'], ['1x1'], VIDEO_EXTS)).toEqual(['T_1x1.mp4']);
});

test('pickByRatioPreference prefers the first ratio that exists', () => {
  const found = { 'T_9x16.png': '/p/T_9x16.png', 'T_4x5.png': '/p/T_4x5.png' };
  expect(pickByRatioPreference('T', found, ['1x1', '9x16', '4x5'], 'png'))
    .toEqual({ filename: 'T_9x16.png', path: '/p/T_9x16.png', ratio: '9x16', ext: 'png' });
});

test('pickByRatioPreference returns the exact preferred ratio when present', () => {
  const found = { 'T_1x1.png': '/p/a', 'T_9x16.png': '/p/b' };
  expect(pickByRatioPreference('T', found, ['1x1', '9x16'], 'png').ratio).toBe('1x1');
});

test('pickByRatioPreference returns null when no ratio matches', () => {
  expect(pickByRatioPreference('T', { 'OTHER_1x1.png': '/p' }, ['1x1'], 'png')).toBeNull();
  expect(pickByRatioPreference('T', {}, ['1x1'], 'png')).toBeNull();
});

test('pickByRatioPreference accepts a single extension as a string', () => {
  const found = { 'T_1x1.png': '/p/a' };
  expect(pickByRatioPreference('T', found, ['1x1'], 'png').filename).toBe('T_1x1.png');
});

test('a JPG preview is found when no PNG exists', () => {
  const found = { 'T_1x1.jpg': '/p/T_1x1.jpg' };
  expect(pickByRatioPreference('T', found, PREVIEW_RATIO_ORDER, PREVIEW_EXTS))
    .toEqual({ filename: 'T_1x1.jpg', path: '/p/T_1x1.jpg', ratio: '1x1', ext: 'jpg' });
});

test('a .jpeg preview is found too', () => {
  const found = { 'T_1x1.jpeg': '/p/T_1x1.jpeg' };
  expect(pickByRatioPreference('T', found, PREVIEW_RATIO_ORDER, PREVIEW_EXTS).ext).toBe('jpeg');
});

test('PNG wins over JPG at the same ratio', () => {
  const found = { 'T_1x1.jpg': '/p/jpg', 'T_1x1.png': '/p/png' };
  expect(pickByRatioPreference('T', found, PREVIEW_RATIO_ORDER, PREVIEW_EXTS).ext).toBe('png');
});

test('ratio preference beats extension preference', () => {
  // A 1x1 JPG is a better preview than a 9x16 PNG: the ratio is what the field
  // is for, the container format is incidental.
  const found = { 'T_1x1.jpg': '/p/jpg', 'T_9x16.png': '/p/png' };
  const hit = pickByRatioPreference('T', found, PREVIEW_RATIO_ORDER, PREVIEW_EXTS);
  expect(hit.ratio).toBe('1x1');
  expect(hit.ext).toBe('jpg');
});

test('a JPG in a fallback ratio is found when nothing preferred exists', () => {
  const found = { 'T_4x5.jpg': '/p/T_4x5.jpg' };
  const hit = pickByRatioPreference('T', found, PREVIEW_RATIO_ORDER, PREVIEW_EXTS);
  expect(hit).toEqual({ filename: 'T_4x5.jpg', path: '/p/T_4x5.jpg', ratio: '4x5', ext: 'jpg' });
});

test('video matching stays mp4-only', () => {
  expect(VIDEO_EXTS).toEqual(['mp4']);
  expect(pickByRatioPreference('T', { 'T_9x16.jpg': '/p' }, VIDEO_RATIO_ORDER, VIDEO_EXTS)).toBeNull();
});

test('preview prefers a square image, video prefers vertical', () => {
  expect(PREVIEW_RATIO_ORDER[0]).toBe('1x1');
  expect(VIDEO_RATIO_ORDER[0]).toBe('9x16');
  // every known ratio remains reachable as a fallback
  RATIOS.forEach(r => {
    expect(PREVIEW_RATIO_ORDER).toContain(r);
    expect(VIDEO_RATIO_ORDER).toContain(r);
  });
});
