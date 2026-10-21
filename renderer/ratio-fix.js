// renderer/ratio-fix.js
// Pure geometry for correcting creatives that are nearly, but not exactly, the
// aspect ratio their filename claims. No DOM, no IO — runs under plain Jest.
//
// Higgsfield nodes emit sizes like 1520x2688, 1536x2752 and 2752x1536, which are
// 0.5–0.8% off 9:16 / 16:9. The correction is a CROP, never a stretch: a crop
// costs 4–10 pixels off one edge and leaves every remaining pixel true, while a
// stretch of the same magnitude distorts the whole image — and these creatives
// are faces and type, which is exactly what the eye notices.

// The exact ratio each label means. Keep in step with ratioFromDimensions in
// app.js, which buckets a measured size into one of these labels.
const EXACT_RATIOS = {
  '1.91x1': 1.91,
  '16x9': 16 / 9,
  '4x3': 4 / 3,
  '1x1': 1,
  '4x5': 4 / 5,
  '2x3': 2 / 3,
  '9x16': 9 / 16,
};

// The size every creative should be delivered at, once its ratio is correct.
// Higgsfield emits 2688px-tall frames; ads ship at 1080x1920, so the fix is a
// crop to the exact ratio followed by a downscale to the canonical size.
//
// Only the ratios that are actually delivered are listed. A label with no
// canonical size keeps its native resolution after cropping.
const CANONICAL_SIZES = {
  '9x16': { width: 1080, height: 1920 },
  '16x9': { width: 1920, height: 1080 },
  '1x1': { width: 1080, height: 1080 },
};

// A crop this small or smaller is left alone. Expressing the threshold in PIXELS
// rather than percent is deliberate: a percentage tolerance means the same
// visual error is forgiven on a small image and flagged on a large one. One
// pixel off is also what integer rounding alone produces, so flagging it would
// nag about sizes that are already as close as whole pixels allow.
const MIN_CROP_PIXELS = 2;

// How far `width x height` sits from the ratio `label` names, as a signed
// fraction: positive means too wide, negative means too tall.
function ratioDeviation(width, height, label) {
  const target = EXACT_RATIOS[label];
  if (!target || !width || !height) return null;
  return (width / height - target) / target;
}

// The centred crop that makes `width x height` exactly `label`, or null when it
// is already within tolerance.
//
// Only ever crops — the axis that is too long loses pixels, and the other is
// left alone. Upscaling would invent detail, and padding would add bars, so
// neither is offered.
function planRatioCrop(width, height, label) {
  const target = EXACT_RATIOS[label];
  if (!target || !(width > 0) || !(height > 0)) return null;

  const deviation = ratioDeviation(width, height, label);

  let cropWidth = width;
  let cropHeight = height;
  if (deviation > 0) {
    // Too wide: take the excess off the sides.
    cropWidth = Math.round(height * target);
  } else {
    // Too tall — or, as with 1536x2752, too narrow to fix horizontally without
    // upscaling. Either way the height is what has to give.
    cropHeight = Math.round(width / target);
  }

  // Guard against a rounding step that would somehow grow the image.
  cropWidth = Math.min(cropWidth, width);
  cropHeight = Math.min(cropHeight, height);
  if (cropWidth === width && cropHeight === height) return null;

  const axis = cropWidth !== width ? 'width' : 'height';
  const pixels = axis === 'width' ? width - cropWidth : height - cropHeight;
  if (pixels < MIN_CROP_PIXELS) return null;

  return {
    // Centred, so a subject in the middle of the frame stays put.
    x: Math.floor((width - cropWidth) / 2),
    y: Math.floor((height - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
    axis,
    pixels,
    perSide: Math.floor(pixels / 2),
    percent: pixels / (axis === 'width' ? width : height),
    deviation,
  };
}

// One line for the file list: what is wrong and what the fix costs.
function describeRatioCrop(plan, label) {
  if (!plan) return null;
  const off = `${(plan.deviation * 100).toFixed(2)}%`;
  return `off ${label} by ${plan.deviation > 0 ? '+' : ''}${off} — crop ${plan.pixels}px of ${plan.axis}`
    + ` (${plan.perSide}px each side) → ${plan.width}×${plan.height}`;
}


// The complete correction for a file: crop to the exact ratio, then scale to
// the canonical delivery size. Returns null when the file is already correct.
//
// Either half can be absent. A file that is already an exact 9:16 at 2160x3840
// needs no crop but does need scaling; a 1080x1920 file needs neither.
//
// Scaling goes in BOTH directions. Higgsfield also emits 768x1365, and the
// delivery spec is 1080x1920 regardless — a smaller file risks rejection by the
// ad platform, not just a softer look. An upscale cannot add detail, so it is
// marked `upscale` and the UI says so rather than presenting it as lossless.
function planRatioFix(width, height, label) {
  if (!EXACT_RATIOS[label] || !(width > 0) || !(height > 0)) return null;

  const crop = planRatioCrop(width, height, label);
  const afterCropWidth = crop ? crop.width : width;
  const afterCropHeight = crop ? crop.height : height;

  const canonical = CANONICAL_SIZES[label];
  let resize = null;
  if (canonical && (afterCropWidth !== canonical.width || afterCropHeight !== canonical.height)) {
    resize = { width: canonical.width, height: canonical.height };
  }

  if (!crop && !resize) return null;
  const scale = resize ? resize.width / afterCropWidth : 1;
  return {
    crop,
    resize,
    finalWidth: resize ? resize.width : afterCropWidth,
    finalHeight: resize ? resize.height : afterCropHeight,
    scale,
    upscale: scale > 1,
  };
}

// One line for the file list: what is wrong and what the fix does.
function describeRatioFix(fix, label, width, height) {
  if (!fix) return null;
  const parts = [];
  if (fix.crop) {
    parts.push(`off ${label} by ${fix.crop.deviation > 0 ? '+' : ''}`
      + `${(fix.crop.deviation * 100).toFixed(2)}% — crop ${fix.crop.pixels}px of ${fix.crop.axis}`
      + ` (${fix.crop.perSide}px each side)`);
  }
  if (fix.resize) {
    parts.push(fix.upscale
      ? `upscale ${fix.scale.toFixed(2)}× to the ${label} delivery size (cannot add detail)`
      : `scale to the ${label} delivery size`);
  }
  return `${parts.join('; ')} → ${fix.finalWidth}×${fix.finalHeight}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    EXACT_RATIOS, CANONICAL_SIZES, MIN_CROP_PIXELS,
    ratioDeviation, planRatioCrop, describeRatioCrop,
    planRatioFix, describeRatioFix,
  };
}
