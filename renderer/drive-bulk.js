// renderer/drive-bulk.js
// Pure classification/formatting for a bulk Drive delivery run. No DOM, no IO —
// mirrors the drive-path.js / notifications-data.js split so it runs under Jest.

// A task with neither a folderUrl nor an explicit skip reason counts as FAILED,
// never as success: silently treating an unknown outcome as delivered is how a
// creative goes missing without anyone noticing.
function classifyBulkResult(r) {
  if (r && r.folderUrl) return 'delivered';
  if (r && r.skipped) return 'skipped';
  return 'failed';
}

function summarizeBulkRun(results) {
  const out = { delivered: 0, skipped: 0, failed: 0, lines: [] };
  (results || []).forEach(r => {
    const kind = classifyBulkResult(r);
    out[kind]++;
    if (kind === 'delivered') out.lines.push(`OK    ${r.task}`);
    else if (kind === 'skipped') out.lines.push(`SKIP  ${r.task} — ${r.skipped}`);
    else out.lines.push(`FAIL  ${r.task} — ${(r && r.error) || 'unknown error'}`);
  });
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classifyBulkResult, summarizeBulkRun };
}
