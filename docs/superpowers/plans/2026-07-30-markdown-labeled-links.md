# Markdown-Lite Labeled Link Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `[label](url)` in a markdown-lite field renders as a single link with `label` as its visible text — even when a line break (or any whitespace) separates the `]` from the `(` — instead of today's bracketed plain text followed by a separate bare-URL link.

**Architecture:** Pure addition to the existing `renderer/markdown-data.js` module (no DOM/IPC/wiring changes — this only changes what HTML `renderMarkdownLite` produces, not how it's consumed by `renderer/app.js`). Two new functions, `unescapeBackslashes` and `linkifyMarkdownLinks`, plus a small guard added to the existing `linkifyUrls` so it doesn't re-wrap a URL that `linkifyMarkdownLinks` already placed inside an `href` attribute.

**Tech Stack:** Plain JS, Jest (extends the existing `tests/markdown-data.test.js`, no new test file).

## Global Constraints

- Only the plain `[label](url)` form — no reference-style or titled-link variants (per spec Non-goals).
- Backslash-unescaping applies only to the extracted label text, nowhere else in the rendered output (per spec Non-goals).
- Any whitespace (including newlines) between `]` and `(` counts as the same construct — not just true-adjacent Markdown syntax (per spec Goals).
- A bare URL not part of a `[label](url)` construct still linkifies exactly as before, using the URL itself as the link text (per spec Goals).

---

### Task 1: Add labeled-link matching to `renderer/markdown-data.js`

**Files:**
- Modify: `renderer/markdown-data.js`
- Modify: `tests/markdown-data.test.js` (one existing test's expectation changes — see Step 1 — plus new tests)

**Interfaces:**
- Consumes: nothing (only task; builds on the existing `escapeHtml`/`linkifyUrls`/`renderMarkdownLite` already in `renderer/markdown-data.js`).
- Produces: `unescapeBackslashes(text)` → string, `linkifyMarkdownLinks(html)` → string. Both are exported from `renderer/markdown-data.js` alongside the existing three functions; nothing outside this file needs to call them directly (`renderMarkdownLite` uses them internally), but they're exported for direct unit testing, matching how `escapeHtml`/`linkifyUrls` already are.

- [ ] **Step 1: Update the existing test and write the new failing tests**

The existing test `'renderMarkdownLite combines escaping, linkification, bold, and line breaks'` in `tests/markdown-data.test.js` uses an input (`[TikTok One_0486]` immediately followed by a newline then the URL in parens) that, under the new behavior, becomes a labeled link — its current expectation (bracket as plain text + separate bare-URL link) is the *old* behavior and must be updated. In `tests/markdown-data.test.js`, replace:

```javascript
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
```

with:

```javascript
test('renderMarkdownLite combines escaping, a labeled link, bold, and line breaks', () => {
  const input = 'Розвиток TTOne\n[TikTok One_0486]\n(https://drive.google.com/file/d/XYZ/view?usp=sharing)\n**Що робимо:** перегенеруємо відео креатора';
  const result = renderMarkdownLite(input);
  expect(result).toBe(
    'Розвиток TTOne<br>' +
    '<a href="https://drive.google.com/file/d/XYZ/view?usp=sharing" class="record-markdown-link">TikTok One_0486</a><br>' +
    '<strong>Що робимо:</strong> перегенеруємо відео креатора'
  );
});
```

Then update the `require` line at the top of the same file:

```javascript
const { escapeHtml, linkifyUrls, renderMarkdownLite } = require('../renderer/markdown-data');
```

to:

```javascript
const { escapeHtml, linkifyUrls, renderMarkdownLite, unescapeBackslashes, linkifyMarkdownLinks } = require('../renderer/markdown-data');
```

Then append these new tests to the end of the file:

```javascript
test('unescapeBackslashes strips a backslash before any character', () => {
  expect(unescapeBackslashes('TikTok\\_One\\*Two')).toBe('TikTok_One*Two');
});

test('linkifyMarkdownLinks converts [label](url) with a newline between them', () => {
  const input = '[TikTok One\\_0486\\_LO\\_US\\_Campaign\\_30\\_12\\_24]\n(https://drive.google.com/file/d/XYZ/view?usp=sharing)';
  expect(linkifyMarkdownLinks(input)).toBe(
    '<a href="https://drive.google.com/file/d/XYZ/view?usp=sharing" class="record-markdown-link">TikTok One_0486_LO_US_Campaign_30_12_24</a>'
  );
});

test('linkifyMarkdownLinks also matches true adjacent markdown syntax with no whitespace', () => {
  expect(linkifyMarkdownLinks('[Docs](https://example.com/docs)')).toBe(
    '<a href="https://example.com/docs" class="record-markdown-link">Docs</a>'
  );
});

test('a bare URL alongside a labeled link is not double-wrapped and still linkifies with the URL as its own text', () => {
  const input = '[Drive](https://example.com/a) also see https://example.com/b';
  expect(renderMarkdownLite(input)).toBe(
    '<a href="https://example.com/a" class="record-markdown-link">Drive</a> also see <a href="https://example.com/b" class="record-markdown-link">https://example.com/b</a>'
  );
});
```

- [ ] **Step 2: Run the tests to verify the new/changed ones fail**

Run: `npx jest tests/markdown-data.test.js`
Expected: FAIL — the updated `'renderMarkdownLite combines escaping, a labeled link, bold, and line breaks'` test fails (old code still produces the old bracket+bare-link output), and the 3 new tests fail with `unescapeBackslashes is not a function` / `linkifyMarkdownLinks is not a function`. The other pre-existing tests (`escapeHtml`, plain `linkifyUrls` cases, etc.) still pass unchanged.

- [ ] **Step 3: Implement the new functions and wire them into `renderMarkdownLite`**

In `renderer/markdown-data.js`, add `unescapeBackslashes` and `linkifyMarkdownLinks` right after `escapeHtml` and before the existing `linkifyUrls`:

```javascript
// Strips a backslash immediately before any character, e.g. "\_" -> "_" —
// undoes markdown-style backslash-escaping so labels display cleanly.
function unescapeBackslashes(text) {
  return text.replace(/\\(.)/g, '$1');
}

// Converts [label](url) into a link with `label` as its visible text —
// any whitespace (including a newline) between the closing `]` and the
// opening `(` counts, matching how these fields are actually written (not
// just true-adjacent Markdown syntax). Operates on already-escaped `html`,
// same as linkifyUrls below. Must run BEFORE linkifyUrls, since linkifyUrls
// is guarded against re-wrapping a URL already inside an href attribute —
// see the note on its regex below.
function linkifyMarkdownLinks(html) {
  return html.replace(/\[([^\[\]]+)\]\s*\(\s*(https?:\/\/[^\s()]+)\s*\)/g, (match, label, url) => {
    return `<a href="${url}" class="record-markdown-link">${unescapeBackslashes(label)}</a>`;
  });
}
```

Then modify the existing `linkifyUrls` to skip a URL immediately preceded by `href="` (so it doesn't re-wrap what `linkifyMarkdownLinks` just produced). Change:

```javascript
function linkifyUrls(html) {
  return html.replace(/https?:\/\/[^\s<]+/g, (match) => {
```

to:

```javascript
function linkifyUrls(html) {
  return html.replace(/(?<!href=")https?:\/\/[^\s<]+/g, (match) => {
```

Finally, update `renderMarkdownLite` to run `linkifyMarkdownLinks` before `linkifyUrls`. Change:

```javascript
function renderMarkdownLite(text) {
  return linkifyUrls(escapeHtml(text))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}
```

to:

```javascript
function renderMarkdownLite(text) {
  return linkifyUrls(linkifyMarkdownLinks(escapeHtml(text)))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}
```

And update the exports at the bottom. Change:

```javascript
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtml, linkifyUrls, renderMarkdownLite };
}
```

to:

```javascript
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtml, linkifyUrls, renderMarkdownLite, unescapeBackslashes, linkifyMarkdownLinks };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/markdown-data.test.js`
Expected: PASS (11/11 — the original 7 minus the 1 updated, plus the 1 updated and 3 new = 11 total).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, 48/48 (44 existing + 4 net-new from this task: 3 new tests + 1 updated test that was already counted).

- [ ] **Step 6: Commit**

```bash
git add renderer/markdown-data.js tests/markdown-data.test.js
git commit -m "Add markdown-lite labeled link support ([label](url))"
```
