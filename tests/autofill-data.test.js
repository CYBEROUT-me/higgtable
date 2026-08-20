const { RATIOS, PREVIEW_RATIO_ORDER, VIDEO_RATIO_ORDER, buildWantedFilenames, pickByRatioPreference } =
  require('../renderer/autofill-data');

test('buildWantedFilenames covers every ratio for both extensions', () => {
  const wanted = buildWantedFilenames(['T'], ['1x1', '9x16']);
  expect(wanted).toEqual(['T_1x1.png', 'T_1x1.mp4', 'T_9x16.png', 'T_9x16.mp4']);
});

test('buildWantedFilenames dedupes repeated bases', () => {
  expect(buildWantedFilenames(['T', 'T'], ['1x1'])).toEqual(['T_1x1.png', 'T_1x1.mp4']);
});

test('pickByRatioPreference prefers the first ratio that exists', () => {
  const found = { 'T_9x16.png': '/p/T_9x16.png', 'T_4x5.png': '/p/T_4x5.png' };
  expect(pickByRatioPreference('T', found, ['1x1', '9x16', '4x5'], 'png'))
    .toEqual({ filename: 'T_9x16.png', path: '/p/T_9x16.png', ratio: '9x16' });
});

test('pickByRatioPreference returns the exact preferred ratio when present', () => {
  const found = { 'T_1x1.png': '/p/a', 'T_9x16.png': '/p/b' };
  expect(pickByRatioPreference('T', found, ['1x1', '9x16'], 'png').ratio).toBe('1x1');
});

test('pickByRatioPreference returns null when no ratio matches', () => {
  expect(pickByRatioPreference('T', { 'OTHER_1x1.png': '/p' }, ['1x1'], 'png')).toBeNull();
  expect(pickByRatioPreference('T', {}, ['1x1'], 'png')).toBeNull();
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
