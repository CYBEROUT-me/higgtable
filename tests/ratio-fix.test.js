const {
  EXACT_RATIOS, CANONICAL_SIZES, MIN_CROP_PIXELS, ratioDeviation, planRatioCrop, describeRatioCrop,
  planRatioFix, describeRatioFix,
} =
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

// Delivery size: every 9x16 leaves as 1080x1920 and every 16x9 as 1920x1080.
describe('planRatioFix — normalising to the delivery size', () => {
  test('the canonical sizes are the delivery specs', () => {
    expect(CANONICAL_SIZES['9x16']).toEqual({ width: 1080, height: 1920 });
    expect(CANONICAL_SIZES['16x9']).toEqual({ width: 1920, height: 1080 });
  });

  test.each([
    [1520, 2688, '9x16', 1080, 1920],
    [1536, 2752, '9x16', 1080, 1920],
    [2752, 1536, '16x9', 1920, 1080],
    [2688, 1520, '16x9', 1920, 1080],
  ])('%ix%i (%s) is cropped and then scaled to %ix%i', (w, h, label, fw, fh) => {
    const fix = planRatioFix(w, h, label);
    expect(fix.crop).not.toBeNull();
    expect(fix.resize).toEqual({ width: fw, height: fh });
    expect([fix.finalWidth, fix.finalHeight]).toEqual([fw, fh]);
  });

  test('the crop happens before the scale, so the scale is a pure downscale of an exact ratio', () => {
    const fix = planRatioFix(1520, 2688, '9x16');
    expect(fix.crop.width / fix.crop.height).toBeCloseTo(9 / 16, 3);
    expect(fix.resize.width).toBeLessThanOrEqual(fix.crop.width);
    expect(fix.resize.height).toBeLessThanOrEqual(fix.crop.height);
  });

  test('an exact ratio at the wrong size is only scaled, not cropped', () => {
    const fix = planRatioFix(2160, 3840, '9x16');
    expect(fix.crop).toBeNull();
    expect(fix.resize).toEqual({ width: 1080, height: 1920 });
  });

  test('a file already at the delivery size needs nothing', () => {
    expect(planRatioFix(1080, 1920, '9x16')).toBeNull();
    expect(planRatioFix(1920, 1080, '16x9')).toBeNull();
  });

  test('upscales a frame below the delivery size, and says so', () => {
    // Higgsfield also emits 768x1365. The spec is 1080x1920 regardless — a small
    // file risks rejection — so it is scaled up, and flagged as an upscale.
    const fix = planRatioFix(768, 1365, '9x16');
    expect(fix.crop).toBeNull();                       // ratio already exact
    expect(fix.resize).toEqual({ width: 1080, height: 1920 });
    expect(fix.upscale).toBe(true);
    expect(fix.scale).toBeCloseTo(1.406, 2);
  });

  test('upscales 16x9 the same way', () => {
    const fix = planRatioFix(1365, 768, '16x9');
    expect(fix.resize).toEqual({ width: 1920, height: 1080 });
    expect(fix.upscale).toBe(true);
  });

  test('an off-ratio small frame is cropped and then scaled up', () => {
    const fix = planRatioFix(910, 1600, '9x16');
    expect(fix.crop).not.toBeNull();
    expect(fix.resize).toEqual({ width: 1080, height: 1920 });
    expect(fix.upscale).toBe(true);
  });

  test('a downscale is not marked as an upscale', () => {
    const fix = planRatioFix(1520, 2688, '9x16');
    expect(fix.upscale).toBe(false);
    expect(fix.scale).toBeLessThan(1);
  });

  test('a ratio with no delivery size is cropped but keeps its resolution', () => {
    const fix = planRatioFix(1100, 1000, '4x5');
    expect(fix.crop).not.toBeNull();
    expect(fix.resize).toBeNull();
    expect(fix.upscale).toBe(false);
  });

  test('1x1 is delivered at 1080x1080', () => {
    expect(CANONICAL_SIZES['1x1']).toEqual({ width: 1080, height: 1080 });
    // The reported Higgsfield square: exact ratio, scaled up.
    expect(planRatioFix(1024, 1024, '1x1')).toMatchObject({
      crop: null, resize: { width: 1080, height: 1080 }, upscale: true,
    });
    // Off-square: cropped to a square, then scaled down.
    expect(planRatioFix(1100, 1000, '1x1')).toMatchObject({
      crop: { width: 1000, height: 1000 }, resize: { width: 1080, height: 1080 },
    });
    expect(planRatioFix(2048, 2048, '1x1').upscale).toBe(false);
    expect(planRatioFix(1080, 1080, '1x1')).toBeNull();
  });

  test('refuses nonsense input', () => {
    expect(planRatioFix(0, 100, '9x16')).toBeNull();
    expect(planRatioFix(100, 100, 'nope')).toBeNull();
  });
});

describe('describeRatioFix', () => {
  test('describes a crop plus a scale', () => {
    const text = describeRatioFix(planRatioFix(1520, 2688, '9x16'), '9x16');
    expect(text).toContain('crop 8px of width');
    expect(text).toContain('scale');
    expect(text).toContain('1080×1920');
  });

  test('describes a scale alone', () => {
    const text = describeRatioFix(planRatioFix(2160, 3840, '9x16'), '9x16');
    expect(text).not.toContain('crop');
    expect(text).toContain('1080×1920');
  });

  test('is null when there is nothing to do', () => {
    expect(describeRatioFix(null, '9x16')).toBeNull();
  });
});

test('describeRatioFix labels an upscale honestly', () => {
  const text = describeRatioFix(planRatioFix(768, 1365, '9x16'), '9x16');
  expect(text).toContain('upscale 1.41×');
  expect(text).toContain('cannot add detail');
  expect(text).toContain('1080×1920');
});
