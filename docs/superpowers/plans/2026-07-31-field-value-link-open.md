# Clickable-Open For URL-Valued Text Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any single-line text field whose current value is a URL (like `REF`) gets a small "open externally" icon button next to its still-fully-editable input.

**Architecture:** Single change to `buildFieldInput()`'s generic text-field fallback in `renderer/app.js` — when the value looks like a URL, wrap the existing (unchanged) `<input>` and a new icon button in a flex container instead of returning the bare input. Reuses `rewriteDriveLink` (`renderer/drive-links.js`) and `window.app.openExternal` (already shipped this session) for the click behavior, and adds a small standalone CSS rule for the new button.

**Tech Stack:** Plain JS/CSS, no framework, no new dependencies.

## Global Constraints

- The icon only appears when the field's current value starts with `http://` or `https://` — auto-detected by content, not a hardcoded field-name list (per spec Goals).
- The input itself is completely unchanged when there's no icon — same element, same behavior, no wrapper (per spec Goals).
- Clicking the icon opens the input's *live* current value (`inp.value`, not the original `val`), so it reflects an unsaved in-progress edit too (per spec Design).
- The new button's CSS is its own standalone rule — not refactored into a shared class with the header's existing icon buttons (per spec Non-goals).
- No live re-check while typing — the icon's presence is fixed at render time (per spec Non-goals).

---

### Task 1: Add the open-link icon to the text-field fallback

**Files:**
- Modify: `renderer/app.js:1194-1199` (`buildFieldInput`'s fallback branch)
- Modify: `renderer/styles.css` (new rules for `.record-text-field-with-link` and `.field-open-link-btn`)

**Interfaces:**
- Consumes: `rewriteDriveLink(url, accountIndex)` (`renderer/drive-links.js`, already a global via its `<script>` tag) and `window.app.openExternal(url)` (`preload.js`, already shipped).
- Produces: nothing later depends on this; only task.

- [ ] **Step 1: Update the fallback branch in `buildFieldInput`**

In `renderer/app.js`, find:

```javascript
  // Fallback for singleLineText, url, email, phoneNumber, and anything else
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = val == null ? '' : String(val);
  inp.onblur = () => updateRecordField(rec, tableName, field, inp.value || null, inp);
  return inp;
```

Change to:

```javascript
  // Fallback for singleLineText, url, email, phoneNumber, and anything else
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = val == null ? '' : String(val);
  inp.onblur = () => updateRecordField(rec, tableName, field, inp.value || null, inp);

  if (typeof val !== 'string' || !/^https?:\/\//i.test(val)) return inp;

  const wrap = document.createElement('div');
  wrap.className = 'record-text-field-with-link';
  wrap.appendChild(inp);

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'field-open-link-btn';
  openBtn.title = 'Open link';
  openBtn.innerHTML = `<svg class="icon-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/>
    <path d="M9.5 2.5h4v4"/>
    <path d="M13 3l-6 6"/>
  </svg>`;
  openBtn.onclick = () => window.app.openExternal(rewriteDriveLink(inp.value, state.driveAccountIndex));
  wrap.appendChild(openBtn);
  return wrap;
```

- [ ] **Step 2: Add the CSS for the wrapper and button**

In `renderer/styles.css`, find:

```css
.record-markdown-preview a.record-markdown-link { color: var(--accent); text-decoration: underline; cursor: pointer; }
```

Add immediately after it:

```css
.record-text-field-with-link { display: flex; align-items: center; gap: var(--space-2); }
.record-text-field-with-link input { flex: 1; }
.field-open-link-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; background: none; border: none; border-radius: var(--radius-sm); color: var(--text-muted); cursor: pointer; flex-shrink: 0; transition: background-color 0.15s, color 0.15s; }
.field-open-link-btn:hover { background: var(--bg-surface-2); color: var(--text-primary); }
```

- [ ] **Step 3: Manually verify in the browser**

Load `file:///Users/pc-63/Desktop/HiggTable/renderer/index.html` in a **fresh browser tab** (a previously-used tab may serve cached `app.js`/`styles.css` — open a new tab if anything looks stale), open DevTools console, and run:

```js
(function(){
  const rec = { id: 'r1', fields: { REF: 'https://drive.google.com/file/d/XYZ/view?usp=sharing', Name: 'Not a link' } };
  const field = { name: 'REF', type: 'singleLineText' };
  const el = buildFieldInput(rec, 'CMC Creatives', field, rec.fields.REF);
  document.body.appendChild(el);
  const plainEl = buildFieldInput(rec, 'CMC Creatives', { name: 'Name', type: 'singleLineText' }, rec.fields.Name);
  document.body.appendChild(plainEl);
  return JSON.stringify({
    urlFieldHasWrapper: el.className === 'record-text-field-with-link',
    urlFieldHasButton: !!el.querySelector('.field-open-link-btn'),
    plainFieldIsBareInput: plainEl.tagName === 'INPUT',
  });
})()
```

Expected: `{"urlFieldHasWrapper":true,"urlFieldHasButton":true,"plainFieldIsBareInput":true}` — the URL field gets wrapped with the icon button, the plain-text field stays a bare `<input>` exactly as before. Clean up the scratch elements afterward: `document.querySelectorAll('.record-text-field-with-link, input').forEach(el => { if (el.parentElement === document.body) el.remove(); })`. (Clicking the button to confirm it actually opens the browser requires the full packaged app, `npm start`, plus a real restart if `main.js`/`preload.js` aren't already loaded with the `open-external` handler — both are already shipped from earlier this session, so no restart should be needed here, only for the first time that feature landed.)

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS, 54/54 (unchanged — no test in `tests/` touches `buildFieldInput`).

- [ ] **Step 5: Commit**

```bash
git add renderer/app.js renderer/styles.css
git commit -m "Add clickable-open icon to URL-valued text fields in the record modal"
```
