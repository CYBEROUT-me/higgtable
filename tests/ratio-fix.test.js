const { EXACT_RATIOS, MIN_CROP_PIXELS, ratioDeviation, planRatioCrop, describeRatioCrop } =
  require('../renderer/ratio-fix');

// The three real Higgsfield outputs that prompted this.
describe('the reported Higgsfield sizes', () => {
  test('1520x2688 is 0.53% too wide and loses 8px of width', () => {
    const plan = planRatioCrop(1520, 2688, '9x16');
    expect(plan).toMatchObject({ width: 1512, height: 2688, axis: 'width', pixels: 8, perSide: 4 });
    expect(plan.deviation).toBeCloseTo(0.0053, 4);
    // Centred: 4px off each side.
    expect(plan.x).toBe(4);
    expect(plan.y).toBe(0);
  });

  test('1536x2752 is too NARROW, so height gives way instead', () => {
    // 2752 * 9/16 = 1548 > 1536, so it cannot be fixed by cropping width
    // without upscaling — the 21px has to come off top and bottom.
    const plan = planRatioCrop(1536, 2752, '9x16');
    expect(plan).toMatchObject({ width: 1536, height: 2731, axis: 'height', pixels: 21, perSide: 10 });
    expect(plan.deviation).toBeLessThan(0);
    expect(plan.x).toBe(0);
    expect(plan.y).toBe(10);
  });

  test('2752x1536 is 0.78% too wide for 16x9 and loses 21px of width', () => {
    const plan = planRatioCrop(2752, 1536, '16x9');
    expect(plan).toMatchObject({ width: 2731, height: 1536, axis: 'width', pixels: 21, perSide: 10 });
    expect(plan.x).toBe(10);
  });

  test('every correction costs under 1% of the image', () => {
    for (const [w, h, label] of [[1520, 2688, '9x16'], [1536, 2752, '9x16'], [2752, 1536, '16x9']]) {
      expect(planRatioCrop(w, h, label).percent).toBeLessThan(0.01);
    }
  });
});

describe('planRatioCrop', () => {
  test('returns null for a size that is already exact', () => {
    expect(planRatioCrop(1080, 1920, '9x16')).toBeNull();
    expect(planRatioCrop(1920, 1080, '16x9')).toBeNull();
    expect(planRatioCrop(1000, 1000, '1x1')).toBeNull();
  });

  test('ignores a one-pixel difference', () => {
    // 1081x1920 is 1px off 1080x1920. That is what integer rounding alone
    // produces, and it is below any visual relevance — nagging about it would
    // make the warning worthless. The threshold is in pixels, not percent, so
    // it does not change meaning with image size.
    expect(MIN_CROP_PIXELS).toBe(2);
    expect(planRatioCrop(1081, 1920, '9x16')).toBeNull();
  });

  test('acts on a two-pixel difference', () => {
    expect(planRatioCrop(1082, 1920, '9x16')).toMatchObject({ width: 1080, pixels: 2 });
  });

  test('never upscales — the result always fits inside the original', () => {
    for (const [w, h, label] of [[1520, 2688, '9x16'], [1536, 2752, '9x16'], [2752, 1536, '16x9'], [900, 1000, '1x1']]) {
      const plan = planRatioCrop(w, h, label);
      expect(plan.width).toBeLessThanOrEqual(w);
      expect(plan.height).toBeLessThanOrEqual(h);
    }
  });

  test('the crop stays inside the original bounds', () => {
    const plan = planRatioCrop(2752, 1536, '16x9');
    expect(plan.x + plan.width).toBeLessThanOrEqual(2752);
    expect(plan.y + plan.height).toBeLessThanOrEqual(1536);
    expect(plan.x).toBeGreaterThanOrEqual(0);
    expect(plan.y).toBeGreaterThanOrEqual(0);
  });

  test('the cropped result is the requested ratio', () => {
    for (const [w, h, label] of [[1520, 2688, '9x16'], [1536, 2752, '9x16'], [2752, 1536, '16x9']]) {
      const plan = planRatioCrop(w, h, label);
      const got = plan.width / plan.height;
      expect(got).toBeCloseTo(EXACT_RATIOS[label], 3);
    }
  });

  test('a too-tall image loses height', () => {
    const plan = planRatioCrop(1000, 1100, '1x1');
    expect(plan).toMatchObject({ width: 1000, height: 1000, axis: 'height' });
  });

  test('a too-wide image loses width', () => {
    const plan = planRatioCrop(1100, 1000, '1x1');
    expect(plan).toMatchObject({ width: 1000, height: 1000, axis: 'width' });
  });

  test('refuses nonsense input rather than guessing', () => {
    expect(planRatioCrop(0, 100, '9x16')).toBeNull();
    expect(planRatioCrop(100, 0, '9x16')).toBeNull();
    expect(planRatioCrop(100, 100, 'not-a-ratio')).toBeNull();
    expect(planRatioCrop(undefined, undefined, '9x16')).toBeNull();
  });
});

describe('ratioDeviation', () => {
  test('is positive when too wide and negative when too tall', () => {
    expect(ratioDeviation(1520, 2688, '9x16')).toBeGreaterThan(0);
    expect(ratioDeviation(1536, 2752, '9x16')).toBeLessThan(0);
  });

  test('is zero for an exact size', () => {
    expect(ratioDeviation(1080, 1920, '9x16')).toBeCloseTo(0, 6);
  });

  test('returns null for an unknown label', () => {
    expect(ratioDeviation(100, 100, 'nope')).toBeNull();
  });
});

describe('describeRatioCrop', () => {
  test('states the deviation and what the fix costs', () => {
    const text = describeRatioCrop(planRatioCrop(1520, 2688, '9x16'), '9x16');
    expect(text).toContain('9x16');
    expect(text).toContain('+0.53%');
    expect(text).toContain('crop 8px of width');
    expect(text).toContain('1512×2688');
  });

  test('is null when there is nothing to fix', () => {
    expect(describeRatioCrop(null, '9x16')).toBeNull();
  });
});
