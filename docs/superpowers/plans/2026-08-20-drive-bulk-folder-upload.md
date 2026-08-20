# Bulk Drive Delivery via Folder Upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver several selected tasks to Drive in one run — each local `<TASK_NAME>/` folder uploaded whole via Drive's "Folder upload", with a verified `Creative Link` written per task.

**Architecture:** A new pure module (`renderer/drive-bulk.js`) classifies and formats run results; two new main-process IPC helpers locate a task's local folder and strip `.DS_Store`; `drive-browser.js` gains `uploadFolderToDrive()` which creates only the **month** folder and lets Folder upload create the task folder; the renderer loops selected tasks sequentially and writes each link independently.

**Tech Stack:** Electron (CDP `Page.setInterceptFileChooserDialog` + `DOM.setFileInputFiles` with a **directory** path), plain JS, Jest for pure logic.

## Global Constraints

- **The single-task path is not modified.** `deliver()`, `uploadTaskToDrive()`, and the rename-panel button stay exactly as they are.
- **The task folder is never created by us** — Folder upload creates it. Only the **month** folder is find-or-created.
- **`.DS_Store` deletion is the only disk write**, and only: files named exactly `.DS_Store`, only inside the task folder, only when that folder is inside the working directory, each deletion logged.
- **`selectSingle`** ⇒ one folder per action ⇒ tasks run **sequentially**.
- **Progress-based waiting, not fixed deadlines** — a 99-file folder took ~26 min. Stall (no counter movement) is the failure signal.
- **Each task commits independently**; one failure never rolls back or blocks the others.
- **Test mode applies**: redirect to `driveTestFolderId`, skip the Airtable write.
- Tasks 3 and 4 cannot be verified by the implementing agent — they need the user's Google session and end with a user-run test.

---

### Task 1: Pure run-summary logic

**Files:** Create `renderer/drive-bulk.js`, `tests/drive-bulk.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `classifyBulkResult(r)` → `'delivered'|'skipped'|'failed'`; `summarizeBulkRun(results)` → `{ delivered, skipped, failed, lines }`. Task 4 imports both via the global script tag.

- [ ] **Step 1: Write the failing tests**

```javascript
const { classifyBulkResult, summarizeBulkRun } = require('../renderer/drive-bulk');

test('classifyBulkResult reads the outcome of one task', () => {
  expect(classifyBulkResult({ task: 'A', folderUrl: 'u' })).toBe('delivered');
  expect(classifyBulkResult({ task: 'A', skipped: 'no local folder' })).toBe('skipped');
  expect(classifyBulkResult({ task: 'A', error: 'boom' })).toBe('failed');
});

test('classifyBulkResult treats a missing outcome as failed rather than success', () => {
  expect(classifyBulkResult({ task: 'A' })).toBe('failed');
});

test('summarizeBulkRun counts each category', () => {
  const s = summarizeBulkRun([
    { task: 'A', folderUrl: 'u1' },
    { task: 'B', skipped: 'no Drive folder configured for code QQ' },
    { task: 'C', error: 'upload stalled' },
    { task: 'D', folderUrl: 'u2' },
  ]);
  expect(s.delivered).toBe(2);
  expect(s.skipped).toBe(1);
  expect(s.failed).toBe(1);
});

test('summarizeBulkRun lists every task with its reason', () => {
  const s = summarizeBulkRun([
    { task: 'A', folderUrl: 'u1' },
    { task: 'B', skipped: 'no local folder' },
    { task: 'C', error: 'upload stalled' },
  ]);
  expect(s.lines).toEqual([
    'OK    A',
    'SKIP  B — no local folder',
    'FAIL  C — upload stalled',
  ]);
});

test('summarizeBulkRun handles an empty run', () => {
  expect(summarizeBulkRun([])).toEqual({ delivered: 0, skipped: 0, failed: 0, lines: [] });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest tests/drive-bulk.test.js`
Expected: FAIL — `Cannot find module '../renderer/drive-bulk'`.

- [ ] **Step 3: Implement**

```javascript
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
```

- [ ] **Step 4: Verify**

Run: `npx jest tests/drive-bulk.test.js` → PASS (5/5). Then `npm test` → PASS 90/90 (85 + 5).

- [ ] **Step 5: Commit**

```bash
git add renderer/drive-bulk.js tests/drive-bulk.test.js
git commit -m "Add pure bulk-run summary logic"
```

---

### Task 2: Local folder lookup and .DS_Store removal

**Files:** Modify `main.js` (beside `find-asset-files`, ~line 400), `preload.js`

**Interfaces:**
- Consumes: existing `fs`, `path`, `log()` in `main.js`.
- Produces: `window.app.findTaskFolder(dir, name)` → `string|null`; `window.app.stripDsStore(folderPath, workingDir)` → `{ deleted: string[] }` or `{ error }`.

- [ ] **Step 1: Add both handlers to `main.js`**

Insert after the `find-asset-files` handler:

```javascript
// Finds a directory whose basename EXACTLY equals `name`, anywhere under `dir`.
// Exact match only: delivering into a similarly-named folder would put one
// task's files under another task's name.
function findDirByExactName(dir, name) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === name) return full;
    const nested = findDirByExactName(full, name);
    if (nested) return nested;
  }
  return null;
}

ipcMain.handle('find-task-folder', (_e, dir, name) => {
  if (!dir || !name) return null;
  return findDirByExactName(dir, name);
});

// Deletes ONLY files named exactly ".DS_Store", ONLY inside `folderPath`, and
// ONLY when that folder sits inside `workingDir`. Folder upload cannot filter,
// so this is the one place the feature writes to disk — it is deliberately
// narrow, and every deletion is logged.
ipcMain.handle('strip-ds-store', (_e, folderPath, workingDir) => {
  const target = path.resolve(folderPath || '');
  const root = path.resolve(workingDir || '');
  if (!target || !root || !(target === root || target.startsWith(root + path.sep))) {
    return { error: `refusing to touch ${target}: outside the working directory` };
  }
  const deleted = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === '.DS_Store') {
        try { fs.unlinkSync(full); deleted.push(full); log(`strip-ds-store: deleted ${full}`); }
        catch (err) { log(`strip-ds-store: could not delete ${full} — ${err.message}`); }
      }
    }
  };
  walk(target);
  return { deleted };
});
```

- [ ] **Step 2: Expose both in `preload.js`**

After `findAssetFilesInFolder`:

```javascript
  findTaskFolder:    (dir, name)   => ipcRenderer.invoke('find-task-folder', dir, name),
  stripDsStore:      (p, root)     => ipcRenderer.invoke('strip-ds-store', p, root),
```

- [ ] **Step 3: Verify the containment guard without Electron**

The guard is plain path logic, so check it directly:

Run:
```bash
node -e "
const path=require('path');
const inside=(t,r)=>{t=path.resolve(t);r=path.resolve(r);return t===r||t.startsWith(r+path.sep);};
const cases=[['/w/For GD/T','/w',true],['/w','/w',true],['/other/T','/w',false],['/w2/T','/w',false],['/w/../etc','/w',false]];
let ok=true;
for(const [t,r,want] of cases){const got=inside(t,r);if(got!==want)ok=false;console.log(got===want?'ok  ':'FAIL',t,'in',r,'->',got);}
process.exit(ok?0:1);"
```
Expected: all `ok`, notably `/w2/T` and `/w/../etc` rejected — the `+ path.sep` is what stops `/w2` passing as inside `/w`.

Then: `node --check main.js && node --check preload.js && npm test` → no syntax errors, 90/90.

- [ ] **Step 4: Commit**

```bash
git add main.js preload.js
git commit -m "Add task-folder lookup and scoped .DS_Store removal"
```

---

### Task 3: Folder upload in the browser layer

**Cannot be verified by the implementing agent** — needs the user's Google session.

**Files:** Modify `drive-probes.js`, `drive-browser.js`, `main.js`, `preload.js`

**Interfaces:**
- Consumes: `getDriveWindow`, `navigateToFolder`, `findOrCreateFolder`, `listFolderItems`, `withDebugger`, `execJS`, `realClickAt`, `locateByTextScript`, `clickByTextScript`, `preflight`, `ensureLoggedIn`, `logFn`, `sleep`, `PROBES`.
- Produces: `uploadFolderToDrive({ appFolderId, monthName, taskName, localFolderPath })` → `{ folderUrl, folderId }`; IPC `drive-upload-folder`; `window.app.driveUploadFolder(payload)`.

- [ ] **Step 1: Add the probe entries**

In `drive-probes.js`, inside `PROBES`:

```javascript
  menuItemFolderUpload: {
    describe: 'The "Folder upload" entry in the New menu',
    derivedFrom: '2026-08-19 uploadProbe.menuItems',
    text: 'Folder upload', // full label is "Folder upload\n^C then I"
  },
  uploadProgressDialog: {
    describe: 'Drive\'s upload progress dialog; its "X of Y" counter is the completion signal',
    derivedFrom: '2026-08-20 folderUploadProbe.dialogAfter — "Uploading 1 item 26 min left... Cancel" / "2 of 99"',
    selector: '[role=dialog]',
    counterPattern: '(\\d+)\\s+of\\s+(\\d+)',
  },
```

- [ ] **Step 2: Add the upload function to `drive-browser.js`**

Insert before `module.exports`:

```javascript
// Reads Drive's upload progress: { done, total } from the "X of Y" counter, or
// null when no progress dialog is visible.
const PROGRESS_SCRIPT = `(() => {
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = e => { const r = e.getBoundingClientRect(); return e.offsetParent !== null && r.width > 0; };
  for (const d of [...document.querySelectorAll(${JSON.stringify(PROBES.uploadProgressDialog.selector)})].filter(vis)) {
    const m = norm(d.innerText).match(/${PROBES.uploadProgressDialog.counterPattern}/);
    if (m) return { done: Number(m[1]), total: Number(m[2]) };
  }
  return null;
})()`;

// Uploads a whole local folder via New -> Folder upload. Drive creates the task
// folder itself, which removes the New-folder dialog (the most failure-prone
// part of the single-file path). Only the MONTH folder is find-or-created here.
async function uploadFolderToDrive({ appFolderId, monthName, taskName, localFolderPath }) {
  if (!appFolderId) throw new Error('no Drive folder configured for this app code');
  if (!monthName || !taskName || !localFolderPath) throw new Error('missing month, task name, or local folder');

  const login = await ensureLoggedIn();
  if (!login.loggedIn) throw new Error('not signed in to Google — sign in the Drive window, then retry');

  const appNav = await navigateToFolder(appFolderId);
  if (appNav.folderId !== appFolderId) {
    throw new Error(`configured app folder ${appFolderId} is not reachable — check the Settings URL`);
  }
  const pre = await preflight();
  if (!pre.ok) {
    throw new Error(`Drive UI has changed; aborted before uploading. Failing probes: ${pre.failures.join(', ')}`);
  }

  const monthId = await findOrCreateFolder(appFolderId, monthName);
  logFn(`uploadFolderToDrive: month ${monthName} -> ${monthId}`);

  // Refuse to add a second folder of the same name; resolve by hand instead.
  const already = (await listFolderItems(monthId, { force: true }))
    .filter(i => i.isFolder && i.name === taskName);
  if (already.length > 1) {
    throw new Error(`Drive already has ${already.length} folders named "${taskName}" — resolve by hand`);
  }
  if (already.length === 1) {
    throw new Error(`"${taskName}" already exists in ${monthName}; Folder upload would create a duplicate rather than merge. Delete it first, or use the single-task upload.`);
  }

  await navigateToFolder(monthId, { force: true });
  const win = getDriveWindow({ show: true });
  win.focus();
  win.webContents.focus();
  await waitForSelector(win, PROBES.mainRegion.selector, 15000);
  await sleep(1200);

  await withDebugger(win, async (dbg) => {
    let chooser = null;
    const onMessage = (_e, method, params) => {
      if (method === 'Page.fileChooserOpened') chooser = params;
    };
    dbg.on('message', onMessage);
    try {
      await dbg.sendCommand('Page.enable');
      await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });

      await execJS(win, 'click:new', clickByTextScript(PROBES.newButton.text));
      await sleep(1500);
      const item = await execJS(win, 'locate:folderUpload',
        locateByTextScript(PROBES.menuItemFolderUpload.text, '[role=menuitem]'));
      if (!item) throw new Error('could not find the "Folder upload" menu item — run driveDiagnose');
      await realClickAt(win, item);

      const chooserDeadline = Date.now() + 15000;
      while (!chooser && Date.now() < chooserDeadline) await sleep(300);
      if (!chooser) throw new Error('folder chooser never opened — nothing was uploaded');

      // mode is "selectSingle": exactly one directory path.
      await dbg.sendCommand('DOM.setFileInputFiles', {
        files: [localFolderPath],
        backendNodeId: chooser.backendNodeId,
      });
    } finally {
      dbg.removeListener('message', onMessage);
      try { await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }); } catch (e) { /* best effort */ }
    }
  });

  // Progress-based wait. A 99-file folder took ~26 minutes, so a fixed deadline
  // would report false failures; only a STALL means something is wrong.
  const STALL_MS = 4 * 60 * 1000;
  const CEILING_MS = 2 * 60 * 60 * 1000;
  const started = Date.now();
  let lastDone = -1;
  let lastChange = Date.now();
  let sawProgress = false;
  while (Date.now() - started < CEILING_MS) {
    const p = await execJS(win, 'uploadProgress', PROGRESS_SCRIPT).catch(() => null);
    if (p) {
      sawProgress = true;
      if (p.done !== lastDone) { lastDone = p.done; lastChange = Date.now(); logFn(`uploadFolderToDrive: ${p.done}/${p.total}`); }
      if (p.done >= p.total) break;
    } else if (sawProgress) {
      break; // dialog dismissed after completing
    }
    if (Date.now() - lastChange > STALL_MS) {
      throw new Error(`upload stalled at ${lastDone < 0 ? 'no progress' : lastDone} — nothing written for this task`);
    }
    await sleep(5000);
  }

  // Read back the folder Drive created, and take its link from the URL.
  let found = [];
  const readDeadline = Date.now() + 60000;
  while (Date.now() < readDeadline) {
    await sleep(3000);
    found = (await listFolderItems(monthId, { force: true }))
      .filter(i => i.isFolder && i.name === taskName).map(i => i.id);
    if (found.length) break;
  }
  if (found.length !== 1) {
    throw new Error(`uploaded but read back ${found.length} folders named "${taskName}" — Creative Link not written`);
  }
  const nav = await navigateToFolder(found[0]);
  win.hide();
  return { folderUrl: nav.url, folderId: found[0] };
}
```

Add `uploadFolderToDrive` to the `module.exports` list.

- [ ] **Step 3: Wire IPC**

`main.js`, beside `drive-upload`:

```javascript
ipcMain.handle('drive-upload-folder', async (_e, payload) => {
  try {
    log(`drive-upload-folder: ${payload && payload.taskName}`);
    return await driveBrowser.uploadFolderToDrive(payload);
  } catch (err) {
    log(`drive-upload-folder FAILED: ${err.message}`);
    return { error: err.message };
  }
});
```

`preload.js`, after `driveUpload`:

```javascript
  driveUploadFolder: (payload)     => ipcRenderer.invoke('drive-upload-folder', payload),
```

- [ ] **Step 4: Syntax check (the limit of agent-side verification)**

Run: `node --check drive-browser.js && node --check drive-probes.js && node --check main.js && node --check preload.js && npm test`
Expected: no syntax errors, 90/90.

- [ ] **Step 5: Commit**

```bash
git add drive-probes.js drive-browser.js main.js preload.js
git commit -m "Add Drive folder upload with progress-based completion"
```

---

### Task 4: Bulk button and the per-task loop

**Cannot be verified by the implementing agent.** Ends with a user-run test in **test mode**.

**Files:** Modify `renderer/index.html` (`#bulk-actions-bar`, script tags), `renderer/app.js`

**Interfaces:**
- Consumes: `summarizeBulkRun` (Task 1); `window.app.findTaskFolder` / `stripDsStore` (Task 2); `window.app.driveUploadFolder` (Task 3); existing `buildFolderMap`, `resolveAppFolderId`, `appCodeFromTaskName`, `monthFolderName`, `toISO`, `DRIVE_APP_LABELS`.
- Produces: nothing downstream.

- [ ] **Step 1: Load `drive-bulk.js` and add the button**

In `renderer/index.html`, add before `app.js`:

```html
  <script src="drive-bulk.js"></script>
```

And in `#bulk-actions-bar`, after `#bulk-autofill-btn`:

```html
      <button id="bulk-drive-upload-btn" title="Upload each selected task's folder to Google Drive and fill Creative Link">Upload to Drive</button>
```

- [ ] **Step 2: Add the loop in `renderer/app.js`**

Add near `uploadTaskToDrive` (which stays untouched):

```javascript
// Bulk delivery: each selected task's local folder is uploaded whole via Drive's
// Folder upload. Tasks run sequentially (the chooser is selectSingle) and each
// commits independently — one failure never discards the others' work.
async function uploadSelectedToDrive() {
  if (!state.selectedIds.size) return;
  if (!state.workingDirectory) { alert('Set a working directory first (⚙ Settings).'); return; }

  const records = state.records.filter(r => state.selectedIds.has(r.id) && r.fields['Name']);
  if (!records.length) return;

  const folderMap = buildFolderMap(state.driveAppFolders, state.driveAppMirrors);
  const monthName = monthFolderName(toISO(new Date()));

  // Resolve everything first so the confirm dialog can show the real plan.
  const planned = records.map(rec => {
    const taskName = rec.fields['Name'];
    const code = appCodeFromTaskName(taskName);
    const appFolderId = resolveAppFolderId(code, folderMap);
    return { rec, taskName, code, appFolderId };
  });

  const lines = planned.map(p => p.appFolderId
    ? `  ${p.taskName}  ->  ${DRIVE_APP_LABELS[p.code] || p.code} / ${monthName}`
    : `  ${p.taskName}  ->  SKIP (no folder configured for "${p.code || '?'}")`);
  const banner = state.driveTestMode
    ? 'TEST MODE — everything goes to the test folder and Creative Link is NOT written.\n\n'
    : '';
  if (!confirm(`${banner}Upload ${planned.length} task folder(s) to Drive?\n\n${lines.join('\n')}\n\nThis runs one task at a time and can take a long time.`)) return;

  const btn = document.getElementById('bulk-drive-upload-btn');
  btn.disabled = true;
  const results = [];
  try {
    for (let i = 0; i < planned.length; i++) {
      const { rec, taskName, code, appFolderId } = planned[i];
      btn.textContent = `Uploading ${i + 1}/${planned.length}...`;

      if (!appFolderId) { results.push({ task: taskName, skipped: `no Drive folder configured for "${code || '?'}"` }); continue; }

      const localFolderPath = await window.app.findTaskFolder(state.workingDirectory, taskName);
      if (!localFolderPath) { results.push({ task: taskName, skipped: 'no local folder with that exact name' }); continue; }

      const stripped = await window.app.stripDsStore(localFolderPath, state.workingDirectory);
      if (stripped && stripped.error) { results.push({ task: taskName, error: stripped.error }); continue; }
      if (stripped && stripped.deleted.length) log(`uploadSelectedToDrive: removed ${stripped.deleted.length} .DS_Store from ${taskName}`);

      const destFolderId = state.driveTestMode ? state.driveTestFolderId : appFolderId;
      if (state.driveTestMode && !destFolderId) { results.push({ task: taskName, error: 'test mode on but no test folder set' }); continue; }

      const res = await window.app.driveUploadFolder({ appFolderId: destFolderId, monthName, taskName, localFolderPath });
      if (!res || res.error) { results.push({ task: taskName, error: (res && res.error) || 'unknown error' }); continue; }

      if (state.driveTestMode) {
        results.push({ task: taskName, folderUrl: res.folderUrl });
        continue;
      }
      try {
        await window.airtable.updateRecord(state.baseId, state.tables[state.activeTable].id, rec.id, {
          'Creative Link': res.folderUrl,
        });
        rec.fields['Creative Link'] = res.folderUrl;
        results.push({ task: taskName, folderUrl: res.folderUrl });
      } catch (err) {
        results.push({ task: taskName, error: `uploaded, but Creative Link not written: ${err.message}` });
      }
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Upload to Drive';
  }

  const s = summarizeBulkRun(results);
  log(`uploadSelectedToDrive: ${s.delivered} delivered, ${s.skipped} skipped, ${s.failed} failed`);
  alert(`${state.driveTestMode ? 'TEST MODE — Creative Link not written.\n\n' : ''}Delivered ${s.delivered}, skipped ${s.skipped}, failed ${s.failed}.\n\n${s.lines.join('\n')}`);
  render();
}
```

Wire it beside the other bulk buttons:

```javascript
document.getElementById('bulk-drive-upload-btn').addEventListener('click', () => {
  if (document.getElementById('bulk-drive-upload-btn').disabled) return;
  uploadSelectedToDrive();
});
```

- [ ] **Step 3: Syntax/test check**

Run: `npm test` → 90/90 (no pure logic added here).

- [ ] **Step 4: USER TEST — test mode, scratch folder**

Requires a **full quit and relaunch** (`main.js`/`preload.js` changed).

Ask the user to: turn **Test mode** on with the Test GD folder set; Cmd-click **two or three** tasks that have matching local folders; click **Upload to Drive** in the bulk bar; confirm the plan dialog lists each task and destination.

Expect afterwards: each task in its own folder under `Test GD/<MM_Month>/`, subfolders preserved, **no `.DS_Store`**, no `Creative Link` written, and a summary counting delivered/skipped/failed. Include one task with an unconfigured code to confirm it is skipped rather than guessed.

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html renderer/app.js
git commit -m "Add bulk Drive delivery for selected tasks"
```
