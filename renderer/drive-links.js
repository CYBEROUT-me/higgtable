// renderer/drive-links.js
// Pure logic for rewriting Google Drive links to open with a specific
// Google account (via Drive's /u/N/ URL segment), so a link always opens
// with the account that actually has access to it, regardless of which
// Google account the browser currently defaults to. No DOM access here —
// mirrors the canvas-data.js / notifications-data.js / dashboard-data.js /
// markdown-data.js split so this can run under plain Jest.

// Inserts /u/<accountIndex>/ into a drive.google.com/drive/... URL that
// doesn't already have its own /u/N/ segment. `accountIndex` only takes
// effect when it's a non-negative integer (as a number or numeric string)
// — anything blank/non-numeric leaves `url` unchanged, and 0 is a valid,
// distinct value from "unset".
function rewriteDriveLink(url, accountIndex) {
  const idx = String(accountIndex == null ? '' : accountIndex).trim();
  if (!/^\d+$/.test(idx)) return url;
  const match = url.match(/^(https:\/\/drive\.google\.com\/drive\/)(?!u\/\d+\/)(.*)$/);
  if (!match) return url;
  return `${match[1]}u/${idx}/${match[2]}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rewriteDriveLink };
}
