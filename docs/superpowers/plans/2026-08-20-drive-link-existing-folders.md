# Link Existing Drive Folders to Tasks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user uploads folders to Drive by hand; HiggTable finds each selected task's folder by exact name and writes its URL into the Airtable `Creative Link` field.

**Architecture:** A new dependency-free pure module (`renderer/drive-link.js`) holds all planning and matching logic and is Jest-tested. A new read-only function in `drive-browser.js` walks month folders and reuses that module for matching. One IPC handler connects them, and one new bulk button in the renderer drives it. The existing upload machinery is untouched and merely hidden.

**Tech Stack:** Electron (main/renderer split, `ipcMain.handle` + `contextBridge`), plain browser JS in the renderer, Jest for the pure modules.

## Global Constraints

- NEVER write an unverified link to Airtable.
- Unrecognized app code is skipped and reported, never guessed.
- This flow is READ-ONLY in Drive: no folder creation anywhere, including the month folder.
- Test mode reads from `driveTestFolderId` and performs no Airtable write.
- Do not modify the single-task or bulk upload logic — only hide the buttons.
- Run `npm test` after each task; 96 tests currently pass and must keep passing.
- Pure modules end with the project footer: `if (typeof module !== 'undefined' && module.exports) { module.exports = { ... }; }`

---

## File Structure

| File | Responsibility |
|---|---|
| `renderer/drive-link.js` (new) | Pure planning + matching. No DOM, no Electron, no requires. |
| `tests/drive-link.test.js` (new) | Full coverage of the above. |
| `drive-browser.js` (modify) | `findFoldersByNames` — read-only Drive traversal. |
| `main.js` (modify) | `drive-find-folders` IPC handler. |
| `preload.js` (modify) | `driveFindFolders` bridge. |
| `renderer/app.js` (modify) | `linkSelectedFromDrive()` + button wiring + null-guards. |
| `renderer/index.html` (modify) | New button, new `<script>`, upload buttons commented out. |

**Decomposition note:** `planLinkRun` deliberately does NOT resolve app codes. If it did, this pure module would need `drive-path.js`, which is a `<script>` global in the browser and a `require` under Node — an awkward dual dependency. Instead `app.js` resolves codes (it already does exactly this in `uploadSelectedToDrive`) and passes annotated candidates in. `drive-link.js` stays dependency-free and trivially testable.

---

## Task 1: Pure planning and matching module

**Files:**
- Create: `renderer/drive-link.js`
- Create: `tests/drive-link.test.js`
- Modify: `renderer/index.html` (add `<script src="drive-link.js"></script>` before `app.js`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `planLinkRun({ candidates, testFolderId, testMode })` → `{ plans, skipped }`
    - `candidates`: `[{ recordId, taskName, code, appFolderId, existingLink }]`
    - `plans`: `[{ recordId, taskName, destFolderId }]`
    - `skipped`: `[{ taskName, reason }]`
  - `matchTasksToFolders(taskNames, items)` → `{ matched, duplicates, unmatched }`
    - `items`: `[{ id, name, isFolder }]`; `matched`: `{ [taskName]: folderId }`
  - `monthSearchOrder(items, currentMonthName)` → `[{ id, name }]`

- [ ] **Step 1: Write the failing tests**

Create `tests/drive-link.test.js`:

```js
const { planLinkRun, matchTasksToFolders, monthSearchOrder } = require('../renderer/drive-link');

const cand = (over = {}) => ({
  recordId: 'rec1', taskName: 'HC_1952_Stat_NEW_9x16',
  code: 'HC', appFolderId: 'appHC', existingLink: '', ...over,
});

describe('planLinkRun', () => {
  test('plans a task whose app folder is configured', () => {
    const r = planLinkRun({ candidates: [cand()], testFolderId: '', testMode: false });
    expect(r.plans).toEqual([{ recordId: 'rec1', taskName: 'HC_1952_Stat_NEW_9x16', destFolderId: 'appHC' }]);
    expect(r.skipped).toEqual([]);
  });

  test('skips an unconfigured app code and names it', () => {
    const r = planLinkRun({ candidates: [cand({ code: 'ZZ', appFolderId: null })], testFolderId: '', testMode: false });
    expect(r.plans).toEqual([]);
    expect(r.skipped).toEqual([{ taskName: 'HC_1952_Stat_NEW_9x16', reason: 'no Drive folder configured for "ZZ"' }]);
  });

  test('reports a missing app code as "?" rather than guessing', () => {
    const r = planLinkRun({ candidates: [cand({ code: '', appFolderId: null })], testFolderId: '', testMode: false });
    expect(r.skipped[0].reason).toBe('no Drive folder configured for "?"');
  });

  test('skips a task that already has a Creative Link', () => {
    const r = planLinkRun({ candidates: [cand({ existingLink: 'https://drive.google.com/drive/folders/x' })], testFolderId: '', testMode: false });
    expect(r.plans).toEqual([]);
    expect(r.skipped).toEqual([{ taskName: 'HC_1952_Stat_NEW_9x16', reason: 'already has a Creative Link' }]);
  });

  test('treats a whitespace-only Creative Link as empty', () => {
    const r = planLinkRun({ candidates: [cand({ existingLink: '   ' })], testFolderId: '', testMode: false });
    expect(r.plans).toHaveLength(1);
  });

  test('test mode redirects every plan to the test folder', () => {
    const r = planLinkRun({
      candidates: [cand(), cand({ recordId: 'rec2', code: 'PL', appFolderId: 'appPL' })],
      testFolderId: 'testF', testMode: true,
    });
    expect(r.plans.map(p => p.destFolderId)).toEqual(['testF', 'testF']);
  });

  test('test mode still skips unconfigured codes', () => {
    const r = planLinkRun({ candidates: [cand({ code: 'ZZ', appFolderId: null })], testFolderId: 'testF', testMode: true });
    expect(r.plans).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });
});

describe('matchTasksToFolders', () => {
  const items = [
    { id: 'f1', name: 'HC_1952_Stat_NEW_9x16', isFolder: true },
    { id: 'f2', name: 'HC_1953_Stat_VAR_9x16', isFolder: true },
    { id: 'x1', name: 'HC_1954_Stat_VAR_9x16', isFolder: false },
  ];

  test('matches exactly and reports the rest as unmatched', () => {
    const r = matchTasksToFolders(['HC_1952_Stat_NEW_9x16', 'HC_9999_Stat_NEW_9x16'], items);
    expect(r.matched).toEqual({ HC_1952_Stat_NEW_9x16: 'f1' });
    expect(r.unmatched).toEqual(['HC_9999_Stat_NEW_9x16']);
    expect(r.duplicates).toEqual([]);
  });

  test('ignores files, matching only folders', () => {
    const r = matchTasksToFolders(['HC_1954_Stat_VAR_9x16'], items);
    expect(r.matched).toEqual({});
    expect(r.unmatched).toEqual(['HC_1954_Stat_VAR_9x16']);
  });

  test('never matches on a prefix', () => {
    const r = matchTasksToFolders(['HC_1952_Stat'], items);
    expect(r.unmatched).toEqual(['HC_1952_Stat']);
  });

  test('reports duplicates instead of picking one', () => {
    const dup = [...items, { id: 'f9', name: 'HC_1952_Stat_NEW_9x16', isFolder: true }];
    const r = matchTasksToFolders(['HC_1952_Stat_NEW_9x16'], dup);
    expect(r.matched).toEqual({});
    expect(r.duplicates).toEqual(['HC_1952_Stat_NEW_9x16']);
    expect(r.unmatched).toEqual([]);
  });

  test('handles an empty listing', () => {
    const r = matchTasksToFolders(['HC_1952_Stat_NEW_9x16'], []);
    expect(r.matched).toEqual({});
    expect(r.unmatched).toEqual(['HC_1952_Stat_NEW_9x16']);
  });
});

describe('monthSearchOrder', () => {
  const items = [
    { id: 'm7', name: '07_July', isFolder: true },
    { id: 'm8', name: '08_August', isFolder: true },
    { id: 'm6', name: '06_June', isFolder: true },
    { id: 'file', name: 'notes.txt', isFolder: false },
  ];

  test('puts the current month first, then the rest newest-first', () => {
    expect(monthSearchOrder(items, '08_August')).toEqual([
      { id: 'm8', name: '08_August' },
      { id: 'm7', name: '07_July' },
      { id: 'm6', name: '06_June' },
    ]);
  });

  test('omits files', () => {
    expect(monthSearchOrder(items, '08_August').some(f => f.name === 'notes.txt')).toBe(false);
  });

  test('still returns every folder when the current month is absent', () => {
    expect(monthSearchOrder(items, '12_December').map(f => f.name)).toEqual(['08_August', '07_July', '06_June']);
  });

  test('returns an empty list for an empty listing', () => {
    expect(monthSearchOrder([], '08_August')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- drive-link`
Expected: FAIL — `Cannot find module '../renderer/drive-link'`

- [ ] **Step 3: Implement the module**

Create `renderer/drive-link.js`:

```js
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
  const rest = folders.filter(f => f.name !== currentMonthName).sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return [...current, ...rest];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { planLinkRun, matchTasksToFolders, monthSearchOrder };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all suites green, 96 prior tests still passing.

- [ ] **Step 5: Load the module in the renderer**

In `renderer/index.html`, add the script immediately after the `drive-bulk.js` line and before `app.js`:

```html
  <script src="drive-bulk.js"></script>
  <script src="drive-link.js"></script>
  <script src="autofill-data.js"></script>
  <script src="app.js"></script>
```

- [ ] **Step 6: Commit**

```bash
git add renderer/drive-link.js tests/drive-link.test.js renderer/index.html
git commit -m "Add pure planning and matching for linking existing Drive folders"
```

---

## Task 2: Read-only Drive lookup

**Files:**
- Modify: `drive-browser.js` (add `findFoldersByNames`, extend `module.exports`)
- Modify: `main.js` (add the `drive-find-folders` handler next to `drive-upload-folder`)
- Modify: `preload.js` (add `driveFindFolders`)

**Interfaces:**
- Consumes: `matchTasksToFolders`, `monthSearchOrder` from Task 1, via `require('./renderer/drive-link')`. Both are dependency-free, so this require is clean. Also the existing `openFolderForWork(folderId)`, `readListingHere(win, opts)`, `ensureLoggedIn({ trustCurrentPage })`, `logFn`, `inFlight`.
- Produces: `findFoldersByNames({ appFolderId, monthName, taskNames })` → `{ matched, duplicates, unmatched, searched }` where `matched` is `{ [taskName]: folderId }` and `searched` is `[monthFolderName]`. Renderer-side: `window.app.driveFindFolders(payload)`.

**Verification note:** this task cannot be verified by the implementer — it needs the user's authenticated Google session. It ends with syntax checks and the full Jest suite; the user verifies it in Task 3's test-mode run.

- [ ] **Step 1: Add the require**

In `drive-browser.js`, beside the existing `drive-probes` require (line 13):

```js
const { PROBES, PREFLIGHT_PROBES } = require('./drive-probes');
const { matchTasksToFolders, monthSearchOrder } = require('./renderer/drive-link');
```

- [ ] **Step 2: Implement the lookup**

Add to `drive-browser.js`, immediately before `module.exports`:

```js
// Finds already-uploaded task folders by EXACT name. READ-ONLY: this function
// never creates anything in Drive, not even the month folder — if the month
// folder is missing the search simply widens to the other months and then
// reports. Duplicated so the upload path's guard is left untouched.
async function findFoldersByNames(args) {
  if (inFlight) {
    throw new Error('a Drive operation is already running — wait for it to finish before starting another');
  }
  const watchdog = new Promise((_r, reject) =>
    setTimeout(() => reject(new Error('Drive lookup timed out after 5 minutes — check higgtable.log for the last [drive] step reached')), 300000));
  inFlight = Promise.race([doFindFoldersByNames(args), watchdog]).finally(() => { inFlight = null; });
  return inFlight;
}

async function doFindFoldersByNames({ appFolderId, monthName, taskNames }) {
  if (!appFolderId) throw new Error('no Drive folder configured for this app code');
  if (!Array.isArray(taskNames) || !taskNames.length) throw new Error('no task names to look up');

  const login = await ensureLoggedIn({ trustCurrentPage: true });
  if (!login.loggedIn) throw new Error('not signed in to Google — sign in the Drive window, then retry');

  // The month folder's id only exists in its parent's listing, so the parent has
  // to be read first. That same listing supplies the widen step's candidates.
  const appWin = await openFolderForWork(appFolderId);
  const monthFolders = monthSearchOrder(await readListingHere(appWin), monthName);
  logFn(`findFoldersByNames: ${taskNames.length} task(s), ${monthFolders.length} month folder(s) under ${appFolderId}`);

  const matched = {};
  const duplicates = [];
  const searched = [];
  let remaining = taskNames.slice();

  for (const folder of monthFolders) {
    if (!remaining.length) break;
    const win = await openFolderForWork(folder.id);
    const result = matchTasksToFolders(remaining, await readListingHere(win));
    Object.assign(matched, result.matched);
    for (const d of result.duplicates) if (!duplicates.includes(d)) duplicates.push(d);
    searched.push(folder.name);
    // A duplicate is a decided outcome, not something to keep hunting for.
    remaining = result.unmatched;
    logFn(`findFoldersByNames: ${folder.name} -> matched ${Object.keys(result.matched).length}, ${remaining.length} still missing`);
  }

  return { matched, duplicates, unmatched: remaining, searched };
}
```

Then add it to `module.exports` alongside `uploadFolderToDrive`:

```js
  findFoldersByNames,
```

- [ ] **Step 3: Add the IPC handler**

In `main.js`, immediately before the `drive-upload-folder` handler:

```js
ipcMain.handle('drive-find-folders', async (_e, payload) => {
  try {
    log(`drive-find-folders: ${(payload && payload.taskNames || []).length} task(s) under ${payload && payload.appFolderId}`);
    return await driveBrowser.findFoldersByNames(payload);
  } catch (err) {
    log(`drive-find-folders FAILED: ${err.message}`);
    return { error: err.message };
  }
});
```

- [ ] **Step 4: Expose it in preload**

In `preload.js`, after `driveUploadFolder`:

```js
  driveFindFolders: (payload)      => ipcRenderer.invoke('drive-find-folders', payload),
```

- [ ] **Step 5: Verify syntax and confirm the read-only rule**

Run:
```bash
node --check drive-browser.js && node --check main.js && node --check preload.js && npm test
```
Expected: all three parse; Jest reports all suites passing.

Then confirm no folder creation crept in:
```bash
sed -n '/^async function doFindFoldersByNames/,/^}/p' drive-browser.js | grep -c createFolder
```
Expected: `0`

- [ ] **Step 6: Commit**

```bash
git add drive-browser.js main.js preload.js
git commit -m "Find already-uploaded task folders in Drive by exact name"
```

---

## Task 3: The "Link from Drive" bulk action

**Files:**
- Modify: `renderer/index.html` (add `#bulk-drive-link-btn` to `#bulk-actions-bar`)
- Modify: `renderer/app.js` (add `linkSelectedFromDrive()` and its listener)

**Interfaces:**
- Consumes: `planLinkRun` (Task 1), `window.app.driveFindFolders` (Task 2), and the existing globals `appCodeFromTaskName`, `buildFolderMap`, `resolveAppFolderId`, `monthFolderName`, `toISO`, `log`, `render`, `state`.
- Produces: user-facing behaviour only.

**Verification note:** the Drive half needs the user's Google session. This task ends with the user running it in TEST MODE against their scratch folder.

- [ ] **Step 1: Add the button**

In `renderer/index.html`, inside `#bulk-actions-bar`, immediately after `#bulk-autofill-btn`:

```html
      <button id="bulk-drive-link-btn" title="Find each selected task's folder in Google Drive by name and fill Creative Link">Link from Drive</button>
```

- [ ] **Step 2: Implement the action**

In `renderer/app.js`, immediately before `async function uploadSelectedToDrive()`:

```js
// Links tasks to folders the user has ALREADY uploaded to Drive by hand. Reads
// Drive, never writes to it. A link reaches Airtable only for an exact,
// unambiguous folder-name match.
async function linkSelectedFromDrive() {
  if (!state.selectedIds.size) return;

  const records = state.records.filter(r => state.selectedIds.has(r.id) && r.fields['Name']);
  if (!records.length) return;

  const folderMap = buildFolderMap(state.driveAppFolders, state.driveAppMirrors);
  const monthName = monthFolderName(toISO(new Date()));

  const candidates = records.map(rec => {
    const taskName = rec.fields['Name'];
    const code = appCodeFromTaskName(taskName);
    return {
      recordId: rec.id,
      taskName,
      code,
      appFolderId: resolveAppFolderId(code, folderMap),
      existingLink: rec.fields['Creative Link'],
    };
  });

  const { plans, skipped } = planLinkRun({
    candidates,
    testFolderId: state.driveTestFolderId,
    testMode: state.driveTestMode,
  });

  if (state.driveTestMode && !state.driveTestFolderId) {
    alert('Test mode is on but no test folder is set (Settings → Drive Delivery Folders).');
    return;
  }
  if (!plans.length) {
    alert(`Nothing to link.\n\n${skipped.map(s => `  ${s.taskName} — ${s.reason}`).join('\n')}`);
    return;
  }

  const lines = [
    ...plans.map(p => `  ${p.taskName}  ->  look up in ${monthName}`),
    ...skipped.map(s => `  ${s.taskName}  ->  SKIP (${s.reason})`),
  ];
  const banner = state.driveTestMode
    ? 'TEST MODE — reading the test folder and NOT writing Creative Link.\n\n'
    : '';
  if (!confirm(`${banner}Look up ${plans.length} task folder(s) in Drive and fill Creative Link?\n\n${lines.join('\n')}`)) return;

  // One lookup per destination, so a folder is read once no matter how many
  // tasks point at it.
  const byDest = {};
  for (const p of plans) (byDest[p.destFolderId] = byDest[p.destFolderId] || []).push(p);

  const btn = document.getElementById('bulk-drive-link-btn');
  btn.disabled = true;
  const results = [...skipped.map(s => ({ task: s.taskName, skipped: s.reason }))];
  const writes = [];

  try {
    const dests = Object.keys(byDest);
    for (let i = 0; i < dests.length; i++) {
      const dest = dests[i];
      const group = byDest[dest];
      btn.textContent = `Looking up ${i + 1}/${dests.length}...`;

      const res = await window.app.driveFindFolders({
        appFolderId: dest,
        monthName,
        taskNames: group.map(p => p.taskName),
      });

      // A failed destination must not sink the others.
      if (!res || res.error) {
        for (const p of group) results.push({ task: p.taskName, error: (res && res.error) || 'unknown error' });
        continue;
      }

      const where = res.searched && res.searched.length ? res.searched.join(', ') : 'no month folders found';
      for (const p of group) {
        const folderId = res.matched[p.taskName];
        if (folderId) {
          const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
          writes.push({ recordId: p.recordId, taskName: p.taskName, folderUrl });
        } else if ((res.duplicates || []).includes(p.taskName)) {
          results.push({ task: p.taskName, error: `more than one folder named "${p.taskName}" — resolve it in Drive` });
        } else {
          results.push({ task: p.taskName, error: `no folder named "${p.taskName}" (searched: ${where})` });
        }
      }
    }

    if (writes.length && !state.driveTestMode) {
      const tableId = state.tables[state.activeTable].id;
      try {
        await window.airtable.updateRecords(state.baseId, tableId,
          writes.map(w => ({ id: w.recordId, fields: { 'Creative Link': w.folderUrl } })));
        for (const w of writes) {
          const rec = state.records.find(r => r.id === w.recordId);
          if (rec) rec.fields['Creative Link'] = w.folderUrl;
          results.push({ task: w.taskName, folderUrl: w.folderUrl });
        }
      } catch (err) {
        for (const w of writes) results.push({ task: w.taskName, error: `found the folder, but Creative Link not written: ${err.message}` });
      }
    } else {
      for (const w of writes) results.push({ task: w.taskName, folderUrl: w.folderUrl });
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Link from Drive';
  }

  const s = summarizeBulkRun(results);
  log(`linkSelectedFromDrive: ${s.delivered} linked, ${s.skipped} skipped, ${s.failed} failed`);
  alert(`${state.driveTestMode ? 'TEST MODE — Creative Link not written.\n\n' : ''}Linked ${s.delivered}, skipped ${s.skipped}, failed ${s.failed}.\n\n${s.lines.join('\n')}`);
  render();
}
```

- [ ] **Step 3: Wire the listener**

In `renderer/app.js`, beside the existing bulk button listeners (near line 2213):

```js
document.getElementById('bulk-drive-link-btn').addEventListener('click', () => {
  if (document.getElementById('bulk-drive-link-btn').disabled) return;
  linkSelectedFromDrive();
});
```

- [ ] **Step 4: Verify syntax and tests**

Run: `node --check renderer/app.js && npm test`
Expected: parses; all suites pass.

- [ ] **Step 5: Commit**

```bash
git add renderer/app.js renderer/index.html
git commit -m "Add the Link from Drive bulk action"
```

- [ ] **Step 6: Hand over to the user for a test-mode run**

Tell the user to: enable Test mode with the scratch folder set, upload two task folders into `<test folder>/<MM_Month>/` by hand, select those tasks plus one with no matching folder, and run **Link from Drive**. Expected: the two are reported linked with no Airtable write, the third is reported not found with the searched months named.

---

## Task 4: Hide the upload buttons

**Files:**
- Modify: `renderer/index.html` (comment out `#bulk-drive-upload-btn` and `#drive-upload-btn`)
- Modify: `renderer/app.js:2213-2215, 2334` (null-guard the listeners)

**Interfaces:**
- Consumes: nothing. Produces: nothing. Behaviour-only change.

**Critical:** `renderer/app.js` currently calls `document.getElementById('bulk-drive-upload-btn').addEventListener(...)` and `document.getElementById('drive-upload-btn').addEventListener(...)` with no null check. Commenting out the HTML without guarding these throws a `TypeError` at load and the whole renderer dies. Guard first, then comment out.

- [ ] **Step 1: Null-guard the two listeners**

In `renderer/app.js`, replace the `bulk-drive-upload-btn` listener block:

```js
// Drive upload is retained but hidden — see renderer/index.html. Guarded so the
// renderer still loads while the button is commented out.
const bulkUploadBtn = document.getElementById('bulk-drive-upload-btn');
if (bulkUploadBtn) {
  bulkUploadBtn.addEventListener('click', () => {
    if (bulkUploadBtn.disabled) return;
    uploadSelectedToDrive();
  });
}
```

and the `drive-upload-btn` listener:

```js
const driveUploadBtn = document.getElementById('drive-upload-btn');
if (driveUploadBtn) driveUploadBtn.addEventListener('click', uploadTaskToDrive);
```

- [ ] **Step 2: Guard the in-function lookups**

`uploadSelectedToDrive()` (near line 1629) and `uploadTaskToDrive()` (near line 1753) each do `const btn = document.getElementById(...)` then set `btn.disabled` / `btn.textContent`. Neither function can run while its button is hidden, but leaving an unguarded dereference in code that is meant to be revivable is a trap. In both functions, replace every bare `btn.` usage with an optional-chained form, e.g.:

```js
  const btn = document.getElementById('bulk-drive-upload-btn');
  if (btn) btn.disabled = true;
```

and in the `finally` block:

```js
    if (btn) { btn.disabled = false; btn.textContent = 'Upload to Drive'; }
```

Apply the same treatment in `uploadTaskToDrive()` for `drive-upload-btn`.

- [ ] **Step 3: Comment out the buttons**

In `renderer/index.html`, in `#bulk-actions-bar`:

```html
      <!-- Drive upload is retained in code (drive-browser.js uploadFolderToDrive,
           the drive-upload-folder IPC handler, and their tests) but hidden: folders
           are uploaded to Drive by hand, then matched with "Link from Drive", which
           is far faster. Uncomment this button to restore the automated upload. -->
      <!-- <button id="bulk-drive-upload-btn" title="Upload each selected task's folder to Google Drive and fill Creative Link">Upload to Drive</button> -->
```

and in `#rename-footer`:

```html
      <!-- Single-task Drive upload, retained in code but hidden — see the note in
           #bulk-actions-bar. Uncomment to restore it. -->
      <!-- <button id="drive-upload-btn" title="Upload this task's folder to Google Drive and fill Creative Link">Upload to Drive</button> -->
```

- [ ] **Step 4: Verify nothing else references the hidden ids unguarded**

Run:
```bash
grep -n "bulk-drive-upload-btn\|drive-upload-btn" renderer/app.js
```
Expected: every remaining hit is inside an `if (...)` guard or an optional-chained assignment. No bare `.addEventListener` or `.disabled` on the result of `getElementById`.

Then confirm the upload machinery is still intact:
```bash
grep -c "uploadFolderToDrive" drive-browser.js main.js
```
Expected: non-zero for both — nothing was deleted.

- [ ] **Step 5: Verify the app still loads**

Run: `node --check renderer/app.js && npm test`
Expected: parses; all suites pass.

Then have the user launch the app and confirm the bulk bar shows **Link from Drive** and no **Upload to Drive**, the task panel shows no **Upload to Drive**, and the DevTools console is free of `TypeError`.

- [ ] **Step 6: Commit**

```bash
git add renderer/index.html renderer/app.js
git commit -m "Hide the Drive upload buttons in favour of Link from Drive"
```

---

## Self-Review

**Spec coverage:** entry point and button label → Task 3 Step 1. Resolve app folder / skip unconfigured → Task 1 `planLinkRun` + Task 3 candidate mapping. Skip existing links → Task 1. Test mode → Tasks 1 and 3. Read parent then month, two reads per destination → Task 2 Step 2. Widen newest-first → Task 1 `monthSearchOrder` + Task 2 loop. Exact matching, duplicates fail → Task 1 `matchTasksToFolders`. URL derivation → Task 3. Batched `updateRecords` → Task 3. Summary categories → Task 3 via `summarizeBulkRun`. Read-only in Drive → Task 2 Step 5 check. Expired session → inherited from `openFolderForWork`; destination-level errors continue → Task 3. Hiding upload buttons → Task 4.

**Placeholder scan:** none — every step carries real code or a real command.

**Type consistency:** `matched` is `{ [taskName]: folderId }` in Tasks 1, 2 and 3. `plans` entries are `{ recordId, taskName, destFolderId }` in Tasks 1 and 3. `monthSearchOrder` returns `{ id, name }`, consumed as `folder.id` / `folder.name` in Task 2. `findFoldersByNames` returns `{ matched, duplicates, unmatched, searched }`, all four read in Task 3. `summarizeBulkRun` receives the same `{ task, folderUrl } | { task, skipped } | { task, error }` shapes it already handles for the upload run.
