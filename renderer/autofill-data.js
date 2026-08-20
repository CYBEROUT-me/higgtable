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

// All candidate filenames to search for, so one directory walk covers every
// ratio rather than one walk per guess.
function buildWantedFilenames(bases, ratios) {
  const out = [];
  [...new Set(bases)].forEach(base => {
    ratios.forEach(r => {
      ['png', 'mp4'].forEach(ext => {
        const name = `${base}_${r}.${ext}`;
        if (!out.includes(name)) out.push(name);
      });
    });
  });
  return out;
}

// Returns the first ratio present in `found`, following `order`.
function pickByRatioPreference(base, found, order, ext) {
  for (const ratio of order) {
    const filename = `${base}_${ratio}.${ext}`;
    if (found && found[filename]) return { filename, path: found[filename], ratio };
  }
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RATIOS, PREVIEW_RATIO_ORDER, VIDEO_RATIO_ORDER, buildWantedFilenames, pickByRatioPreference };
}
