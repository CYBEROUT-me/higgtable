# Google Drive Account-Index Link Rewriting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google Drive links open with a specific Google account by inserting `/u/<N>/` into the URL at click time, where `<N>` is a single value configured once in Settings.

**Architecture:** A new pure module, `renderer/drive-links.js` (mirroring `canvas-data.js`/`notifications-data.js`/`dashboard-data.js`/`markdown-data.js`), exports `rewriteDriveLink(url, accountIndex)`. `renderer/app.js` calls it at the moment a markdown-lite link is clicked (not in the render pipeline), and gains a new Settings field (`state.driveAccountIndex`) that saves immediately on change, following the existing working-directory field's precedent rather than the API-key Save button's.

**Tech Stack:** Plain JS, Jest for the pure-logic unit tests, no DOM/IPC changes needed beyond one new settings field.

## Global Constraints

- Only `https://drive.google.com/drive/...` links are touched — no other Google domains (per spec Non-goals).
- A link that already has its own `/u/N/` segment is left unchanged, not overwritten (per spec Goals).
- `accountIndex` only activates rewriting when it's a non-negative integer string (`/^\d+$/` after trimming) — `0` is a valid, distinct value from blank/unset, which must NOT rewrite (per spec Goals/Testing).
- Rewriting happens at click time in `renderer/app.js`, not inside `renderer/markdown-data.js`'s render pipeline — the displayed/hovered `href` stays as originally written (per spec Design).
- The new Settings field saves immediately on change, independent of the main Save button (per spec Design).

---

### Task 1: Pure `rewriteDriveLink` function

**Files:**
- Create: `renderer/drive-links.js`
- Test: `tests/drive-links.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `rewriteDriveLink(url, accountIndex)` → string. Task 2 loads this file as a global script (matching the `notifications-data.js`/`dashboard-data.js`/`markdown-data.js` pattern) and calls `rewriteDriveLink` by name from `renderer/app.js`.

- [ ] **Step 1: Write the failing tests**

Create `tests/drive-links.test.js`:

```javascript
const { rewriteDriveLink } = require('../renderer/drive-links');

test('inserts /u/N/ into a Drive URL with no existing account segment', () => {
  const url = 'https://drive.google.com/drive/search?q=parent:X%20title:Y';
  expect(rewriteDriveLink(url, 2)).toBe('https://drive.google.com/drive/u/2/search?q=parent:X%20title:Y');
});

test('accepts a string accountIndex the same as a number', () => {
  const url = 'https://drive.google.com/drive/folders/ABC123';
  expect(rewriteDriveLink(url, '2')).toBe('https://drive.google.com/drive/u/2/folders/ABC123');
});

test('account index 0 rewrites — it is a valid value, distinct from unset', () => {
  const url = 'https://drive.google.com/drive/my-drive';
  expect(rewriteDriveLink(url, 0)).toBe('https://drive.google.com/drive/u/0/my-drive');
});

test('leaves a URL that already has its own /u/N/ segment untouched', () => {
  const url = 'https://drive.google.com/drive/u/5/folders/ABC123';
  expect(rewriteDriveLink(url, 2)).toBe(url);
});

test('leaves a non-Drive URL untouched', () => {
  const url = 'https://example.com/drive/search?q=parent:X';
  expect(rewriteDriveLink(url, 2)).toBe(url);
});

test('treats a blank, undefined, or non-numeric accountIndex as no rewriting', () => {
  const url = 'https://drive.google.com/drive/search?q=parent:X';
  expect(rewriteDriveLink(url, '')).toBe(url);
  expect(rewriteDriveLink(url, undefined)).toBe(url);
  expect(rewriteDriveLink(url, 'abc')).toBe(url);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/drive-links.test.js`
Expected: FAIL with `Cannot find module '../renderer/drive-links'`.

- [ ] **Step 3: Implement `renderer/drive-links.js`**

```javascript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/drive-links.test.js`
Expected: PASS (6/6 tests).

- [ ] **Step 5: Commit**

```bash
git add renderer/drive-links.js tests/drive-links.test.js
git commit -m "Add pure Drive-link account-index rewriting"
```

---

### Task 2: Wire the setting and click-time rewriting into the app

**Files:**
- Modify: `renderer/index.html:158-163` (`#settings-modal`), script tag order (~line 207-211)
- Modify: `renderer/app.js:43-64` (`state`), `:203-214` (`boot()`), `:1231-1240` (link click handler in `buildMarkdownField`), `:1807-1813` (`showSettingsModal()`), `:1917-1928` (event wiring)

**Interfaces:**
- Consumes: `rewriteDriveLink(url, accountIndex)` from Task 1 (`renderer/drive-links.js`), loaded as a global via `<script>` tag.
- Produces: `state.driveAccountIndex` (string) — nothing later depends on this; last task.

- [ ] **Step 1: Load `drive-links.js` before `app.js`**

In `renderer/index.html`, current script tags:

```html
  <script src="notifications-data.js"></script>
  <script src="dashboard-data.js"></script>
  <script src="markdown-data.js"></script>
  <script src="app.js"></script>
  <script src="canvas-data.js"></script>
  <script src="canvas.js"></script>
```

Change to:

```html
  <script src="notifications-data.js"></script>
  <script src="dashboard-data.js"></script>
  <script src="markdown-data.js"></script>
  <script src="drive-links.js"></script>
  <script src="app.js"></script>
  <script src="canvas-data.js"></script>
  <script src="canvas.js"></script>
```

- [ ] **Step 2: Add the settings field markup**

In `renderer/index.html`, find:

```html
      <h2>Working Directory</h2>
      <p>Folder to search for "_1x1.png" previews when using "Set Previews":</p>
      <div id="working-dir-row">
        <input type="text" id="working-dir-input" readonly placeholder="Not set">
        <button id="browse-dir-btn">Browse…</button>
      </div>

      <div class="modal-actions">
```

Change to:

```html
      <h2>Working Directory</h2>
      <p>Folder to search for "_1x1.png" previews when using "Set Previews":</p>
      <div id="working-dir-row">
        <input type="text" id="working-dir-input" readonly placeholder="Not set">
        <button id="browse-dir-btn">Browse…</button>
      </div>

      <h2>Google Drive Account</h2>
      <p>Opens Drive links with this account index (drive.google.com/drive/u/N/...) — leave blank to open links as-is:</p>
      <input type="number" id="drive-account-index-input" min="0" placeholder="e.g. 2">

      <div class="modal-actions">
```

- [ ] **Step 3: Add `driveAccountIndex` to `state` and initialize it in `boot()`**

In `renderer/app.js`, find:

```javascript
  workingDirectory: '', // folder searched by "Set Previews" for "<task>_1x1.png" files
};
```

Change to:

```javascript
  workingDirectory: '', // folder searched by "Set Previews" for "<task>_1x1.png" files
  driveAccountIndex: '', // Google account index (drive.google.com/drive/u/N/...) for rewriting Drive links before opening; '' = no rewriting
};
```

Then find:

```javascript
async function boot() {
  log('boot: checking for API key');
  const settings = await window.app.getSettings();
  state.workingDirectory = settings.workingDirectory || '';
```

Change to:

```javascript
async function boot() {
  log('boot: checking for API key');
  const settings = await window.app.getSettings();
  state.workingDirectory = settings.workingDirectory || '';
  state.driveAccountIndex = settings.driveAccountIndex || '';
```

- [ ] **Step 4: Populate the input when the settings modal opens**

In `renderer/app.js`, find:

```javascript
function showSettingsModal(forced = false) {
  document.getElementById('settings-modal').classList.remove('hidden');
  document.getElementById('settings-cancel-btn').style.display = forced ? 'none' : '';
  document.getElementById('api-key-input').value = '';
  document.getElementById('working-dir-input').value = state.workingDirectory || '';
  document.getElementById('api-key-input').focus();
}
```

Change to:

```javascript
function showSettingsModal(forced = false) {
  document.getElementById('settings-modal').classList.remove('hidden');
  document.getElementById('settings-cancel-btn').style.display = forced ? 'none' : '';
  document.getElementById('api-key-input').value = '';
  document.getElementById('working-dir-input').value = state.workingDirectory || '';
  document.getElementById('drive-account-index-input').value = state.driveAccountIndex || '';
  document.getElementById('api-key-input').focus();
}
```

- [ ] **Step 5: Save the field immediately on change**

In `renderer/app.js`, find:

```javascript
document.getElementById('browse-dir-btn').addEventListener('click', async () => {
  const dir = await window.app.pickDirectory();
  if (!dir) return;
  state.workingDirectory = dir;
  document.getElementById('working-dir-input').value = dir;
  await window.app.saveSettings({ workingDirectory: dir });
  log(`browse-dir-btn: working directory set to ${dir}`);
});
```

Add immediately after it:

```javascript
document.getElementById('drive-account-index-input').addEventListener('change', async (e) => {
  const value = e.target.value.trim();
  state.driveAccountIndex = value;
  await window.app.saveSettings({ driveAccountIndex: value });
  log(`drive-account-index-input: Drive account index set to "${value}"`);
});
```

- [ ] **Step 6: Rewrite the link at click time**

In `renderer/app.js`, find (inside `buildMarkdownField`):

```javascript
  preview.onclick = (e) => {
    const link = e.target.closest('a.record-markdown-link');
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      window.app.openExternal(link.href);
      return;
    }
    showEditor();
  };
```

Change to:

```javascript
  preview.onclick = (e) => {
    const link = e.target.closest('a.record-markdown-link');
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      window.app.openExternal(rewriteDriveLink(link.href, state.driveAccountIndex));
      return;
    }
    showEditor();
  };
```

- [ ] **Step 7: Manually verify in the browser**

Load `file:///Users/pc-63/Desktop/HiggTable/renderer/index.html` in a **fresh browser tab** (a previously-used tab may serve cached `app.js` — open a new tab if anything looks stale), open DevTools console, and run:

```js
typeof rewriteDriveLink === 'function' ? rewriteDriveLink('https://drive.google.com/drive/search?q=parent:X', 2) : 'MISSING'
```

Expected: `"https://drive.google.com/drive/u/2/search?q=parent:X"`.

Then check the settings modal markup and wiring:

```js
document.getElementById('drive-account-index-input') ? 'present' : 'MISSING'
```

Expected: `"present"`. (Full end-to-end click behavior — settings persisting across a real app restart, and a real Drive link opening with the right account — can only be verified by running the packaged app, `npm start`, and testing there, same as the `openExternal` bridge itself required a full app restart to pick up in the prior task.)

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: PASS, now 54/54 (48 existing + 6 new from Task 1).

- [ ] **Step 9: Commit**

```bash
git add renderer/index.html renderer/app.js
git commit -m "Wire Drive account-index setting and click-time link rewriting"
```
