// renderer/drive-path.js
// Pure path derivation for Google Drive delivery: which app folder a task
// belongs to, which month folder, parsing folder IDs out of pasted Drive
// URLs, and splitting deliverables from project/source files. No DOM, no IO —
// mirrors the drive-links.js / notifications-data.js split so it runs under
// plain Jest.

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Project/source files. Excluded while testing the automation, included in
// the final version — clients receive the editable project, not just renders.
const PROJECT_FILE_EXTS = ['aep', 'psd', 'ai', 'prproj', 'aet', 'c4d', 'blend'];

// The app code is the first underscore-separated token of the task Name,
// e.g. "CMC_1427_1426_..." -> "CMC". Returns null when there is no usable
// leading token, so callers abort rather than guessing a destination.
function appCodeFromTaskName(name) {
  if (typeof name !== 'string') return null;
  // Require an underscore: a name without one doesn't follow the convention at
  // all, which is worth reporting differently from "valid code, not configured".
  if (!name.includes('_')) return null;
  const token = name.split('_')[0];
  return token ? token : null;
}

// "2026-08-19" -> "08_August". `todayISO` is passed in rather than read from
// the clock here, consistent with the other pure modules.
function monthFolderName(todayISO) {
  if (typeof todayISO !== 'string') return null;
  const m = todayISO.match(/^\d{4}-(\d{2})-\d{2}$/);
  if (!m) return null;
  const monthNum = Number(m[1]);
  if (monthNum < 1 || monthNum > 12) return null;
  return `${m[1]}_${MONTH_NAMES[monthNum - 1]}`;
}

// Looks up the configured Drive folder ID for an app code. Returns null for an
// unrecognized or blank entry — mirror apps (e.g. "LV") are expected and must
// abort rather than fall back to any other folder.
function resolveAppFolderId(code, mapping) {
  if (!code || !mapping) return null;
  const id = mapping[code];
  return id ? id : null;
}

// Accepts a pasted Drive folder URL (with or without a /u/N/ segment or query
// string) or a bare folder ID, and returns the ID.
function parseFolderIdFromUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const m = url.match(/^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]+$/.test(url)) return url;
  return null;
}

// Splits a task folder's files into what will ship and what won't, so the
// caller can show both. Files with no extension count as deliverables.
function partitionUploadFiles(filePaths, includeProjectFiles) {
  if (includeProjectFiles) return { include: [...filePaths], excluded: [] };
  const include = [];
  const excluded = [];
  filePaths.forEach(p => {
    const base = p.split('/').pop();
    const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
    (ext && PROJECT_FILE_EXTS.includes(ext) ? excluded : include).push(p);
  });
  return { include, excluded };
}


// Mirror apps use a different leading code but deliver into the SAME folder as
// their base app (e.g. BL alongside PL -> Plamfy_creatives). Combining them
// into one lookup map keeps resolveAppFolderId unchanged.
function buildFolderMap(baseFolders, mirrors) {
  const map = { ...(baseFolders || {}) };
  Object.entries(mirrors || {}).forEach(([base, codes]) => {
    const id = (baseFolders || {})[base];
    // A mirror of an unconfigured base resolves to nothing, so it aborts rather
    // than silently delivering somewhere unintended.
    if (!id) return;
    (codes || []).forEach(raw => {
      const code = String(raw).trim();
      // Never override a real base entry: if a mirror code later becomes its
      // own app with its own folder, that folder wins.
      if (code && !map[code]) map[code] = id;
    });
  });
  return map;
}

// Parses a free-text mirror field ("BL, XX bl") into unique uppercase codes.
function parseMirrorCodes(input) {
  if (typeof input !== 'string') return [];
  const out = [];
  input.split(/[\s,]+/).forEach(raw => {
    const code = raw.trim().toUpperCase();
    if (code && /^[A-Z0-9]+$/.test(code) && !out.includes(code)) out.push(code);
  });
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MONTH_NAMES,
    PROJECT_FILE_EXTS,
    appCodeFromTaskName,
    monthFolderName,
    resolveAppFolderId,
    parseFolderIdFromUrl,
    partitionUploadFiles,
    buildFolderMap,
    parseMirrorCodes,
  };
}
