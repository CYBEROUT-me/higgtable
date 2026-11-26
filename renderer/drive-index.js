// renderer/drive-index.js
// Pure helpers for finding each task's folder on Google Drive (read through
// rclone by main.js). No DOM, no IO, so main.js requires it too and Jest runs it.
//
// Drive layout: <root> / <App>_creatives / <YYYY> / <MM_Month> / <full task name> /
// A task's Creative Link is the link to its own folder. Which <App>_creatives a
// task-name prefix (LO, LiV, TLN, …) lives in is learned from the folders
// themselves, so no table has to be kept by hand.

const DRIVE_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Cyrillic letters that look like Latin ones. Task names typed by hand on a
// Ukrainian layout sometimes carry them ("LO_7501_7500_М60_…" with a Cyrillic М),
// which makes two identical-looking names different strings.
const HOMOGLYPHS = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', І: 'I',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i',
};

// Comparable form of a task name: homoglyphs to Latin, trimmed, upper case.
function normalizeTaskName(name) {
  return String(name || '').replace(/[А-яІі]/g, ch => HOMOGLYPHS[ch] || ch).trim().toUpperCase();
}

// The task-name prefix ("LO", "LIV", "TLN"), normalised, or null.
function taskCode(name) {
  const m = /^([A-Z0-9]+)_/.exec(normalizeTaskName(name));
  return m ? m[1] : null;
}

// "2026-11" -> { year: '2026', folder: '11_November' }.
function monthFolder(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return { year: m[1], folder: `${m[2]}_${DRIVE_MONTH_NAMES[Number(m[2]) - 1]}` };
}

function prevMonth(ym) {
  let [y, m] = ym.split('-').map(Number);
  m -= 1;
  if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// Months to look in, most likely first: this month, the month before (work
// handed in around the 1st), then the months of the given dates (Date Done,
// task day). At most `max`.
function monthsToSearch(todayISO, dates = [], max = 3) {
  const out = [];
  const add = ym => { if (ym && monthFolder(ym) && !out.includes(ym)) out.push(ym); };
  const current = String(todayISO).slice(0, 7);
  add(current);
  add(prevMonth(current));
  dates.forEach(d => add(String(d || '').slice(0, 7)));
  return out.slice(0, max);
}

// Counts task-name prefixes in one app folder's listing into `counts`
// ({ CODE: { appFolder: n } }), so the mapping can be learned.
function countCodes(appFolder, taskFolderNames, counts) {
  taskFolderNames.forEach(name => {
    const code = taskCode(name);
    if (!code) return;
    counts[code] = counts[code] || {};
    counts[code][appFolder] = (counts[code][appFolder] || 0) + 1;
  });
  return counts;
}

// CODE -> the app folder holding most of its tasks. A stray task filed in the
// wrong app (one CMC folder inside Lowins) does not move the whole code.
function codeMapFromCounts(counts) {
  const map = {};
  Object.entries(counts || {}).forEach(([code, byApp]) => {
    const best = Object.entries(byApp).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best) map[code] = best[0];
  });
  return map;
}

// For each task name, the Drive folders with that name in the given listings
// (each { path, entries: [{ Name, ID, ModTime }] }), newest first.
function matchTaskFolders(names, listings) {
  const index = new Map();
  (listings || []).forEach(({ path, entries }) => (entries || []).forEach(e => {
    const key = normalizeTaskName(e.Name);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ id: e.ID, path: `${path}/${e.Name}`, modTime: e.ModTime || '' });
  }));
  const out = {};
  (names || []).forEach(name => {
    const hits = (index.get(normalizeTaskName(name)) || []).slice()
      .sort((a, b) => String(b.modTime).localeCompare(String(a.modTime)));
    out[name] = hits;
  });
  return out;
}

function driveFolderLink(id) {
  return `https://drive.google.com/drive/folders/${id}`;
}

// A folder id from a pasted Drive folder URL or a bare id; null otherwise.
function folderIdFromInput(input) {
  const s = String(input || '').trim();
  const m = s.match(/^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeTaskName, taskCode, monthFolder, monthsToSearch, countCodes, codeMapFromCounts,
    matchTaskFolders, driveFolderLink, folderIdFromInput,
  };
}
