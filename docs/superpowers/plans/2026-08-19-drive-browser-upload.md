# Drive Delivery via Browser Automation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An explicit "Upload to Drive" button uploads a task's local files to `Creatives/<App>_creatives/<MM_Month>/<task Name>/` in Google Drive via a logged-in browser session, then writes that folder's link into the Airtable `Creative Link` field — only after verifying every file arrived.

**Architecture:** Pure path logic lives in a Jest-tested renderer module (`drive-path.js`). All browser automation lives in the main process (`drive-browser.js`), driving a persistent-session `BrowserWindow`; every DOM assumption is isolated in one `drive-probes.js` file. Because the automation requires the user's authenticated Google session, DOM selectors are **discovered from a diagnostic run** rather than guessed, and the Airtable write stays disabled until the full path is confirmed once.

**Tech Stack:** Electron (BrowserWindow with `partition: 'persist:gdrive'`, `webContents.executeJavaScript`), plain JS, Jest for pure logic. No new dependencies, no Google API, no OAuth.

## Global Constraints

- **Never auto-create the `<App>_creatives` folder** — abort if it's missing. Month and task folders **are** created. A typo-created sibling would silently split a client's deliverables.
- **An unrecognized app code aborts loudly**, naming the code. This is not hypothetical: `LV_1961_1957_...` already exists in the CMC table.
- **Never write an unverified link.** `Creative Link` is written only after a fresh reload of the task folder confirms every expected filename is present.
- **The folder link comes from `webContents.getURL()`** after navigating into the folder — never from DOM scraping.
- **Same-name file already in the task folder → warn.** Drive creates duplicates rather than replacing.
- **Never handle the user's Google credentials.** The user logs in manually in Google's real login page; the session persists.
- **No invented selectors.** Any DOM assumption must come from the Task 3 diagnostic output, and lives only in `drive-probes.js`.
- Tasks 3–5 cannot be verified by the implementing agent — they need the user's authenticated session. Those tasks end with the *user* running a command and reporting back.

## Safety guards (non-negotiable)

These exist to prevent the automation from making a mess in real client folders or in the designer's working directory. Every one of them fails **closed**.

1. **The upload source must be the task folder, verified by name.** Before reading any file, assert `basename(dir) === taskName`. Without this, a click before renaming would point at the raw working directory (e.g. the After Effects folder) and upload hundreds of unrelated files into a client's Drive.
2. **Never create a folder that may already exist.** Folder lookup returns *all* name matches: 0 → create, 1 → use, **more than 1 → abort**. A wrong probe otherwise silently creates a duplicate `08_August` on every attempt, compounding with each retry.
3. **Size ceilings, checked before reading bytes.** Per-file 100 MB, per-delivery 500 MB. File bytes cross into the page as base64 (~1.33× size), so an unguarded multi-GB source file would exhaust memory and hang the app instead of failing cleanly.
4. **Read-only locally.** This feature never creates, moves, renames, or deletes anything on disk — only reads. All local file mutation stays in the existing `performRename()`.
5. **Never dry-run inside a client folder.** Test runs target a scratch folder the user owns in their own My Drive, passed explicitly — never a configured `<App>_creatives` folder.
6. **Isolated browser session.** The Drive window uses its own `persist:gdrive` partition, so it cannot disturb the user's real Chrome profile, cookies, or logged-in sessions.

## File structure

| File | Responsibility |
|---|---|
| `renderer/drive-path.js` (new) | Pure path derivation: app code, month folder name, folder-ID parsing, mapping lookup |
| `tests/drive-path.test.js` (new) | Jest coverage for the above |
| `renderer/index.html` | `<script>` tag; Settings rows for the app→folder mapping; "Upload to Drive" button |
| `renderer/app.js` | `state.driveAppFolders`, settings wiring, upload button handler, verification gate |
| `drive-browser.js` (new, main process) | Owns the Drive window, session, navigation, folder ops, upload, verification |
| `drive-probes.js` (new, main process) | **Every** DOM assumption, one file to repair when Google changes the UI |
| `main.js` | `ipcMain.handle` for `drive-diagnose` and `drive-upload` |
| `preload.js` | Exposes `window.app.driveDiagnose` / `driveUpload` |

---

### Task 1: Pure path derivation

**Files:**
- Create: `renderer/drive-path.js`
- Create: `tests/drive-path.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces, all pure and all used by later tasks:
  - `appCodeFromTaskName(name)` → `string|null` — first underscore-separated token.
  - `monthFolderName(todayISO)` → `string|null` — `'2026-08-19'` → `'08_August'`.
  - `resolveAppFolderId(code, mapping)` → `string|null` — `null` for unrecognized codes.
  - `parseFolderIdFromUrl(url)` → `string|null` — pulls `<id>` out of a `/folders/<id>` URL.

- [ ] **Step 1: Write the failing tests**

Create `tests/drive-path.test.js`:

```javascript
const {
  appCodeFromTaskName,
  monthFolderName,
  resolveAppFolderId,
  parseFolderIdFromUrl,
} = require('../renderer/drive-path');

test('appCodeFromTaskName takes the first underscore-separated token', () => {
  expect(appCodeFromTaskName('CMC_1427_1426_A0_S0_EN_usr_ALB_JUP_Video_VAR_9x16')).toBe('CMC');
  expect(appCodeFromTaskName('LO_12955_12955_A85_S1492_EN_usr_ARI_PRI_Video_VAR_9x16')).toBe('LO');
  expect(appCodeFromTaskName('LV_1961_1957_A0_S0_EN_usr_ALB_PRI_Stat_VAR_9x16')).toBe('LV');
});

test('appCodeFromTaskName returns null for unusable names', () => {
  expect(appCodeFromTaskName('')).toBeNull();
  expect(appCodeFromTaskName(null)).toBeNull();
  expect(appCodeFromTaskName(undefined)).toBeNull();
  expect(appCodeFromTaskName('NoUnderscores')).toBeNull();
  expect(appCodeFromTaskName('_leadingUnderscore')).toBeNull();
});

test('monthFolderName formats as zero-padded number + English month name', () => {
  expect(monthFolderName('2026-08-19')).toBe('08_August');
  expect(monthFolderName('2026-01-01')).toBe('01_January');
  expect(monthFolderName('2026-12-31')).toBe('12_December');
});

test('monthFolderName covers all twelve months', () => {
  const expected = [
    '01_January', '02_February', '03_March', '04_April', '05_May', '06_June',
    '07_July', '08_August', '09_September', '10_October', '11_November', '12_December',
  ];
  expected.forEach((label, i) => {
    const mm = String(i + 1).padStart(2, '0');
    expect(monthFolderName(`2026-${mm}-15`)).toBe(label);
  });
});

test('monthFolderName returns null for malformed input', () => {
  expect(monthFolderName('')).toBeNull();
  expect(monthFolderName(null)).toBeNull();
  expect(monthFolderName('2026-13-01')).toBeNull();
  expect(monthFolderName('2026-00-01')).toBeNull();
  expect(monthFolderName('19-08-2026')).toBeNull();
});

test('resolveAppFolderId looks up a configured code', () => {
  const mapping = { CMC: 'folder-cmc', LO: 'folder-lo' };
  expect(resolveAppFolderId('CMC', mapping)).toBe('folder-cmc');
  expect(resolveAppFolderId('LO', mapping)).toBe('folder-lo');
});

test('resolveAppFolderId returns null for an unrecognized or unconfigured code', () => {
  const mapping = { CMC: 'folder-cmc', LO: '' };
  expect(resolveAppFolderId('LV', mapping)).toBeNull();   // mirror app, not configured
  expect(resolveAppFolderId('LO', mapping)).toBeNull();   // present but blank
  expect(resolveAppFolderId('CMC', {})).toBeNull();
  expect(resolveAppFolderId(null, mapping)).toBeNull();
});

test('parseFolderIdFromUrl extracts the id from real Drive folder URLs', () => {
  expect(parseFolderIdFromUrl('https://drive.google.com/drive/folders/1AbC-dEfG_123'))
    .toBe('1AbC-dEfG_123');
  expect(parseFolderIdFromUrl('https://drive.google.com/drive/u/2/folders/1AbC-dEfG_123'))
    .toBe('1AbC-dEfG_123');
  expect(parseFolderIdFromUrl('https://drive.google.com/drive/u/0/folders/1AbC-dEfG_123?usp=sharing'))
    .toBe('1AbC-dEfG_123');
});

test('parseFolderIdFromUrl accepts a bare id, so pasting either form works', () => {
  expect(parseFolderIdFromUrl('1AbC-dEfG_123')).toBe('1AbC-dEfG_123');
});

test('parseFolderIdFromUrl returns null for non-folder URLs', () => {
  expect(parseFolderIdFromUrl('https://drive.google.com/file/d/1XYZ/view')).toBeNull();
  expect(parseFolderIdFromUrl('https://example.com/drive/folders/1XYZ')).toBeNull();
  expect(parseFolderIdFromUrl('')).toBeNull();
  expect(parseFolderIdFromUrl(null)).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/drive-path.test.js`
Expected: FAIL with `Cannot find module '../renderer/drive-path'`.

- [ ] **Step 3: Implement `renderer/drive-path.js`**

```javascript
// renderer/drive-path.js
// Pure path derivation for Google Drive delivery: which app folder a task
// belongs to, which month folder, and parsing folder IDs out of pasted
// Drive URLs. No DOM, no IO — mirrors the drive-links.js /
// notifications-data.js split so it runs under plain Jest.

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// The app code is the first underscore-separated token of the task Name,
// e.g. "CMC_1427_1426_..." -> "CMC". Returns null when there is no usable
// leading token, so callers abort rather than guessing a destination.
function appCodeFromTaskName(name) {
  if (typeof name !== 'string') return null;
  const token = name.split('_')[0];
  return token ? token : null;
}

// "2026-08-19" -> "08_August". `todayISO` is passed in rather than read
// from the clock here, consistent with the other pure modules.
function monthFolderName(todayISO) {
  if (typeof todayISO !== 'string') return null;
  const m = todayISO.match(/^\d{4}-(\d{2})-\d{2}$/);
  if (!m) return null;
  const monthNum = Number(m[1]);
  if (monthNum < 1 || monthNum > 12) return null;
  return `${m[1]}_${MONTH_NAMES[monthNum - 1]}`;
}

// Looks up the configured Drive folder ID for an app code. Returns null for
// an unrecognized or blank entry — mirror apps (e.g. "LV") are expected and
// must abort rather than fall back to any other folder.
function resolveAppFolderId(code, mapping) {
  if (!code || !mapping) return null;
  const id = mapping[code];
  return id ? id : null;
}

// Accepts a pasted Drive folder URL (with or without a /u/N/ segment or
// query string) or a bare folder ID, and returns the ID.
function parseFolderIdFromUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const m = url.match(/^https:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]+$/.test(url)) return url;
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MONTH_NAMES,
    appCodeFromTaskName,
    monthFolderName,
    resolveAppFolderId,
    parseFolderIdFromUrl,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/drive-path.test.js`
Expected: PASS (10/10).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 76/76 (66 existing + 10 new).

- [ ] **Step 6: Commit**

```bash
git add renderer/drive-path.js tests/drive-path.test.js
git commit -m "Add pure Drive path derivation for delivery folders"
```

---

### Task 2: Settings UI for the app → folder mapping

**Files:**
- Modify: `renderer/index.html` (script tag near line 207; Settings rows after the `drive-account-index-input` block at line 167)
- Modify: `renderer/app.js` (`state` ~line 64, `boot()` ~line 208, `showSettingsModal()`, event wiring ~line 1969)
- Modify: `renderer/styles.css`

**Interfaces:**
- Consumes: `parseFolderIdFromUrl(url)` from Task 1.
- Produces: `state.driveAppFolders` — an object of `{ [code]: folderId }`, persisted under the `driveAppFolders` settings key. Tasks 4–5 read it to resolve a destination.

- [ ] **Step 1: Load `drive-path.js` before `app.js`**

In `renderer/index.html`, the script tags currently read:

```html
  <script src="notifications-data.js"></script>
  <script src="dashboard-data.js"></script>
  <script src="markdown-data.js"></script>
  <script src="drive-links.js"></script>
  <script src="app.js"></script>
```

Add `drive-path.js` before `app.js`:

```html
  <script src="notifications-data.js"></script>
  <script src="dashboard-data.js"></script>
  <script src="markdown-data.js"></script>
  <script src="drive-links.js"></script>
  <script src="drive-path.js"></script>
  <script src="app.js"></script>
```

- [ ] **Step 2: Add the Settings markup**

In `renderer/index.html`, find:

```html
      <input type="number" id="drive-account-index-input" min="0" placeholder="e.g. 2">

      <div class="modal-actions">
```

Change to:

```html
      <input type="number" id="drive-account-index-input" min="0" placeholder="e.g. 2">

      <h2>Drive Delivery Folders</h2>
      <p>Paste each app's "<code>&lt;App&gt;_creatives</code>" folder URL from Drive (open the folder, copy the address). Required before uploading:</p>
      <div id="drive-app-folders"></div>

      <div class="modal-actions">
```

The five rows are built in JS rather than hardcoded in markup, so adding a mirror app later means extending one array.

- [ ] **Step 3: Add state, the label map, and row rendering in `renderer/app.js`**

Add to the `state` object, right after the `driveAccountIndex` line:

```javascript
  driveAppFolders: {}, // { appCode: driveFolderId } for delivery destinations; missing/blank = uploads abort
```

Add near the other module-level constants (e.g. below `PRIORITY_RANK`):

```javascript
// App-code -> display name for the Drive delivery folder. Codes are the
// first token of a task Name; folder names end in "_creatives". Mirror apps
// use different leading codes and can be added here.
const DRIVE_APP_LABELS = {
  CMC: 'Call Me Chat_creatives',
  LO: 'Lowins_creatives',
  OL: 'Olive_creatives',
  PL: 'Plamfy_creatives',
  TL: 'TopLive_creatives',
};
```

Add these two functions near `showSettingsModal`:

```javascript
function renderDriveAppFolderRows() {
  const wrap = document.getElementById('drive-app-folders');
  wrap.innerHTML = '';
  Object.entries(DRIVE_APP_LABELS).forEach(([code, label]) => {
    const row = document.createElement('div');
    row.className = 'drive-folder-row';

    const codeEl = document.createElement('span');
    codeEl.className = 'drive-folder-code';
    codeEl.textContent = code;
    codeEl.title = label;
    row.appendChild(codeEl);

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = `${label} — paste folder URL`;
    input.value = state.driveAppFolders[code] || '';
    input.addEventListener('change', async () => {
      const raw = input.value.trim();
      if (!raw) {
        delete state.driveAppFolders[code];
      } else {
        const id = parseFolderIdFromUrl(raw);
        if (!id) {
          input.value = '';
          alert(`That doesn't look like a Drive folder URL.\n\nOpen the ${label} folder in Drive and copy the address bar — it should contain "/folders/".`);
          return;
        }
        state.driveAppFolders[code] = id;
      }
      input.value = state.driveAppFolders[code] || '';
      await window.app.saveSettings({ driveAppFolders: state.driveAppFolders });
      log(`drive-app-folders: ${code} -> ${state.driveAppFolders[code] || '(cleared)'}`);
    });
    row.appendChild(input);
    wrap.appendChild(row);
  });
}
```

Note the input displays the parsed **folder ID**, not the pasted URL — so what's stored is visibly what's used.

- [ ] **Step 4: Initialize in `boot()` and populate on modal open**

In `boot()`, find:

```javascript
  state.driveAccountIndex = settings.driveAccountIndex || '';
```

Change to:

```javascript
  state.driveAccountIndex = settings.driveAccountIndex || '';
  state.driveAppFolders = settings.driveAppFolders || {};
```

In `showSettingsModal()`, find:

```javascript
  document.getElementById('drive-account-index-input').value = state.driveAccountIndex || '';
```

Add after it:

```javascript
  renderDriveAppFolderRows();
```

- [ ] **Step 5: Add CSS**

In `renderer/styles.css`, find:

```css
.field-open-link-btn:hover { background: var(--bg-surface-2); color: var(--text-primary); }
```

Add after it:

```css
#drive-app-folders { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-5); }
.drive-folder-row { display: flex; align-items: center; gap: var(--space-3); }
.drive-folder-code { flex-shrink: 0; width: 38px; font-size: 11px; font-weight: 600; color: var(--accent); font-family: monospace; }
.drive-folder-row input[type=text] { flex: 1; background: var(--bg-app); border: 1px solid var(--border-strong); color: var(--text-primary); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); font-size: 11px; font-family: monospace; }
```

- [ ] **Step 6: Verify in a fresh browser tab**

Load `file:///Users/pc-63/Desktop/HiggTable/renderer/index.html` in a **fresh** tab (a used tab may serve cached JS/CSS), then in the console:

```js
(function(){
  state.driveAppFolders = { CMC: 'existing-id' };
  document.getElementById('settings-btn').click();
  const rows = [...document.querySelectorAll('.drive-folder-row')];
  const cmc = rows.find(r => r.querySelector('.drive-folder-code').textContent === 'CMC');
  const inp = cmc.querySelector('input');
  inp.value = 'https://drive.google.com/drive/u/2/folders/1NEW-id_123?usp=sharing';
  inp.dispatchEvent(new Event('change'));
  return JSON.stringify({
    rowCount: rows.length,
    codes: rows.map(r => r.querySelector('.drive-folder-code').textContent),
    prefilledFromState: rows.find(r => r.querySelector('.drive-folder-code').textContent === 'CMC') && true,
    parsedIdAfterPaste: state.driveAppFolders.CMC,
  });
})()
```

Expected: `rowCount: 5`, `codes: ["CMC","LO","OL","PL","TL"]`, and `parsedIdAfterPaste: "1NEW-id_123"` — proving the URL was parsed down to the bare ID before storing. Then confirm a bad paste is rejected:

```js
(function(){
  const inp = [...document.querySelectorAll('.drive-folder-row input')][1]; // LO
  inp.value = 'https://drive.google.com/file/d/1XYZ/view';
  inp.dispatchEvent(new Event('change'));
  return JSON.stringify({ loStored: state.driveAppFolders.LO ?? null, inputCleared: inp.value === '' });
})()
```

Expected: `loStored: null`, `inputCleared: true` (an `alert` also fires — dismiss it).

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`
Expected: PASS, 76/76 (unchanged — this task adds no pure logic).

```bash
git add renderer/index.html renderer/app.js renderer/styles.css
git commit -m "Add Drive delivery folder settings for app-code mapping"
```

---

### Task 3: Drive window, login detection, and DOM discovery

This task deliberately writes **no selectors**. Its purpose is to stand up the session and *discover* what Drive's DOM actually looks like, so Task 4's probes are built on evidence.

**Files:**
- Create: `drive-browser.js`
- Modify: `main.js` (add `ipcMain.handle('drive-diagnose', ...)` beside the existing handlers)
- Modify: `preload.js` (add `driveDiagnose` to the `window.app` bridge)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `getDriveWindow({ show })` → `BrowserWindow` on partition `persist:gdrive`.
  - `ensureLoggedIn()` → `{ loggedIn: boolean, url: string }`.
  - `navigateToFolder(folderId)` → `{ url: string, folderId: string|null }`.
  - `diagnose(folderId)` → a structured report object (shape below), consumed by Task 4's probe authoring.
  - IPC channel `drive-diagnose`, exposed as `window.app.driveDiagnose(folderId)`.

- [ ] **Step 1: Create `drive-browser.js`**

```javascript
// drive-browser.js  (main process)
// Owns a persistent-session BrowserWindow logged into Google Drive, and the
// navigation primitives that need no DOM knowledge. Every DOM assumption
// lives in drive-probes.js instead, so a Google UI change has exactly one
// place to be repaired.
//
// The user logs in manually, in Google's real login page. This module never
// reads, stores, types, or transmits credentials.

const { BrowserWindow } = require('electron');

const PARTITION = 'persist:gdrive';
const DRIVE_ROOT = 'https://drive.google.com/drive/my-drive';

let driveWin = null;

function getDriveWindow({ show = false } = {}) {
  if (driveWin && !driveWin.isDestroyed()) {
    if (show) driveWin.show();
    return driveWin;
  }
  driveWin = new BrowserWindow({
    width: 1280,
    height: 900,
    show,
    title: 'HiggTable — Google Drive',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  driveWin.on('closed', () => { driveWin = null; });
  return driveWin;
}

// Waits for the current navigation to settle, then resolves. Uses
// did-stop-loading rather than a fixed sleep so slow loads aren't truncated.
function waitForLoad(win, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`navigation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onStop = () => { cleanup(); resolve(); };
    const cleanup = () => {
      clearTimeout(timer);
      win.webContents.removeListener('did-stop-loading', onStop);
    };
    win.webContents.once('did-stop-loading', onStop);
  });
}

// Login state is determined from the settled URL, not the DOM: Google
// redirects unauthenticated requests to accounts.google.com. That keeps this
// check immune to UI changes.
async function ensureLoggedIn() {
  const win = getDriveWindow({ show: false });
  win.loadURL(DRIVE_ROOT);
  await waitForLoad(win);
  const url = win.webContents.getURL();
  const loggedIn = url.startsWith('https://drive.google.com/');
  if (!loggedIn) win.show(); // surface the real Google login page for the user
  return { loggedIn, url };
}

async function navigateToFolder(folderId) {
  const win = getDriveWindow({ show: false });
  win.loadURL(`https://drive.google.com/drive/folders/${folderId}`);
  await waitForLoad(win);
  const url = win.webContents.getURL();
  const m = url.match(/\/folders\/([A-Za-z0-9_-]+)/);
  return { url, folderId: m ? m[1] : null };
}

// Reports what the live Drive DOM actually contains, so probes can be written
// from evidence instead of guesswork. Returns counts and small samples only —
// never file contents.
async function diagnose(folderId) {
  const login = await ensureLoggedIn();
  if (!login.loggedIn) return { loggedIn: false, url: login.url };

  const nav = folderId ? await navigateToFolder(folderId) : { url: login.url, folderId: null };
  const win = getDriveWindow({ show: false });

  const report = await win.webContents.executeJavaScript(`(() => {
    const sample = (list, n) => Array.prototype.slice.call(list, 0, n);
    const desc = (el) => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      dataId: el.getAttribute('data-id'),
      dataTooltip: el.getAttribute('data-tooltip'),
      text: (el.innerText || '').trim().slice(0, 60),
    });
    const fileInputs = document.querySelectorAll('input[type=file]');
    const dataIdEls = document.querySelectorAll('[data-id]');
    const buttons = document.querySelectorAll('[role=button],button');
    const newBtns = Array.prototype.filter.call(buttons, b => {
      const s = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).toLowerCase();
      return s.includes('new') || s.includes('создать') || s.includes('folder');
    });
    return {
      title: document.title,
      href: location.href,
      lang: document.documentElement.lang,
      counts: {
        fileInputs: fileInputs.length,
        dataIdElements: dataIdEls.length,
        buttons: buttons.length,
        newButtonCandidates: newBtns.length,
      },
      fileInputs: sample(fileInputs, 5).map(i => ({
        multiple: i.multiple, accept: i.accept, hidden: i.hidden,
        name: i.name, parentRole: i.parentElement && i.parentElement.getAttribute('role'),
      })),
      dataIdSamples: sample(dataIdEls, 8).map(desc),
      newButtonSamples: newBtns.slice(0, 8).map(desc),
      mainRegions: sample(document.querySelectorAll('[role=main],[role=grid],[role=list]'), 5).map(desc),
    };
  })()`);

  return { loggedIn: true, navigatedTo: nav, report };
}

module.exports = { getDriveWindow, ensureLoggedIn, navigateToFolder, diagnose, PARTITION };
```

- [ ] **Step 2: Wire the IPC handler in `main.js`**

Add near the top, after the existing requires:

```javascript
const driveBrowser = require('./drive-browser');
```

Then find:

```javascript
ipcMain.handle('open-external', (_e, url) => {
```

and add immediately **before** it:

```javascript
ipcMain.handle('drive-diagnose', async (_e, folderId) => {
  try {
    return await driveBrowser.diagnose(folderId);
  } catch (err) {
    log(`drive-diagnose FAILED: ${err.message}`);
    return { error: err.message };
  }
});
```

- [ ] **Step 3: Expose it in `preload.js`**

Find:

```javascript
  openExternal:      (url)         => ipcRenderer.invoke('open-external', url),
```

Add after it:

```javascript
  driveDiagnose:     (folderId)    => ipcRenderer.invoke('drive-diagnose', folderId),
```

- [ ] **Step 4: Syntax-check what can be checked without a session**

Run: `node --check drive-browser.js && node --check main.js && node --check preload.js && npm test`
Expected: no syntax errors; tests PASS 76/76.

This is the limit of what's verifiable by the implementing agent — everything below needs the user's Google session.

- [ ] **Step 5: USER RUNS THE DIAGNOSTIC — do not fabricate this result**

`main.js` and `preload.js` are main-process files, so this needs a **full quit and relaunch** of the app, not a window reload.

Ask the user to:
1. Fully quit HiggTable, then run `npm start` from the project directory.
2. Open Settings and paste one `<App>_creatives` folder URL (any one) so there's a folder ID to point at.
3. Open DevTools (View → Toggle Developer Tools) and run:

```js
await window.app.driveDiagnose(state.driveAppFolders.CMC || null)
```

4. If a Google login window appears, log in there (their own credentials, in Google's real page), then re-run the command.
5. Paste the returned JSON back.

**Stop here and wait for that output.** Task 4's probes are written from it. Do not proceed by guessing selectors.

- [ ] **Step 6: Commit**

```bash
git add drive-browser.js main.js preload.js
git commit -m "Add Drive browser session and DOM discovery diagnostic"
```

---

### Task 4: Probes and folder operations, built from the diagnostic

**Blocked on Task 3, Step 5.** Every selector in this task comes from that report. If it hasn't been run, stop.

**Files:**
- Create: `drive-probes.js`
- Modify: `drive-browser.js`
- Modify: `main.js`, `preload.js` (add the `drive-upload` channel)

**Interfaces:**
- Consumes: the Task 3 diagnostic report; `getDriveWindow`, `navigateToFolder`, `ensureLoggedIn` from `drive-browser.js`.
- Produces:
  - `drive-probes.js` exporting `PROBES` — an object where each key is one named DOM assumption with `{ describe, test(win), ... }`.
  - `preflight()` → `{ ok: boolean, failures: string[] }`.
  - `findChildFoldersByName(parentId, name)` → `string[]` — **all** matching child folder IDs, so callers can abort on duplicates rather than blindly creating another.
  - `createFolder(parentId, name)` → `folderId`.
  - `uploadFiles(folderId, filePaths)` → `{ uploaded: string[] }`.
  - `listFolderFileNames(folderId)` → `string[]`.
  - `deliver({ appFolderId, monthName, taskName, filePaths })` → `{ folderUrl, folderId, missing: string[], warnings: string[] }` — the single entry point Task 5 calls. **Never writes to Airtable.**
  - IPC `drive-upload` → `window.app.driveUpload(payload)`.

- [ ] **Step 1: Author `drive-probes.js` from the diagnostic evidence**

Create `drive-probes.js` with one entry per DOM assumption. Fill each `selector` from the Task 3 report — `fileInputs` tells you the upload input, `dataIdSamples` tells you how folder rows expose IDs, `newButtonSamples` tells you the create-folder control:

```javascript
// drive-probes.js  (main process)
// THE ONLY FILE CONTAINING DOM ASSUMPTIONS ABOUT GOOGLE DRIVE'S WEB UI.
// When Google changes the UI, this is the file to repair. Each probe states
// what it assumes and how to re-derive it: run window.app.driveDiagnose(id)
// from the app's DevTools and read the report.
//
// Selector values below were derived from a diagnostic run on the date noted
// in each `derivedFrom` field — they are evidence, not guesses.

const PROBES = {
  fileInput: {
    describe: 'Hidden <input type=file> Drive uses for uploads',
    derivedFrom: '<diagnostic date> report.fileInputs',
    selector: '<from report>',
  },
  folderRow: {
    describe: 'A row/tile in the folder listing that carries the item id',
    derivedFrom: '<diagnostic date> report.dataIdSamples',
    selector: '<from report>',
    idAttribute: 'data-id',
  },
  newButton: {
    describe: 'The "New" control that opens the create menu',
    derivedFrom: '<diagnostic date> report.newButtonSamples',
    selector: '<from report>',
  },
  newFolderMenuItem: {
    describe: 'The "New folder" item inside the New menu',
    derivedFrom: '<diagnostic date> manual inspection',
    selector: '<from report>',
  },
  folderNameField: {
    describe: 'Text field in the create-folder dialog',
    derivedFrom: '<diagnostic date> manual inspection',
    selector: '<from report>',
  },
  dropTarget: {
    describe: 'Element that accepts a synthetic drop (upload fallback)',
    derivedFrom: '<diagnostic date> report.mainRegions',
    selector: '<from report>',
  },
};

module.exports = { PROBES };
```

The `<from report>` values are filled with real selectors at this step — the diagnostic output is the input to writing them. Do not leave them literal.

- [ ] **Step 2: Add `preflight()` to `drive-browser.js`**

```javascript
const { PROBES } = require('./drive-probes');

// Verifies every DOM assumption against the live page BEFORE any file is
// uploaded. This is what converts "the automation broke and the creative was
// silently never delivered" into "the automation broke and named the probe".
async function preflight() {
  const win = getDriveWindow({ show: false });
  const selectors = Object.fromEntries(
    Object.entries(PROBES).map(([k, p]) => [k, p.selector])
  );
  const found = await win.webContents.executeJavaScript(
    `(() => { const s = ${JSON.stringify(selectors)}; const out = {};
      for (const k in s) out[k] = !!document.querySelector(s[k]);
      return out; })()`
  );
  const failures = Object.keys(found).filter(k => !found[k]);
  return { ok: failures.length === 0, failures };
}
```

Probes only present after an interaction (the folder-name dialog, the New menu item) are excluded from preflight and validated at their point of use — preflight covers only what must exist on a loaded folder page.

- [ ] **Step 3: Implement the folder operations in `drive-browser.js`**

`findChildFoldersByName` uses the search URL form the user already uses manually, so it depends on URL structure rather than UI chrome. It returns **every** match — matching on exact name only, never a prefix, so `08_August` can't match `08_August_old`:

```javascript
// Finds direct child folders by EXACT name using Drive's own search URL —
// the same ?q=parent:<id> title:<name> form used manually. Returns every
// matching id so the caller can abort on duplicates instead of creating yet
// another one. Exact match only: a prefix match would conflate similarly
// named folders and deliver into the wrong one.
async function findChildFoldersByName(parentId, name) {
  const win = getDriveWindow({ show: false });
  const q = encodeURIComponent(`parent:${parentId} title:${name}`);
  win.loadURL(`https://drive.google.com/drive/search?q=${q}`);
  await waitForLoad(win);
  const { selector, idAttribute } = PROBES.folderRow;
  return win.webContents.executeJavaScript(
    `(() => {
      const out = [];
      const rows = document.querySelectorAll(${JSON.stringify(selector)});
      for (const r of rows) {
        const label = (r.getAttribute('aria-label') || r.innerText || '').trim();
        if (label === ${JSON.stringify(name)}) {
          const id = r.getAttribute(${JSON.stringify(idAttribute)});
          if (id && out.indexOf(id) === -1) out.push(id);
        }
      }
      return out;
    })()`
  );
}

// Find-or-create with the duplicate guard. This is the only sanctioned way to
// obtain a month or task folder id.
async function findOrCreateFolder(parentId, name) {
  const existing = await findChildFoldersByName(parentId, name);
  if (existing.length === 1) return existing[0];
  if (existing.length > 1) {
    throw new Error(`Drive already has ${existing.length} folders named "${name}" in this parent. Resolve that by hand — refusing to add another.`);
  }
  const created = await createFolder(parentId, name);
  // Read the id back from a fresh search rather than trusting the dialog DOM.
  const after = await findChildFoldersByName(parentId, name);
  if (after.length !== 1) {
    throw new Error(`Created "${name}" but read back ${after.length} matches — aborting before upload to avoid duplicating files.`);
  }
  return created || after[0];
}
```

`createFolder(parentId, name)` drives the New → New folder → type name flow using `PROBES.newButton`, `PROBES.newFolderMenuItem`, and `PROBES.folderNameField`, clicking via `element.click()` in the page context (never coordinates). It returns the new folder's id if it can read one, or `null` — `findOrCreateFolder` above is responsible for confirming the result, so `createFolder` is never called directly elsewhere.

`uploadFiles` reads bytes in the main process and injects them, primary strategy first:

```javascript
const fs = require('fs');
const path = require('path');

// File bytes reach the page as base64 (~1.33x size) because executeJavaScript
// serializes arguments as JSON and cannot carry binary. Unguarded, a multi-GB
// After Effects source would exhaust memory and hang the app rather than fail
// cleanly — so sizes are checked BEFORE anything is read.
const MAX_FILE_BYTES = 100 * 1024 * 1024;   // 100 MB per file
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;  // 500 MB per delivery

function assertUploadSizes(filePaths) {
  let total = 0;
  const tooBig = [];
  for (const p of filePaths) {
    const { size } = fs.statSync(p);
    total += size;
    if (size > MAX_FILE_BYTES) {
      tooBig.push(`${path.basename(p)} (${(size / 1048576).toFixed(0)} MB)`);
    }
  }
  if (tooBig.length) {
    throw new Error(`Refusing to upload — over the ${MAX_FILE_BYTES / 1048576} MB per-file limit: ${tooBig.join(', ')}. Remove these from the task folder (or exclude source files) and retry.`);
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(`Refusing to upload — ${(total / 1048576).toFixed(0)} MB total exceeds the ${MAX_TOTAL_BYTES / 1048576} MB limit for one delivery.`);
  }
}

async function uploadFiles(folderId, filePaths) {
  assertUploadSizes(filePaths);
  await navigateToFolder(folderId);
  const win = getDriveWindow({ show: false });
  const payload = filePaths.map(p => ({
    name: path.basename(p),
    b64: fs.readFileSync(p).toString('base64'),
  }));
  const ok = await win.webContents.executeJavaScript(`(async () => {
    const files = ${JSON.stringify(payload)}.map(f => {
      const bin = atob(f.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], f.name);
    });
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    const input = document.querySelector(${JSON.stringify(PROBES.fileInput.selector)});
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'input';
    }
    const target = document.querySelector(${JSON.stringify(PROBES.dropTarget.selector)});
    if (!target) return null;
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return 'drop';
  })()`);
  if (!ok) throw new Error('no upload target found — run driveDiagnose and update drive-probes.js');
  return { strategy: ok, uploaded: payload.map(f => f.name) };
}
```

Base64 is used because `executeJavaScript` serializes arguments as JSON and cannot carry raw binary.

`listFolderFileNames(folderId)` navigates fresh and returns the visible item labels via `PROBES.folderRow`, used for verification.

- [ ] **Step 4: Implement `deliver()` — the orchestrator, with the guard rails**

```javascript
// Resolves the destination, uploads, and verifies. NEVER writes to Airtable —
// the caller decides that, and only when `missing` is empty.
async function deliver({ appFolderId, monthName, taskName, filePaths }) {
  if (!appFolderId) throw new Error('no Drive folder configured for this app code');
  const login = await ensureLoggedIn();
  if (!login.loggedIn) throw new Error('not signed in to Google — sign in the Drive window, then retry');

  // The <App>_creatives folder must already exist; a typo-created sibling
  // would silently split a client's deliverables, so never create at this level.
  const appNav = await navigateToFolder(appFolderId);
  if (appNav.folderId !== appFolderId) {
    throw new Error(`configured app folder ${appFolderId} is not reachable — check the Settings URL`);
  }

  const pre = await preflight();
  if (!pre.ok) {
    throw new Error(`Drive UI has changed; aborted before uploading. Failing probes: ${pre.failures.join(', ')}. Run driveDiagnose and update drive-probes.js`);
  }

  const warnings = [];
  // findOrCreateFolder aborts on duplicate names rather than adding another,
  // so a broken probe cannot litter the client's Drive on repeated attempts.
  const monthId = await findOrCreateFolder(appFolderId, monthName);
  const taskId = await findOrCreateFolder(monthId, taskName);

  const existing = await listFolderFileNames(taskId);
  const clashes = filePaths.map(p => path.basename(p)).filter(n => existing.includes(n));
  if (clashes.length) {
    warnings.push(`Drive already has these files and will create duplicates rather than replace them: ${clashes.join(', ')}`);
  }

  await uploadFiles(taskId, filePaths);

  // Verification gate: reload fresh and confirm every expected name arrived.
  const present = await listFolderFileNames(taskId);
  const expected = filePaths.map(p => path.basename(p));
  const missing = expected.filter(n => !present.includes(n));

  const nav = await navigateToFolder(taskId);
  return { folderUrl: nav.url, folderId: taskId, missing, warnings };
}
```

- [ ] **Step 5: Wire the `drive-upload` IPC channel**

In `main.js`, after the `drive-diagnose` handler:

```javascript
ipcMain.handle('drive-upload', async (_e, payload) => {
  try {
    return await driveBrowser.deliver(payload);
  } catch (err) {
    log(`drive-upload FAILED: ${err.message}`);
    return { error: err.message };
  }
});
```

In `preload.js`, after `driveDiagnose`:

```javascript
  driveUpload:       (payload)     => ipcRenderer.invoke('drive-upload', payload),
```

- [ ] **Step 6: Syntax-check**

Run: `node --check drive-browser.js && node --check drive-probes.js && node --check main.js && node --check preload.js && npm test`
Expected: no syntax errors; tests PASS 76/76.

- [ ] **Step 7: USER RUNS AN END-TO-END DRY RUN — no Airtable write yet**

Full quit and relaunch (`npm start`).

**This must not run inside a client folder.** Ask the user first to create a scratch folder in their **own My Drive** (e.g. `HiggTable Upload Test`), open it, and copy its URL — the dry run targets that, never a configured `<App>_creatives` folder. A first run with unproven probes is exactly when stray folders get created, and that mess should land somewhere private and disposable.

Then, with one or two **small** local test files, in DevTools:

```js
await window.app.driveUpload({
  appFolderId: parseFolderIdFromUrl('<PASTE SCRATCH FOLDER URL>'),
  monthName: monthFolderName(toISO(new Date())),
  taskName: 'HIGGTABLE_TEST_DELETE_ME',
  filePaths: ['/absolute/path/to/a/small/test.png'],
})
```

Expected in the returned object: a `folderUrl` containing `/folders/`, `missing: []`, and the file actually visible in Drive under `<scratch>/<MM_Month>/HIGGTABLE_TEST_DELETE_ME/`. Any `error` string, non-empty `missing`, or failing probe list means iterate on `drive-probes.js` before continuing.

Have them delete the scratch folder when the dry run passes — and check it for stray folders created by failed attempts before deleting.

**Stop and wait for this result.** Task 5 connects the Airtable write and must not be enabled until this succeeds once.

- [ ] **Step 8: Commit**

```bash
git add drive-probes.js drive-browser.js main.js preload.js
git commit -m "Add Drive folder operations, upload, and preflight probe self-test"
```

---

### Task 5: "Upload to Drive" button and the Airtable write

**Blocked on Task 4, Step 7 succeeding.**

**Files:**
- Modify: `renderer/index.html` (`#rename-footer`, line 142-146)
- Modify: `renderer/app.js` (new handler; wiring near `#rename-btn` at ~line 2014)

**Interfaces:**
- Consumes: `window.app.driveUpload(payload)` from Task 4; `appCodeFromTaskName`, `monthFolderName`, `resolveAppFolderId` from Task 1; `state.driveAppFolders` from Task 2.
- Produces: nothing downstream — final task.

- [ ] **Step 1: Add the button**

In `renderer/index.html`, find:

```html
      <button id="rename-btn" class="primary">Rename Files</button>
```

Change to:

```html
      <button id="rename-btn" class="primary">Rename Files</button>
      <button id="drive-upload-btn" title="Upload this task's folder to Google Drive and fill Creative Link">Upload to Drive</button>
```

- [ ] **Step 2: Add the handler in `renderer/app.js`**

Add near `performRename`:

```javascript
// Uploads the task's local folder to Drive, then writes the Drive folder link
// into Creative Link — but only if every file was verified present. A wrong
// link is worse than none: it would look like a delivery that never happened.
async function uploadTaskToDrive() {
  const rec = state.selectedTask;
  if (!rec) { alert('Select a task first.'); return; }
  const taskName = rec.fields['Name'] || '';

  const code = appCodeFromTaskName(taskName);
  const appFolderId = resolveAppFolderId(code, state.driveAppFolders);
  if (!appFolderId) {
    alert(`No Drive folder is configured for app code "${code || '(none)'}".\n\nAdd it in Settings → Drive Delivery Folders. Nothing was uploaded.`);
    return;
  }

  const dirs = [...new Set(state.pendingFiles.map(f => f.path.substring(0, f.path.lastIndexOf('/'))))];
  if (dirs.length !== 1) {
    alert('Rename the files first — the task folder was not found.');
    return;
  }
  const sourceDir = dirs[0];

  // SAFETY: only ever upload from the per-task folder performRename() created.
  // Before renaming, these paths point at the raw working directory (e.g. the
  // After Effects folder) — uploading that would dump hundreds of unrelated
  // files into a client's Drive. The folder name must equal the task Name.
  if (sourceDir.split('/').pop() !== taskName) {
    alert(`Not uploading: "${sourceDir}" is not this task's folder.\n\nClick "Rename Files" first — that gathers the files into a folder named after the task. Nothing was uploaded.`);
    return;
  }

  const filePaths = await window.app.findAssetFilesInFolder(sourceDir);
  if (!filePaths.length) { alert(`No files found in ${sourceDir}`); return; }

  if (!confirm(`Upload ${filePaths.length} file(s) to Drive?\n\n${DRIVE_APP_LABELS[code] || code} / ${monthFolderName(toISO(new Date()))} / ${taskName}\n\n${filePaths.map(p => p.split('/').pop()).join('\n')}`)) {
    return;
  }

  const btn = document.getElementById('drive-upload-btn');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  try {
    const result = await window.app.driveUpload({
      appFolderId,
      monthName: monthFolderName(toISO(new Date())),
      taskName,
      filePaths,
    });
    if (result.error) { alert(`Upload failed — nothing written to Airtable.\n\n${result.error}`); return; }
    if (result.missing && result.missing.length) {
      alert(`Upload could not be verified — nothing written to Airtable.\n\nMissing in Drive:\n${result.missing.join('\n')}`);
      return;
    }
    await window.airtable.updateRecord(state.baseId, state.tables[state.activeTable].id, rec.id, {
      'Creative Link': result.folderUrl,
    });
    rec.fields['Creative Link'] = result.folderUrl;
    log(`uploadTaskToDrive: ${filePaths.length} file(s) delivered, Creative Link -> ${result.folderUrl}`);
    const warn = result.warnings && result.warnings.length ? `\n\nWarnings:\n${result.warnings.join('\n')}` : '';
    alert(`Delivered ${filePaths.length} file(s) and set Creative Link.${warn}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Upload to Drive';
  }
}
```

Note this calls `window.airtable.updateRecord` directly rather than `updateRecordField`, because the latter requires a DOM input element to flash status against and there is none here.

- [ ] **Step 3: Add the folder-listing IPC helper**

`uploadTaskToDrive` needs the task folder's contents. In `main.js`, beside the other file helpers:

```javascript
ipcMain.handle('find-asset-files-in-folder', (_e, dir) => {
  return fs.readdirSync(dir)
    .filter(n => !n.startsWith('.'))
    .map(n => path.join(dir, n))
    .filter(p => fs.statSync(p).isFile());
});
```

In `preload.js`:

```javascript
  findAssetFilesInFolder: (dir)    => ipcRenderer.invoke('find-asset-files-in-folder', dir),
```

- [ ] **Step 4: Wire the button**

In `renderer/app.js`, find:

```javascript
document.getElementById('rename-btn').addEventListener('click', performRename);
```

Add after it:

```javascript
document.getElementById('drive-upload-btn').addEventListener('click', uploadTaskToDrive);
```

- [ ] **Step 5: Syntax-check and run the suite**

Run: `node --check main.js && node --check preload.js && npm test`
Expected: no syntax errors; tests PASS 76/76.

- [ ] **Step 6: USER VERIFIES END TO END**

Full quit and relaunch. Ask the user to run one **real but low-stakes** task through the whole flow: select the task, add and rename its files, click "Upload to Drive", then confirm (a) the files are in the right Drive folder, (b) `Creative Link` now holds a `/folders/` URL, and (c) opening that link lands on the correct folder.

Also ask them to confirm the abort paths behave: a task whose code isn't configured (e.g. an `LV_` task) should refuse with the "No Drive folder is configured" message and write nothing.

- [ ] **Step 7: Commit**

```bash
git add renderer/index.html renderer/app.js main.js preload.js
git commit -m "Add Upload to Drive button with verification gate before Airtable write"
```
