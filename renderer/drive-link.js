// renderer/drive-link.js
// Pure planning and matching for "Link from Drive": given the selected tasks and
// a Drive folder listing, decide which task maps to which folder id. No DOM, no
// Electron, no requires — so it is testable under Node and loadable as a plain
// <script> in the renderer.
//
// App-code resolution deliberately lives in app.js, not here: doing it here
// would make this module depend on drive-path.js, which is a <script> global in
// the browser and a require under Node.

// Partitions the selected tasks into what can be looked up and what cannot.
// A task is skipped — never guessed at — when its app code has no configured
// folder, or when it already has a Creative Link that must not be repointed.
function planLinkRun({ candidates, testFolderId, testMode }) {
  const plans = [];
  const skipped = [];
  for (const c of candidates || []) {
    if (!c.appFolderId) {
      skipped.push({ taskName: c.taskName, reason: `no Drive folder configured for "${c.code || '?'}"` });
      continue;
    }
    if (String(c.existingLink || '').trim()) {
      skipped.push({ taskName: c.taskName, reason: 'already has a Creative Link' });
      continue;
    }
    plans.push({
      recordId: c.recordId,
      taskName: c.taskName,
      destFolderId: testMode ? testFolderId : c.appFolderId,
    });
  }
  return { plans, skipped };
}

// Exact name matching only. A near-miss is reported unmatched and a repeated
// name is reported duplicate: writing a link to the wrong task is far worse
// than reporting that a folder could not be identified.
function matchTasksToFolders(taskNames, items) {
  const byName = new Map();
  for (const it of items || []) {
    if (!it || !it.isFolder) continue;
    const seen = byName.get(it.name);
    if (seen === undefined) byName.set(it.name, it.id);
    else byName.set(it.name, null); // null marks "more than one folder with this name"
  }
  const matched = {};
  const duplicates = [];
  const unmatched = [];
  for (const name of taskNames || []) {
    if (!byName.has(name)) unmatched.push(name);
    else if (byName.get(name) === null) duplicates.push(name);
    else matched[name] = byName.get(name);
  }
  return { matched, duplicates, unmatched };
}

// Month folders to search, cheapest-first. Names are "MM_Month", so sorting the
// remainder descending puts recent months first within a year. This is a cost
// heuristic only — the caller searches until everything is matched or the
// folders run out, so correctness does not depend on the order.
function monthSearchOrder(items, currentMonthName) {
  const folders = (items || []).filter(i => i && i.isFolder).map(i => ({ id: i.id, name: i.name }));
  const current = folders.filter(f => f.name === currentMonthName);
  const rest = folders
    .filter(f => f.name !== currentMonthName)
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return [...current, ...rest];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { planLinkRun, matchTasksToFolders, monthSearchOrder };
}
