# Settings Modal Blank-API-Key Save Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking "Save" in the Settings modal with a blank API key field just closes the modal — no alert, no forced re-entry — since Working Directory and Drive Account Index already save themselves independently of this button.

**Architecture:** Single early-return added to the existing `saveSettings()` function in `renderer/app.js` — no new files, no new IPC, no changes to the other two settings fields.

**Tech Stack:** Plain JS, no framework.

## Global Constraints

- The API key is only updated (and the cache-clear + `init()` re-fetch only runs) when a key was actually typed — unchanged from today (per spec Goals).
- Working Directory and Drive Account Index behavior is untouched (per spec Non-goals).
- No relabeling of the button or modal layout changes (per spec Non-goals).

---

### Task 1: Skip the alert and re-fetch when the API key field is left blank

**Files:**
- Modify: `renderer/app.js` (`saveSettings()`, currently lines 1819-1832)

**Interfaces:**
- Consumes: nothing (only task).
- Produces: nothing later depends on this.

- [ ] **Step 1: Update `saveSettings()`**

Find:

```javascript
async function saveSettings() {
  const key = document.getElementById('api-key-input').value.trim();
  if (!key) { alert('Please enter an API key.'); return; }
  const btn = document.getElementById('settings-save-btn');
  btn.disabled = true;
  try {
    await window.app.saveSettings({ apiKey: key });
    hideSettingsModal();
    Object.keys(recordsCache).forEach(k => delete recordsCache[k]);
    await init();
  } finally {
    btn.disabled = false;
  }
}
```

Change to:

```javascript
async function saveSettings() {
  const key = document.getElementById('api-key-input').value.trim();
  if (!key) { hideSettingsModal(); return; }
  const btn = document.getElementById('settings-save-btn');
  btn.disabled = true;
  try {
    await window.app.saveSettings({ apiKey: key });
    hideSettingsModal();
    Object.keys(recordsCache).forEach(k => delete recordsCache[k]);
    await init();
  } finally {
    btn.disabled = false;
  }
}
```

The only change is the second line: `alert('Please enter an API key.'); return;` becomes `hideSettingsModal(); return;`. Everything below it (the non-blank path) is untouched.

- [ ] **Step 2: Manually verify in the browser**

Load `file:///Users/pc-63/Desktop/HiggTable/renderer/index.html` in a **fresh browser tab** (a previously-used tab may serve cached `app.js` — open a new tab if anything looks stale), open DevTools console, and run:

```js
document.getElementById('settings-btn').click();
document.getElementById('api-key-input').value = '';
document.getElementById('settings-save-btn').click();
document.getElementById('settings-modal').classList.contains('hidden')
```

Expected: `true` (the modal closed) with no `alert()` dialog appearing (this static preview has no real Airtable connection, so `hasApiKey()`/`showSettingsModal(true)` may re-open it on the next `boot()` cycle if one runs — that's unrelated to this fix; the check here is only that clicking Save with a blank key closes the modal immediately without an alert).

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS, 54/54 (unchanged — no test in `tests/` touches `saveSettings()`, so this is a regression check, not expected to catch anything new).

- [ ] **Step 4: Commit**

```bash
git add renderer/app.js
git commit -m "Let Settings Save close the modal when API key is left blank"
```
