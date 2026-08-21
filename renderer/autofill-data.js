// renderer/autofill-data.js
// Pure filename logic for Autofill. No DOM, no IO — mirrors the drive-path.js /
// notifications-data.js split so it runs under plain Jest.

// Every aspect ratio the renamer produces (see stripAspectRatio in app.js).
const RATIOS = ['1x1', '9x16', '4x5', '16x9', '1.91x1', '4x3', '2x3'];

// Autofill originally demanded exactly "<base>_1x1.png" and "<base>_9x16.mp4",
// so a variation rendered in only one ratio matched nothing. These orders keep
// the original first choice but fall back to whatever ratio actually exists.
const PREVIEW_RATIO_ORDER = ['1x1', '9x16', '4x5', '16x9', '1.91x1', '4x3', '2x3'];
const VIDEO_RATIO_ORDER = ['9x16', '1x1', '4x5', '16x9', '1.91x1', '4x3', '2x3'];

// Preview images are not always PNG — renders come out as JPG too. Order is
// preference order: a PNG wins over a JPG of the same ratio, since that is what
// the pipeline produced before JPG was allowed. "jpeg" is accepted alongside
// "jpg" because it is the same format under a second conventional extension.
const PREVIEW_EXTS = ['png', 'jpg', 'jpeg'];
const VIDEO_EXTS = ['mp4'];

// All candidate filenames to search for, so one directory walk covers every
// ratio and extension rather than one walk per guess.
function buildWantedFilenames(bases, ratios, exts) {
  const extList = exts && exts.length ? exts : [...PREVIEW_EXTS, ...VIDEO_EXTS];
  const out = [];
  [...new Set(bases)].forEach(base => {
    ratios.forEach(r => {
      extList.forEach(ext => {
        const name = `${base}_${r}.${ext}`;
        if (!out.includes(name)) out.push(name);
      });
    });
  });
  return out;
}

// Returns the first ratio present in `found`, following `order`. Ratio
// preference dominates extension preference: a 1x1 JPG is a better preview than
// a 9x16 PNG, because the ratio is what the field is for.
function pickByRatioPreference(base, found, order, exts) {
  const extList = Array.isArray(exts) ? exts : [exts];
  for (const ratio of order) {
    for (const ext of extList) {
      const filename = `${base}_${ratio}.${ext}`;
      if (found && found[filename]) return { filename, path: found[filename], ratio, ext };
    }
  }
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RATIOS, PREVIEW_RATIO_ORDER, VIDEO_RATIO_ORDER, PREVIEW_EXTS, VIDEO_EXTS,
    buildWantedFilenames, pickByRatioPreference,
  };
}
