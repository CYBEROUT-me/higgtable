# HiggTable Phase 1 — Airtable Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal Electron app that connects to Airtable and lets you browse all bases, tables, and records so we can understand the data shape before building the full renaming pipeline.

**Architecture:** Electron with a main process that owns all Airtable API calls (via Node.js built-in `fetch`), a `preload.js` context bridge, and a plain HTML/CSS/JS renderer with a three-panel layout (Bases → Tables → Records).

**Tech Stack:** Electron 28, Node.js 18 built-in fetch, electron-builder (packaging), Jest 29 (unit tests on the pure API module).

---

## File Map

| File | Responsibility |
|---|---|
| `package.json` | Project config, scripts, electron-builder config |
| `config.js` | API key (single source of truth) |
| `airtable.js` | Pure Airtable REST API wrapper — fetchBases, fetchTables, fetchRecords |
| `main.js` | Electron main process, BrowserWindow, IPC handlers |
| `preload.js` | contextBridge — exposes airtable IPC to renderer |
| `renderer/index.html` | Three-panel shell |
| `renderer/styles.css` | Minimal dark UI styles |
| `renderer/app.js` | Renderer logic — calls window.airtable, renders lists and table |
| `tests/airtable.test.js` | Unit tests for airtable.js (mocked fetch) |

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "higgtable",
  "version": "0.1.0",
  "description": "Airtable file renaming tool",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "test": "jest",
    "build": "electron-builder --mac"
  },
  "devDependencies": {
    "electron": "^28.0.0",
    "electron-builder": "^24.0.0",
    "jest": "^29.0.0"
  },
  "build": {
    "appId": "com.internal.higgtable",
    "productName": "HiggTable",
    "mac": {
      "target": "dmg",
      "category": "public.app-category.productivity"
    }
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd /Users/pc-63/Desktop/HiggTable
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Create a smoke-test main.js (temporary)**

```javascript
// main.js
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 800, height: 600 });
  win.loadURL('data:text/html,<h1>HiggTable</h1>');
});
app.on('window-all-closed', () => app.quit());
```

- [ ] **Step 4: Verify Electron launches**

```bash
npm start
```

Expected: A window opens showing "HiggTable". Close it.

- [ ] **Step 5: Commit**

```bash
git init
git add package.json package-lock.json main.js
git commit -m "chore: scaffold Electron project"
```

---

## Task 2: Airtable API Module (TDD)

**Files:**
- Create: `airtable.js`
- Create: `tests/airtable.test.js`

- [ ] **Step 1: Create tests/airtable.test.js with failing tests**

```javascript
// tests/airtable.test.js
const { fetchBases, fetchTables, fetchRecords } = require('../airtable');

global.fetch = jest.fn();
afterEach(() => jest.clearAllMocks());

test('fetchBases returns bases array', async () => {
  global.fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ bases: [{ id: 'appXXX', name: 'Test Base' }] })
  });
  const result = await fetchBases('fakekey');
  expect(result).toEqual([{ id: 'appXXX', name: 'Test Base' }]);
  expect(fetch).toHaveBeenCalledWith(
    'https://api.airtable.com/v0/meta/bases',
    expect.objectContaining({ headers: { Authorization: 'Bearer fakekey' } })
  );
});

test('fetchBases throws on non-ok response', async () => {
  global.fetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' });
  await expect(fetchBases('badkey')).rejects.toThrow('Airtable error: 401 Unauthorized');
});

test('fetchTables returns tables array', async () => {
  global.fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ tables: [{ id: 'tblXXX', name: 'Tasks', fields: [{ name: 'Name' }] }] })
  });
  const result = await fetchTables('fakekey', 'appXXX');
  expect(result).toEqual([{ id: 'tblXXX', name: 'Tasks', fields: [{ name: 'Name' }] }]);
  expect(fetch).toHaveBeenCalledWith(
    'https://api.airtable.com/v0/meta/bases/appXXX/tables',
    expect.objectContaining({ headers: { Authorization: 'Bearer fakekey' } })
  );
});

test('fetchRecords handles pagination', async () => {
  global.fetch
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ records: [{ id: 'recA', fields: { Name: 'Task A' } }], offset: 'page2' })
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ records: [{ id: 'recB', fields: { Name: 'Task B' } }] })
    });
  const result = await fetchRecords('fakekey', 'appXXX', 'tblXXX');
  expect(result).toHaveLength(2);
  expect(result[0].id).toBe('recA');
  expect(result[1].id).toBe('recB');
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('fetchRecords throws on non-ok response', async () => {
  global.fetch.mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden' });
  await expect(fetchRecords('fakekey', 'appXXX', 'tblXXX')).rejects.toThrow('Airtable error: 403 Forbidden');
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test
```

Expected: `Cannot find module '../airtable'` — all 4 tests fail.

- [ ] **Step 3: Create airtable.js**

```javascript
// airtable.js
const BASE_URL = 'https://api.airtable.com/v0';

async function get(url, apiKey) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Airtable error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchBases(apiKey) {
  const data = await get(`${BASE_URL}/meta/bases`, apiKey);
  return data.bases;
}

async function fetchTables(apiKey, baseId) {
  const data = await get(`${BASE_URL}/meta/bases/${baseId}/tables`, apiKey);
  return data.tables;
}

async function fetchRecords(apiKey, baseId, tableId) {
  const records = [];
  let offset = null;
  do {
    const url = new URL(`${BASE_URL}/${baseId}/${tableId}`);
    if (offset) url.searchParams.set('offset', offset);
    const data = await get(url.toString(), apiKey);
    records.push(...data.records);
    offset = data.offset || null;
  } while (offset);
  return records;
}

module.exports = { fetchBases, fetchTables, fetchRecords };
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm test
```

Expected: `Tests: 4 passed, 4 total`

- [ ] **Step 5: Commit**

```bash
git add airtable.js tests/airtable.test.js
git commit -m "feat: Airtable API module with fetchBases, fetchTables, fetchRecords"
```

---

## Task 3: Config + Main Process + Preload

**Files:**
- Create: `config.js`
- Modify: `main.js` (replace smoke-test version)
- Create: `preload.js`

- [ ] **Step 1: Create config.js**

```javascript
// config.js
module.exports = {
  apiKey: 'YOUR_AIRTABLE_PAT_HERE'
};
```

Replace `YOUR_AIRTABLE_PAT_HERE` with the actual Personal Access Token.

- [ ] **Step 2: Replace main.js**

```javascript
// main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { fetchBases, fetchTables, fetchRecords } = require('./airtable');
const { apiKey } = require('./config');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  win.loadFile('renderer/index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle('get-bases', () => fetchBases(apiKey));
ipcMain.handle('get-tables', (_e, baseId) => fetchTables(apiKey, baseId));
ipcMain.handle('get-records', (_e, baseId, tableId) => fetchRecords(apiKey, baseId, tableId));
```

- [ ] **Step 3: Create preload.js**

```javascript
// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airtable', {
  getBases: () => ipcRenderer.invoke('get-bases'),
  getTables: (baseId) => ipcRenderer.invoke('get-tables', baseId),
  getRecords: (baseId, tableId) => ipcRenderer.invoke('get-records', baseId, tableId),
});
```

- [ ] **Step 4: Commit**

```bash
git add config.js main.js preload.js
git commit -m "feat: main process IPC handlers and preload context bridge"
```

---

## Task 4: Renderer — Three-Panel Explorer UI

**Files:**
- Create: `renderer/index.html`
- Create: `renderer/styles.css`
- Create: `renderer/app.js`

- [ ] **Step 1: Create renderer/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'">
  <title>HiggTable Explorer</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="app">
    <div id="panel-bases" class="panel">
      <h3>Bases</h3>
      <ul id="bases-list"></ul>
    </div>
    <div id="panel-tables" class="panel">
      <h3>Tables</h3>
      <ul id="tables-list"></ul>
    </div>
    <div id="panel-records" class="panel panel-wide">
      <h3>Records</h3>
      <div id="records-container"></div>
    </div>
  </div>
  <div id="status">Loading bases...</div>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create renderer/styles.css**

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, sans-serif; font-size: 13px; background: #1e1e1e; color: #d4d4d4; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
#app { display: flex; flex: 1; overflow: hidden; }
.panel { border-right: 1px solid #333; overflow-y: auto; padding: 8px; min-width: 180px; }
.panel-wide { flex: 1; min-width: 0; }
h3 { font-size: 10px; text-transform: uppercase; color: #666; padding: 4px 0 8px; letter-spacing: 0.8px; }
ul { list-style: none; }
li { padding: 5px 8px; cursor: pointer; border-radius: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
li:hover { background: #2a2a2a; }
li.active { background: #1e4d8c; color: #fff; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; padding: 4px 8px; background: #252525; position: sticky; top: 0; border-bottom: 1px solid #3a3a3a; color: #888; font-weight: normal; font-size: 11px; }
td { padding: 4px 8px; border-bottom: 1px solid #272727; vertical-align: top; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
tr:hover td { background: #242424; }
.empty { padding: 16px; color: #555; font-style: italic; }
#status { padding: 4px 10px; font-size: 11px; color: #555; border-top: 1px solid #2a2a2a; }
.error { color: #f44; }
```

- [ ] **Step 3: Create renderer/app.js**

```javascript
// renderer/app.js
async function loadBases() {
  setStatus('Loading bases...');
  try {
    const bases = await window.airtable.getBases();
    const list = document.getElementById('bases-list');
    list.innerHTML = '';
    bases.forEach(base => {
      const li = document.createElement('li');
      li.textContent = base.name;
      li.title = base.id;
      li.onclick = () => {
        document.querySelectorAll('#bases-list li').forEach(el => el.classList.remove('active'));
        li.classList.add('active');
        document.getElementById('tables-list').innerHTML = '';
        document.getElementById('records-container').innerHTML = '';
        loadTables(base.id);
      };
      list.appendChild(li);
    });
    setStatus(`${bases.length} base${bases.length !== 1 ? 's' : ''} found`);
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  }
}

async function loadTables(baseId) {
  setStatus('Loading tables...');
  try {
    const tables = await window.airtable.getTables(baseId);
    const list = document.getElementById('tables-list');
    list.innerHTML = '';
    tables.forEach(table => {
      const li = document.createElement('li');
      li.textContent = `${table.name}`;
      li.title = `${table.id} — ${table.fields.length} fields`;
      li.onclick = () => {
        document.querySelectorAll('#tables-list li').forEach(el => el.classList.remove('active'));
        li.classList.add('active');
        loadRecords(baseId, table.id, table.fields);
      };
      list.appendChild(li);
    });
    setStatus(`${tables.length} tables`);
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  }
}

async function loadRecords(baseId, tableId, fields) {
  const container = document.getElementById('records-container');
  container.innerHTML = '<p class="empty">Loading records...</p>';
  setStatus('Loading records...');
  try {
    const records = await window.airtable.getRecords(baseId, tableId);
    if (!records.length) {
      container.innerHTML = '<p class="empty">No records in this table.</p>';
      setStatus('0 records');
      return;
    }
    const fieldNames = fields.map(f => f.name);
    const table = document.createElement('table');
    const thead = table.createTHead();
    const hr = thead.insertRow();
    ['#', 'Record ID', ...fieldNames].forEach(name => {
      const th = document.createElement('th');
      th.textContent = name;
      hr.appendChild(th);
    });
    const tbody = table.createTBody();
    records.forEach((rec, i) => {
      const tr = tbody.insertRow();
      const tdNum = tr.insertCell(); tdNum.textContent = i + 1;
      const tdId = tr.insertCell(); tdId.textContent = rec.id;
      fieldNames.forEach(name => {
        const td = tr.insertCell();
        const val = rec.fields[name];
        if (val === undefined || val === null) {
          td.textContent = '';
        } else if (Array.isArray(val)) {
          td.textContent = val.map(v => (typeof v === 'object' ? JSON.stringify(v) : v)).join(', ');
        } else if (typeof val === 'object') {
          td.textContent = JSON.stringify(val);
        } else {
          td.textContent = String(val);
        }
      });
    });
    container.innerHTML = '';
    container.appendChild(table);
    setStatus(`${records.length} records`);
  } catch (err) {
    container.innerHTML = `<p class="empty error">${err.message}</p>`;
    setStatus(`Error: ${err.message}`, true);
  }
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
}

loadBases();
```

- [ ] **Step 4: Run the app and verify all three panels work**

```bash
npm start
```

Expected:
- Left panel lists all Airtable bases from the account
- Clicking a base populates the middle panel with table names
- Clicking a table loads all records as a scrollable HTML table in the right panel
- Status bar shows record count
- Hover on a list item shows its Airtable ID in the tooltip

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html renderer/styles.css renderer/app.js
git commit -m "feat: three-panel Airtable explorer UI"
```

---

## Task 5: Package as macOS .app

**Files:**
- Modify: `package.json` (already has build config from Task 1)

- [ ] **Step 1: Add .gitignore**

```
node_modules/
dist/
```

```bash
echo "node_modules/\ndist/" > .gitignore
```

- [ ] **Step 2: Build the .app**

```bash
npm run build
```

Expected: `dist/HiggTable-0.1.0.dmg` and `dist/mac/HiggTable.app` created.

- [ ] **Step 3: Open and verify the packaged app**

```bash
open dist/mac/HiggTable.app
```

Expected: App launches, connects to Airtable, same three-panel experience as `npm start`.

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: add .gitignore, app packages to dist/"
```

---

## After Phase 1

Once the app is running, explore the data and note:
- Field names and types in each table
- How task names are structured (confirm `_9x16` / `_16x9` / `_1x1` suffix pattern)
- Whether the 3 aspect-ratio variants share a common parent or are standalone records
- Any status/workflow fields that may be useful in Phase 2

This informs Phase 2 — the full file-renaming pipeline.
