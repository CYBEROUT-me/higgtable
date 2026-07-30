# Markdown-Lite Link Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bare `http(s)://` URLs inside the record modal's markdown-lite long-text preview (Description, etc.) render as clickable links that open in the OS default browser.

**Architecture:** Extract `renderMarkdownLite()`'s logic into a new pure module, `renderer/markdown-data.js` (mirroring the `canvas-data.js`/`notifications-data.js`/`dashboard-data.js` split already established in this codebase), replacing its DOM-based HTML-escaping (`div.textContent`/`innerHTML`) with an equivalent pure string function so the whole thing — escaping, linkification, bold, line breaks — is Jest-testable without a DOM. `renderer/app.js` keeps calling `renderMarkdownLite()` by name (now sourced from the new file) and gains a click-interception handler so clicking a rendered link opens it externally via a new `window.app.openExternal()` IPC bridge, rather than navigating the Electron window itself.

**Tech Stack:** Plain JS (no framework), Jest for the pure-logic unit tests, Electron `ipcMain`/`contextBridge`/`shell.openExternal` for the external-link IPC bridge.

## Global Constraints

- Only bare URLs are linkified — no `[label](url)` markdown syntax (per spec Non-goals).
- Dedicated URL-type fields (Creative Link, Figma/Canvas link, Preview) are untouched — stay plain editable text inputs (per spec Non-goals).
- Trailing-punctuation trimming is a single-pass strip, not a balanced-parenthesis parser — a known, documented simplification (per spec Non-goals).
- `open-external`'s IPC handler must validate the URL starts with `http://` or `https://` before calling `shell.openExternal` — it processes arbitrary user/Airtable-authored text, not a trusted internal value (per spec Design).
- Clicking anywhere in the preview other than a link still opens the edit textarea, unchanged from today (per spec Design).

---

### Task 1: Pure markdown-lite rendering module

**Files:**
- Create: `renderer/markdown-data.js`
- Test: `tests/markdown-data.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `escapeHtml(text)` → string, `linkifyUrls(html)` → string, `renderMarkdownLite(text)` → string (HTML). Task 2 loads this file as a global script (matching `notifications-data.js`/`dashboard-data.js`) and calls `renderMarkdownLite` by name from `renderer/app.js` — no other function from this module is called directly from app.js.

- [ ] **Step 1: Write the failing tests**

Create `tests/markdown-data.test.js`:

```javascript
const { escapeHtml, linkifyUrls, renderMarkdownLite } = require('../renderer/markdown-data');

test('escapeHtml escapes &, <, and > but leaves quotes alone', () => {
  expect(escapeHtml('Tom & Jerry <script> "quoted"')).toBe('Tom &amp; Jerry &lt;script&gt; "quoted"');
});

test('linkifyUrls wraps a bare URL with no surrounding punctuation', () => {
  expect(linkifyUrls('See https://example.com/path for details')).toBe(
    'See <a href="https://example.com/path" class="record-markdown-link">https://example.com/path</a> for details'
  );
});

test('linkifyUrls strips a trailing closing paren, matching the reported (url) pattern', () => {
  const input = '(https://drive.google.com/file/d/XYZ/view?usp=sharing)';
  expect(linkifyUrls(input)).toBe(
    '(<a href="https://drive.google.com/file/d/XYZ/view?usp=sharing" class="record-markdown-link">https://drive.google.com/file/d/XYZ/view?usp=sharing</a>)'
  );
});

test('linkifyUrls strips trailing sentence punctuation', () => {
  expect(linkifyUrls('Link: https://example.com/a.')).toBe(
    'Link: <a href="https://example.com/a" class="record-markdown-link">https://example.com/a</a>.'
  );
  expect(linkifyUrls('Link: https://example.com/a,')).toBe(
    'Link: <a href="https://example.com/a" class="record-markdown-link">https://example.com/a</a>,'
  );
});

test('linkifyUrls leaves text with no URL unchanged', () => {
  expect(linkifyUrls('No links here.')).toBe('No links here.');
});

test('renderMarkdownLite combines escaping, linkification, bold, and line breaks', () => {
  const input = 'Розвиток TTOne\n[TikTok One_0486]\n(https://drive.google.com/file/d/XYZ/view?usp=sharing)\n**Що робимо:** перегенеруємо відео креатора';
  const result = renderMarkdownLite(input);
  expect(result).toBe(
    'Розвиток TTOne<br>' +
    '[TikTok One_0486]<br>' +
    '(<a href="https://drive.google.com/file/d/XYZ/view?usp=sharing" class="record-markdown-link">https://drive.google.com/file/d/XYZ/view?usp=sharing</a>)<br>' +
    '<strong>Що робимо:</strong> перегенеруємо відео креатора'
  );
});

test('renderMarkdownLite still escapes HTML-significant characters in plain text', () => {
  expect(renderMarkdownLite('a < b && b > c')).toBe('a &lt; b &amp;&amp; b &gt; c');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/markdown-data.test.js`
Expected: FAIL with `Cannot find module '../renderer/markdown-data'`.

- [ ] **Step 3: Implement `renderer/markdown-data.js`**

```javascript
// renderer/markdown-data.js
// Pure markdown-lite rendering for long text fields (Description, etc.):
// HTML-escaping, bare-URL linkification, **bold**, and line breaks. No DOM
// access here — mirrors the canvas-data.js / notifications-data.js /
// dashboard-data.js split so this can run under plain Jest.

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Wraps bare http(s) URLs in already-escaped `html` with a clickable
// anchor, trimming trailing punctuation (common when a URL is wrapped in
// parens or ends a sentence) out of the link so it isn't swallowed into
// the href. A single-pass strip, not a balanced-parenthesis parser — see
// the design doc's Non-goals for the known trade-off.
function linkifyUrls(html) {
  return html.replace(/https?:\/\/[^\s<]+/g, (match) => {
    let url = match;
    let trailing = '';
    while (url.length && /[).,;:!?\]}'"]$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    return `<a href="${url}" class="record-markdown-link">${url}</a>${trailing}`;
  });
}

// Minimal markdown-lite renderer for long text fields (Description, etc.) —
// HTML-escaping, bare-URL links, **bold**, and line breaks, matching how
// these fields are actually written in Airtable, without pulling in a full
// markdown library.
function renderMarkdownLite(text) {
  return linkifyUrls(escapeHtml(text))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtml, linkifyUrls, renderMarkdownLite };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/markdown-data.test.js`
Expected: PASS (7/7 tests).

- [ ] **Step 5: Commit**

```bash
git add renderer/markdown-data.js tests/markdown-data.test.js
git commit -m "Add pure markdown-lite rendering module with URL linkification"
```

---

### Task 2: Wire linkified rendering + external-link opening into the app

**Files:**
- Modify: `renderer/index.html:207-210` (script tag order)
- Modify: `renderer/app.js:1200-1252` (remove the old `renderMarkdownLite`, update `buildMarkdownField`'s click handling)
- Modify: `preload.js:20-33` (`contextBridge.exposeInMainWorld('app', {...})`)
- Modify: `main.js` (near the `get-log-path` handler)
- Modify: `renderer/styles.css:226-233` (`.record-markdown-*` rules)

**Interfaces:**
- Consumes: `renderMarkdownLite(text)` from Task 1 (`renderer/markdown-data.js`), loaded as a global via `<script>` tag.
- Produces: `window.app.openExternal(url)` (returns a Promise, result unused) — nothing later depends on this; last task.

- [ ] **Step 1: Load `markdown-data.js` before `app.js`**

In `renderer/index.html`, current script tags (after the earlier dashboard work):

```html
  <script src="notifications-data.js"></script>
  <script src="dashboard-data.js"></script>
  <script src="app.js"></script>
  <script src="canvas-data.js"></script>
  <script src="canvas.js"></script>
```

Change to:

```html
  <script src="notifications-data.js"></script>
  <script src="dashboard-data.js"></script>
  <script src="markdown-data.js"></script>
  <script src="app.js"></script>
  <script src="canvas-data.js"></script>
  <script src="canvas.js"></script>
```

- [ ] **Step 2: Remove the old `renderMarkdownLite` from `renderer/app.js`**

Delete this block entirely (it's now provided globally by `markdown-data.js`, loaded before `app.js`):

```javascript
// Minimal markdown-lite renderer for long text fields (Description, etc.) —
// just **bold** and line breaks, matching how these fields are actually
// written in Airtable, without pulling in a full markdown library.
function renderMarkdownLite(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

```

(Leave the comment immediately above `buildMarkdownField` — "Shows rendered markdown by default; clicking swaps to a plain textarea..." — and the function itself in place; only the `renderMarkdownLite` function above it is removed.)

- [ ] **Step 3: Intercept link clicks in `buildMarkdownField`**

In `renderer/app.js`, find:

```javascript
  preview.onclick = showEditor;
```

within `buildMarkdownField`, and replace with:

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

- [ ] **Step 4: Add the `openExternal` bridge in `preload.js`**

Find:

```javascript
  getLogPath:        ()            => ipcRenderer.invoke('get-log-path'),
});
```

Change to:

```javascript
  getLogPath:        ()            => ipcRenderer.invoke('get-log-path'),
  openExternal:      (url)         => ipcRenderer.invoke('open-external', url),
});
```

- [ ] **Step 5: Add the `open-external` handler in `main.js`**

Find:

```javascript
ipcMain.handle('get-log-path', () => logFilePath);
```

Change to:

```javascript
ipcMain.handle('get-log-path', () => logFilePath);
ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});
```

- [ ] **Step 6: Add link styling in `renderer/styles.css`**

Find:

```css
.record-markdown-empty { color: var(--text-muted); font-style: italic; }
```

Change to:

```css
.record-markdown-empty { color: var(--text-muted); font-style: italic; }
.record-markdown-preview a.record-markdown-link { color: var(--accent); text-decoration: underline; cursor: pointer; }
```

- [ ] **Step 7: Manually verify in the browser**

Load `file:///Users/pc-63/Desktop/HiggTable/renderer/index.html` in a **fresh browser tab** (a previously-used tab may serve cached `app.js`/`markdown-data.js` — open a new tab if anything looks stale), open DevTools console, and run:

```js
document.body.innerHTML += '<div id="scratch" class="record-markdown-field"></div>';
const scratch = document.getElementById('scratch');
scratch.innerHTML = renderMarkdownLite('Розвиток TTOne\n[TikTok One_0486]\n(https://drive.google.com/file/d/XYZ/view?usp=sharing)\n**Що робимо:** перегенеруємо відео креатора');
scratch.className = 'record-markdown-preview';
```

Expected: the text renders with line breaks, "Що робимо:" in bold (accent-colored per the existing `.record-markdown-preview strong` rule), and the URL (ending at `sharing`, with the `)` outside it) rendered as an underlined accent-colored link. Since `window.app.openExternal` isn't wired up outside the real Electron app (no `window.app` in a plain browser tab), clicking the link here will throw in the console — that's expected in this scratch check; the actual click-to-open behavior can only be verified by running the packaged app (`npm start`) and clicking a real Description field's link, confirming it opens in the system default browser instead of navigating the app window. Remove the scratch element afterward: `scratch.remove()`.

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: PASS, now 44/44 (37 existing + 7 new from Task 1).

- [ ] **Step 9: Commit**

```bash
git add renderer/index.html renderer/app.js preload.js main.js renderer/styles.css
git commit -m "Linkify bare URLs in markdown-lite previews, open externally"
```
