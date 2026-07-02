# HiggTable Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine HiggTable's dark theme toward a Notion/Airtable-ish "Warm Charcoal" look — deeper blacks, a softened teal-green accent, generous rounding, subtle depth — using a CSS custom-property token system, with zero behavior changes.

**Architecture:** Pure CSS change to `renderer/styles.css`. No new HTML elements, no JS logic changes. Work proceeds bottom-up: define tokens first (no visual effect), then apply them surface-by-surface (header/tabs → table → dashboard → modals → buttons/panels), so each task produces an independently verifiable visual diff.

**Tech Stack:** Plain CSS (no preprocessor, no build step for styles — `renderer/styles.css` is loaded directly via `<link>` in `renderer/index.html`). Verification via Chrome DevTools Protocol screenshots against the real running Electron app (technique documented in Task 0).

## Global Constraints

- No new bundled fonts. Font stack stays `-apple-system, sans-serif`.
- No icon changes. Emoji icons (⚙ 📊 ⟳ ×) stay exactly as they are.
- No behavior/interaction changes of any kind — every existing feature (multi-select via Shift/Cmd-click, dashboard period filters, record editing, file renaming, notifications, field visibility settings) must work identically after each task.
- No changes to `main.js`, `preload.js`, `airtable.js`, or any `.js` file — `renderer/styles.css` only.
- Do not introduce new wrapper `<div>`s or modify `renderer/index.html` — every visual treatment is achievable by styling existing elements/classes already in the DOM.
- New token values (source of truth for every task below):
  ```css
  --bg-app: #151515;
  --bg-surface: #1e1e1e;
  --bg-surface-2: #212121;
  --border: #2e2e2e;
  --border-strong: #3a3a3a;
  --text-primary: #ececec;
  --text-secondary: #999;
  --text-muted: #666;
  --accent: #4fd6ad;
  --accent-bg: rgba(79, 214, 173, 0.15);
  --accent-strong: #3fb894;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 12px;
  --shadow-panel: 0 2px 8px rgba(0,0,0,0.3);
  --shadow-modal: 0 8px 24px rgba(0,0,0,0.45);
  --space-1: 4px;
  --space-2: 6px;
  --space-3: 8px;
  --space-4: 12px;
  --space-5: 16px;
  --space-6: 20px;
  --space-7: 24px;
  ```

---

## Task 0: Verification technique (read first, no code changes)

Every task below ends with a visual verification step using this exact technique — established throughout this project's development. Read this once; it is not repeated verbatim in each task.

**Launch the app against an isolated profile** (so it doesn't touch the real user's settings/cache) **with remote debugging enabled:**

```bash
TESTDIR=/tmp/higgtable-redesign-test
rm -rf "$TESTDIR"; mkdir -p "$TESTDIR"
cp ~/Library/Application\ Support/higgtable/settings.json "$TESTDIR/settings.json"
npx electron . --user-data-dir="$TESTDIR" --remote-debugging-port=9400 > /tmp/higgtable_redesign.log 2>&1 &
echo $! > /tmp/higgtable_redesign.pid
sleep 20
curl -s http://localhost:9400/json | head -c 200
```

This copies the real `settings.json` (which holds the Airtable API key) into an isolated profile so the app boots straight into real data without needing to re-enter a key, but writes nothing back to the real profile.

**Drive it and screenshot via a small Node script** (Node 18+ has a global `WebSocket` and `fetch` — no `npm install` needed):

```js
// /tmp/cdp_shot.js — usage: node /tmp/cdp_shot.js <outfile.png> <js-to-eval-before-shot>
const fs = require('fs');
async function main() {
  const list = await (await fetch('http://localhost:9400/json')).json();
  const target = list.find(t => t.url.includes('index.html'));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  function send(method, params = {}) {
    return new Promise(resolve => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }
  await new Promise(resolve => ws.addEventListener('open', resolve));
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  const [outfile, jsToEval] = process.argv.slice(2);
  if (jsToEval) {
    const res = await send('Runtime.evaluate', { expression: jsToEval, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(outfile, Buffer.from(shot.data, 'base64'));
  ws.close();
  process.exit(0);
}
main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
```

Run it with a watchdog so a hung CDP call can't block forever:
```bash
node /tmp/cdp_shot.js /tmp/shot.png "" &
NODE_PID=$!
( sleep 25 && kill -9 $NODE_PID 2>/dev/null ) &
wait $NODE_PID 2>/dev/null
```

Then use the Read tool on `/tmp/shot.png` to view it inline and visually compare against the design tokens/intent.

**Always clean up after the LAST task's verification:**
```bash
pkill -f "user-data-dir=/tmp/higgtable-redesign-test" 2>/dev/null
rm -rf /tmp/higgtable-redesign-test /tmp/higgtable_redesign.log /tmp/higgtable_redesign.pid /tmp/cdp_shot.js /tmp/shot*.png
```

Do not commit this cleanup — it's session hygiene, not part of the codebase.

---

## Task 1: Add design tokens (no visual change yet)

**Files:**
- Modify: `renderer/styles.css:1-2`

**Interfaces:**
- Produces: every CSS custom property listed in Global Constraints above, available to all later tasks via `var(--token-name)`.

- [ ] **Step 1: Add the `:root` token block above the existing `* { ... }` rule**

Current file starts with:
```css
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, sans-serif; font-size: 13px; background: #1e1e1e; color: #d4d4d4; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
```

Replace those two lines with:
```css
:root {
  --bg-app: #151515;
  --bg-surface: #1e1e1e;
  --bg-surface-2: #212121;
  --border: #2e2e2e;
  --border-strong: #3a3a3a;
  --text-primary: #ececec;
  --text-secondary: #999;
  --text-muted: #666;
  --accent: #4fd6ad;
  --accent-bg: rgba(79, 214, 173, 0.15);
  --accent-strong: #3fb894;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 12px;
  --shadow-panel: 0 2px 8px rgba(0,0,0,0.3);
  --shadow-modal: 0 8px 24px rgba(0,0,0,0.45);
  --space-1: 4px;
  --space-2: 6px;
  --space-3: 8px;
  --space-4: 12px;
  --space-5: 16px;
  --space-6: 20px;
  --space-7: 24px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, sans-serif; font-size: 13px; background: #1e1e1e; color: #d4d4d4; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
```

Note `body`'s background/color are intentionally left as the OLD hardcoded values in this step — nothing consumes the new tokens yet, so the app must look pixel-identical to before.

- [ ] **Step 2: Verify no visual change**

Using the Task 0 technique, screenshot the app's main table view (default state, no JS eval needed — just launch and shoot):
```bash
node /tmp/cdp_shot.js /tmp/shot-task1.png ""
```
Read `/tmp/shot-task1.png`. Expected: identical to the app before this change — same dark gray background, same colors everywhere. If anything looks different, a token was accidentally referenced somewhere — re-check the diff only touches the top of the file.

- [ ] **Step 3: Run the existing test suite**

```bash
npm test
```
Expected: all 5 tests in `tests/airtable.test.js` still pass (this change doesn't touch any `.js` file, so this is a pure regression guard).

- [ ] **Step 4: Commit**

```bash
git add renderer/styles.css
git commit -m "Add design token custom properties (no visual change yet)"
```

---

## Task 2: Apply tokens to header, tabs, and global body

**Files:**
- Modify: `renderer/styles.css:2` (body rule from Task 1)
- Modify: `renderer/styles.css` header section (originally lines 4–21, shifted by the Task 1 insertion — search for `/* ── Header ── */` to locate)

**Interfaces:**
- Consumes: tokens from Task 1 (`--bg-app`, `--bg-surface`, `--border`, `--text-primary`, `--text-secondary`, `--text-muted`, `--accent`, `--accent-bg`, `--radius-sm`, `--space-*`)

- [ ] **Step 1: Update body to use tokens**

Find:
```css
body { font-family: -apple-system, sans-serif; font-size: 13px; background: #1e1e1e; color: #d4d4d4; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
```
Replace with:
```css
body { font-family: -apple-system, sans-serif; font-size: 13px; background: var(--bg-app); color: var(--text-primary); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
```

- [ ] **Step 2: Update the header/tabs/controls block**

Find this entire block (the `/* ── Header ── */` section, up to but not including `@keyframes refresh-spin`):
```css
/* ── Header ── */
header { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid #333; background: #252525; flex-shrink: 0; }
nav#tabs { display: flex; gap: 4px; }
.tab { background: none; border: 1px solid #444; color: #888; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.tab:hover { color: #d4d4d4; border-color: #666; }
.tab.active { background: #1e4d8c; border-color: #1e4d8c; color: #fff; }
#controls { display: flex; align-items: center; gap: 12px; margin-left: auto; }
#status-filters { display: flex; gap: 6px; }
.status-chip { display: inline-flex; align-items: center; font-size: 11px; cursor: pointer; padding: 3px 8px; border: 1px solid #444; border-radius: 10px; color: #888; user-select: none; }
.status-chip.on { border-color: #4a9; color: #4a9; background: rgba(68,170,153,0.1); }
#des-control { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #888; }
#multiselect-hint { font-size: 11px; color: #555; cursor: default; user-select: none; }
#des-select { background: #2d2d2d; border: 1px solid #444; color: #d4d4d4; padding: 3px 6px; border-radius: 4px; font-size: 12px; cursor: pointer; }
#settings-btn, #refresh-btn { background: none; border: none; color: #666; cursor: pointer; font-size: 16px; padding: 2px 6px; line-height: 1; }
#settings-btn:hover, #refresh-btn:hover { color: #aaa; }
#refresh-btn:disabled { color: #444; cursor: default; }
#refresh-btn.spinning { animation: refresh-spin 0.8s linear infinite; }
```

Replace with:
```css
/* ── Header ── */
header { display: flex; align-items: center; gap: var(--space-4); padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--border); background: var(--bg-surface); flex-shrink: 0; }
nav#tabs { display: flex; gap: var(--space-1); }
.tab { background: none; border: 1px solid var(--border-strong); color: var(--text-secondary); padding: var(--space-2) var(--space-4); border-radius: var(--radius-sm); cursor: pointer; font-size: 12px; }
.tab:hover { color: var(--text-primary); border-color: var(--accent); }
.tab.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); font-weight: 600; }
#controls { display: flex; align-items: center; gap: var(--space-4); margin-left: auto; }
#status-filters { display: flex; gap: var(--space-2); }
.status-chip { display: inline-flex; align-items: center; font-size: 11px; cursor: pointer; padding: var(--space-2) var(--space-3); border: 1px solid var(--border-strong); border-radius: 999px; color: var(--text-secondary); user-select: none; }
.status-chip.on { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }
#des-control { display: flex; align-items: center; gap: var(--space-2); font-size: 12px; color: var(--text-secondary); }
#multiselect-hint { font-size: 11px; color: var(--text-muted); cursor: default; user-select: none; }
#des-select { background: var(--bg-surface-2); border: 1px solid var(--border-strong); color: var(--text-primary); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); font-size: 12px; cursor: pointer; }
#settings-btn, #refresh-btn { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 16px; padding: var(--space-1) var(--space-3); line-height: 1; }
#settings-btn:hover, #refresh-btn:hover { color: var(--text-primary); }
#refresh-btn:disabled { color: var(--border-strong); cursor: default; }
#refresh-btn.spinning { animation: refresh-spin 0.8s linear infinite; }
```

- [ ] **Step 3: Verify visually**

```bash
node /tmp/cdp_shot.js /tmp/shot-task2.png ""
```
Read `/tmp/shot-task2.png`. Expected: header background is now a deeper charcoal, the active tab shows as a teal-green tinted pill (not solid blue), status chips are fully rounded, everything else on screen (table, rows) still looks like the old un-migrated styling (this is expected — those get their tokens in later tasks).

- [ ] **Step 4: Run the test suite**

```bash
npm test
```
Expected: all 5 tests pass (no `.js` files touched).

- [ ] **Step 5: Commit**

```bash
git add renderer/styles.css
git commit -m "Apply design tokens to header, tabs, and body"
```

---

## Task 3: Apply tokens to the main records table and row selection states

**Files:**
- Modify: `renderer/styles.css`, the `/* ── Records table ── */` section

**Interfaces:**
- Consumes: tokens from Task 1.

- [ ] **Step 1: Replace the records table block**

Find:
```css
/* ── Records table ── */
main { flex: 1; overflow: auto; min-height: 0; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; padding: 5px 8px; background: #252525; position: sticky; top: 0; border-bottom: 1px solid #3a3a3a; color: #666; font-weight: normal; font-size: 11px; white-space: nowrap; z-index: 1; }
td { padding: 4px 8px; border-bottom: 1px solid #272727; white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
tr { cursor: pointer; }
tr:hover td { background: #242424; }
tr.selected td { background: #1e3a5f !important; }
tr.bulk-selected td { background: rgba(74,153,255,0.16); }
tr.bulk-selected:hover td { background: rgba(74,153,255,0.24); }
tr.highlight-flash td { animation: flash-highlight 1.4s ease-out 2; }
@keyframes flash-highlight { 0% { background: rgba(74,153,255,0.45); } 100% { background: transparent; } }
.empty { padding: 24px; color: #555; font-style: italic; text-align: center; margin-top: 40px; }
.error { color: #f66; }
```

Replace with:
```css
/* ── Records table ── */
main { flex: 1; overflow: auto; min-height: 0; margin: var(--space-4); background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-panel); }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; padding: var(--space-3) var(--space-4); background: var(--bg-surface); position: sticky; top: 0; border-bottom: 1px solid var(--border-strong); color: var(--text-muted); font-weight: normal; font-size: 11px; white-space: nowrap; z-index: 1; border-top-left-radius: var(--radius-lg); border-top-right-radius: var(--radius-lg); }
td { padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
tr { cursor: pointer; }
tr:hover td { background: var(--bg-surface-2); }
tr.selected td { background: var(--accent-bg) !important; border-left: 2px solid var(--accent); }
tr.bulk-selected td { background: rgba(79, 214, 173, 0.08); }
tr.bulk-selected:hover td { background: rgba(79, 214, 173, 0.14); }
tr.highlight-flash td { animation: flash-highlight 1.4s ease-out 2; }
@keyframes flash-highlight { 0% { background: rgba(79, 214, 173, 0.45); } 100% { background: transparent; } }
.empty { padding: var(--space-7); color: var(--text-muted); font-style: italic; text-align: center; margin-top: 40px; }
.error { color: #f66; }
```

Note: `main` picking up `margin` + its own `background`/`border`/`border-radius`/`box-shadow` is the "surface panel" treatment from the spec — no new wrapper element, just styling the existing `<main id="records-container">` directly. `th` gets matching top corner radii so the panel's rounded corners aren't visually cut off by the sticky header's own background.

- [ ] **Step 2: Verify visually — default and hover states**

```bash
node /tmp/cdp_shot.js /tmp/shot-task3-default.png ""
```
Read `/tmp/shot-task3-default.png`. Expected: the table now sits as a distinct rounded, bordered panel with a visible gap of the deeper `--bg-app` color around it, instead of filling the window edge-to-edge.

- [ ] **Step 3: Verify the selection states**

This requires selecting a row and a bulk-range via JS eval (the app exposes `state`, `render()`, etc. as page-scope globals since `renderer/app.js` isn't a module):
```bash
node /tmp/cdp_shot.js /tmp/shot-task3-selected.png "(() => { const rows = [...document.querySelectorAll('#records-container tbody tr')]; rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); rows[3].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); })()"
```
Wait — the shift-click needs a prior plain click to set the anchor, both dispatched in the same eval call above is correct (plain click on row 0 sets `state.selectedTask` + anchor, then shift-click on row 3 range-selects rows 0–3 into `state.selectedIds`). Read `/tmp/shot-task3-selected.png`. Expected: row 0 shows the stronger accent tint with a left accent border (rename-selected), rows 1–3 show the lighter accent tint (bulk-selected) — the two states must be visually distinguishable from each other.

- [ ] **Step 4: Run the test suite**

```bash
npm test
```
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add renderer/styles.css
git commit -m "Apply design tokens and surface-panel treatment to the records table"
```

---

## Task 4: Apply tokens to the Dashboard

**Files:**
- Modify: `renderer/styles.css`, the `/* ── Dashboard ── */` section

**Interfaces:**
- Consumes: tokens from Task 1.

- [ ] **Step 1: Replace the dashboard block**

Find:
```css
/* ── Dashboard ── */
#dashboard-container { flex: 1; overflow: auto; min-height: 0; padding: 20px 24px; }
#dashboard-controls { display: flex; align-items: center; gap: 6px; margin-bottom: 18px; flex-wrap: wrap; }
.dash-controls-label { color: #888; font-size: 12px; margin-right: 4px; }
.dash-preset { background: #2d2d2d; border: 1px solid #444; color: #999; padding: 4px 10px; border-radius: 10px; cursor: pointer; font-size: 11px; }
.dash-preset:hover { color: #d4d4d4; border-color: #666; }
.dash-preset.active { background: #1e4d8c; border-color: #1e4d8c; color: #fff; }
#dashboard-custom-range { display: flex; align-items: center; gap: 6px; color: #888; font-size: 12px; }
#dashboard-custom-range input[type=date] { background: #2d2d2d; border: 1px solid #444; color: #d4d4d4; padding: 3px 6px; border-radius: 4px; font-size: 11px; color-scheme: dark; }
#dashboard-range-label { color: #666; font-size: 11px; margin-left: 8px; }
#dashboard-refresh-btn { background: none; border: none; color: #666; cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 6px; margin-left: auto; }
#dashboard-refresh-btn:hover { color: #aaa; }
#dashboard-refresh-btn:disabled { color: #444; cursor: default; }
#dashboard-refresh-btn.spinning { animation: refresh-spin 0.8s linear infinite; }
.dash-note { color: #888; font-size: 12px; margin-bottom: 16px; }
.dash-note.warn { color: #fa0; }
table.dash-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 28px; }
table.dash-table caption { text-align: left; color: #888; font-size: 12px; margin-bottom: 8px; caption-side: top; }
table.dash-table th { text-align: left; padding: 6px 10px; background: #252525; border-bottom: 1px solid #3a3a3a; color: #666; font-weight: normal; font-size: 11px; }
table.dash-table td { padding: 6px 10px; border-bottom: 1px solid #272727; }
table.dash-table tr.total-row td { border-top: 1px solid #3a3a3a; color: #888; font-weight: bold; }
.dash-rank { color: #555; width: 24px; }
.dash-name { color: #d4d4d4; font-weight: bold; }
.dash-bar-cell { min-width: 200px; }
.dash-bar-track { background: #2a2a2a; border-radius: 3px; height: 14px; overflow: hidden; position: relative; }
.dash-bar-fill { background: #4a9; height: 100%; border-radius: 3px; }
.dash-bar-label { position: absolute; right: 6px; top: 0; font-size: 10px; line-height: 14px; color: #d4d4d4; }
.dash-type-count { color: #999; text-align: right; }
```

Replace with:
```css
/* ── Dashboard ── */
#dashboard-container { flex: 1; overflow: auto; min-height: 0; padding: var(--space-6) var(--space-7); }
#dashboard-controls { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-6); flex-wrap: wrap; }
.dash-controls-label { color: var(--text-secondary); font-size: 12px; margin-right: var(--space-1); }
.dash-preset { background: var(--bg-surface-2); border: 1px solid var(--border-strong); color: var(--text-secondary); padding: var(--space-2) var(--space-4); border-radius: 999px; cursor: pointer; font-size: 11px; }
.dash-preset:hover { color: var(--text-primary); border-color: var(--accent); }
.dash-preset.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); font-weight: 600; }
#dashboard-custom-range { display: flex; align-items: center; gap: var(--space-2); color: var(--text-secondary); font-size: 12px; }
#dashboard-custom-range input[type=date] { background: var(--bg-surface-2); border: 1px solid var(--border-strong); color: var(--text-primary); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); font-size: 11px; color-scheme: dark; }
#dashboard-range-label { color: var(--text-muted); font-size: 11px; margin-left: var(--space-3); }
#dashboard-refresh-btn { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 15px; line-height: 1; padding: var(--space-1) var(--space-3); margin-left: auto; }
#dashboard-refresh-btn:hover { color: var(--text-primary); }
#dashboard-refresh-btn:disabled { color: var(--border-strong); cursor: default; }
#dashboard-refresh-btn.spinning { animation: refresh-spin 0.8s linear infinite; }
.dash-note { color: var(--text-secondary); font-size: 12px; margin-bottom: var(--space-5); }
.dash-note.warn { color: #fa0; }
table.dash-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: var(--space-7); background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-panel); overflow: hidden; }
table.dash-table caption { text-align: left; color: var(--text-secondary); font-size: 12px; padding: var(--space-4) var(--space-4) 0; caption-side: top; }
table.dash-table th { text-align: left; padding: var(--space-3) var(--space-4); background: var(--bg-surface); border-bottom: 1px solid var(--border-strong); color: var(--text-muted); font-weight: normal; font-size: 11px; }
table.dash-table td { padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); }
table.dash-table tr.total-row td { border-top: 1px solid var(--border-strong); background: var(--bg-surface-2); color: var(--text-secondary); font-weight: bold; }
.dash-rank { color: var(--text-muted); width: 24px; }
.dash-name { color: var(--text-primary); font-weight: bold; }
.dash-bar-cell { min-width: 200px; }
.dash-bar-track { background: var(--bg-surface-2); border-radius: 999px; height: 14px; overflow: hidden; position: relative; }
.dash-bar-fill { background: linear-gradient(90deg, var(--accent), var(--accent-strong)); height: 100%; border-radius: 999px; }
.dash-bar-label { position: absolute; right: var(--space-2); top: 0; font-size: 10px; line-height: 14px; color: var(--text-primary); }
.dash-type-count { color: var(--text-secondary); text-align: right; }
```

- [ ] **Step 2: Verify visually**

The dashboard aggregates from `recordsCache`, which fills in over the first ~10-20s after launch as the 4 tables load in the background. Wait for that before opening it, so the screenshot shows real rows instead of the "still loading" note:

```bash
node /tmp/cdp_shot.js /tmp/shot-task4.png "(async () => { let waited = 0; while (waited < 40000) { if (TARGET_TABLES.every(n => recordsCache[n])) break; await new Promise(r => setTimeout(r, 2000)); waited += 2000; } document.getElementById('dashboard-btn').click(); })()"
```
Read `/tmp/shot-task4.png`. Expected: the leaderboard sits in a rounded bordered panel, progress bars are pill-shaped with a green gradient fill, the total row has a subtle distinct background, period preset buttons are pill-shaped matching the header's status chips.

- [ ] **Step 3: Run the test suite**

```bash
npm test
```
Expected: all 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add renderer/styles.css
git commit -m "Apply design tokens and surface-panel treatment to the Dashboard"
```

---

## Task 5: Apply tokens to all modals (Settings, record detail, field-visibility)

**Files:**
- Modify: `renderer/styles.css`, the `/* ── Settings modal ── */` and `/* ── Record detail modal ── */` sections

**Interfaces:**
- Consumes: tokens from Task 1.

- [ ] **Step 1: Replace the settings modal block**

Find:
```css
/* ── Settings modal ── */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal-overlay.hidden { display: none; }
.modal-box { background: #252525; border: 1px solid #3a3a3a; border-radius: 8px; padding: 22px 24px; min-width: 380px; }
.modal-box h2 { font-size: 14px; margin-bottom: 10px; }
.modal-box p { font-size: 12px; color: #888; margin-bottom: 8px; }
.modal-box input[type=password] { width: 100%; background: #1a1a1a; border: 1px solid #444; color: #d4d4d4; padding: 7px 8px; border-radius: 4px; font-size: 12px; font-family: monospace; margin-bottom: 14px; }
.modal-box input:focus { outline: 1px solid #4a9; border-color: #4a9; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
.hint { color: #555 !important; font-size: 11px !important; margin-top: 10px !important; }
.hidden { display: none !important; }
```

Replace with:
```css
/* ── Settings modal ── */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal-overlay.hidden { display: none; }
.modal-box { background: var(--bg-surface); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); box-shadow: var(--shadow-modal); padding: var(--space-6) var(--space-7); min-width: 380px; }
.modal-box h2 { font-size: 14px; margin-bottom: var(--space-3); color: var(--text-primary); }
.modal-box p { font-size: 12px; color: var(--text-secondary); margin-bottom: var(--space-3); }
.modal-box input[type=password] { width: 100%; background: var(--bg-app); border: 1px solid var(--border-strong); color: var(--text-primary); padding: var(--space-3); border-radius: var(--radius-sm); font-size: 12px; font-family: monospace; margin-bottom: var(--space-5); }
.modal-box input:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
.modal-actions { display: flex; gap: var(--space-3); justify-content: flex-end; }
.hint { color: var(--text-muted) !important; font-size: 11px !important; margin-top: var(--space-4) !important; }
.hidden { display: none !important; }
```

- [ ] **Step 2: Replace the record detail modal block**

Find:
```css
/* ── Record detail modal ── */
.record-modal-box { max-width: 720px; width: 90vw; max-height: 82vh; display: flex; flex-direction: column; }
.record-modal-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-shrink: 0; }
.record-modal-header h2 { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#record-modal-close, #record-fields-settings-btn { background: none; border: none; color: #666; cursor: pointer; font-size: 18px; line-height: 1; padding: 0 4px; flex-shrink: 0; }
#record-modal-close { font-size: 20px; }
#record-modal-close:hover, #record-fields-settings-btn:hover { color: #aaa; }
.field-settings-box { max-width: 420px; }
.field-settings-list { max-height: 50vh; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; margin: 10px 0 16px; }
.field-settings-item { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #d4d4d4; cursor: pointer; }
#record-modal-body { overflow-y: auto; flex: 1; }
.record-field-row { display: flex; gap: 14px; padding: 6px 0; border-bottom: 1px solid #2a2a2a; font-size: 12px; }
.record-field-label { width: 140px; flex-shrink: 0; color: #888; }
.record-field-value { flex: 1; color: #d4d4d4; word-break: break-word; }
.record-field-value a { color: #7af; }
.record-attachment-thumb { width: 72px; height: 72px; object-fit: cover; border-radius: 4px; margin: 0 6px 6px 0; border: 1px solid #3a3a3a; }
.record-attachment-gallery { display: flex; flex-wrap: wrap; }
.record-upload-section { display: flex; align-items: center; gap: 10px; padding: 6px 0 4px; }
.record-upload-status { font-size: 11px; color: #888; }
.record-upload-status.error { color: #f66; }
.record-readonly { color: #666; font-style: italic; }

.record-field-value select,
.record-field-value input[type=text],
.record-field-value input[type=number],
.record-field-value input[type=date],
.record-field-value textarea {
  width: 100%; background: #1a1a1a; border: 1px solid #444; color: #d4d4d4;
  padding: 5px 8px; border-radius: 4px; font-size: 12px; font-family: inherit;
  color-scheme: dark;
}
.record-field-value textarea { resize: vertical; }
.record-field-value select:focus,
.record-field-value input:focus,
.record-field-value textarea:focus { outline: 1px solid #4a9; border-color: #4a9; }
.record-field-value input[type=checkbox] { width: auto; }
.record-multiselect { display: flex; flex-direction: column; gap: 6px; border: 1px solid transparent; border-radius: 4px; padding: 2px; }
.record-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.record-chips:empty { display: none; }
.record-chip { display: inline-flex; align-items: center; gap: 6px; background: rgba(68,170,153,0.15); border: 1px solid #3a6b60; color: #7ecab5; padding: 2px 4px 2px 10px; border-radius: 12px; font-size: 11px; }
.record-chip-remove { background: none; border: none; color: #7ecab5; cursor: pointer; font-size: 13px; line-height: 1; padding: 0 4px; }
.record-chip-remove:hover { color: #fff; }
.record-field-value select.record-chip-add { width: auto; max-width: 220px; font-size: 11px; padding: 3px 6px; }
.field-saved { border-color: #4a9 !important; transition: border-color 0.2s; }
.field-error { border-color: #f66 !important; }
```

Replace with:
```css
/* ── Record detail modal ── */
.record-modal-box { max-width: 720px; width: 90vw; max-height: 82vh; display: flex; flex-direction: column; }
.record-modal-header { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4); padding-bottom: var(--space-4); border-bottom: 1px solid var(--border); flex-shrink: 0; }
.record-modal-header h2 { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }
#record-modal-close, #record-fields-settings-btn { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 18px; line-height: 1; padding: 0 var(--space-2); flex-shrink: 0; }
#record-modal-close { font-size: 20px; }
#record-modal-close:hover, #record-fields-settings-btn:hover { color: var(--text-primary); }
.field-settings-box { max-width: 420px; }
.field-settings-list { max-height: 50vh; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-2); margin: var(--space-4) 0 var(--space-5); }
.field-settings-item { display: flex; align-items: center; gap: var(--space-3); font-size: 12px; color: var(--text-primary); cursor: pointer; }
#record-modal-body { overflow-y: auto; flex: 1; }
.record-field-row { display: flex; gap: var(--space-5); padding: var(--space-3) 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.record-field-label { width: 140px; flex-shrink: 0; color: var(--text-secondary); }
.record-field-value { flex: 1; color: var(--text-primary); word-break: break-word; }
.record-field-value a { color: var(--accent); }
.record-attachment-thumb { width: 72px; height: 72px; object-fit: cover; border-radius: var(--radius-sm); margin: 0 var(--space-2) var(--space-2) 0; border: 1px solid var(--border-strong); }
.record-attachment-gallery { display: flex; flex-wrap: wrap; }
.record-upload-section { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) 0 var(--space-1); }
.record-upload-status { font-size: 11px; color: var(--text-secondary); }
.record-upload-status.error { color: #f66; }
.record-readonly { color: var(--text-muted); font-style: italic; }

.record-field-value select,
.record-field-value input[type=text],
.record-field-value input[type=number],
.record-field-value input[type=date],
.record-field-value textarea {
  width: 100%; background: var(--bg-app); border: 1px solid var(--border-strong); color: var(--text-primary);
  padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); font-size: 12px; font-family: inherit;
  color-scheme: dark;
}
.record-field-value textarea { resize: vertical; }
.record-field-value select:focus,
.record-field-value input:focus,
.record-field-value textarea:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
.record-field-value input[type=checkbox] { width: auto; }
.record-multiselect { display: flex; flex-direction: column; gap: var(--space-2); border: 1px solid transparent; border-radius: var(--radius-sm); padding: 2px; }
.record-chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.record-chips:empty { display: none; }
.record-chip { display: inline-flex; align-items: center; gap: var(--space-2); background: var(--accent-bg); border: 1px solid var(--accent-strong); color: var(--accent); padding: 2px var(--space-1) 2px var(--space-3); border-radius: 999px; font-size: 11px; }
.record-chip-remove { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 13px; line-height: 1; padding: 0 var(--space-2); }
.record-chip-remove:hover { color: #fff; }
.record-field-value select.record-chip-add { width: auto; max-width: 220px; font-size: 11px; padding: var(--space-2) var(--space-2); }
.field-saved { border-color: var(--accent) !important; transition: border-color 0.2s; }
.field-error { border-color: #f66 !important; }
```

- [ ] **Step 3: Verify visually — settings modal**

```bash
node /tmp/cdp_shot.js /tmp/shot-task5-settings.png "showSettingsModal(false)"
```
Read `/tmp/shot-task5-settings.png`. Expected: modal has visible rounded corners and a soft drop shadow lifting it off the background, matching the new palette.

- [ ] **Step 4: Verify visually — record detail modal**

```bash
node /tmp/cdp_shot.js /tmp/shot-task5-record.png "(() => { hideSettingsModal(); openRecordModal(recordsCache['VCP Creatives'][0], 'VCP Creatives'); })()"
```
Read `/tmp/shot-task5-record.png`. Expected: header has a clear divider line before the scrollable field list, field labels are a muted secondary color, inputs/selects have the new radius and border tokens, chips (for multi-select fields) show the teal-green accent instead of the old cyan-ish tone.

- [ ] **Step 5: Run the test suite**

```bash
npm test
```
Expected: all 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add renderer/styles.css
git commit -m "Apply design tokens to Settings, record detail, and field-visibility modals"
```

---

## Task 6: Apply tokens to buttons, rename panel, bulk actions bar, progress bar, and status bar; final full-app pass

**Files:**
- Modify: `renderer/styles.css`, remaining sections: `/* ── Rename panel ── */`, `/* ── Status bar ── */`, `/* ── Progress bar ── */`, `/* ── Bulk actions ── */`

**Interfaces:**
- Consumes: tokens from Task 1.

- [ ] **Step 1: Replace the rename panel block**

Find:
```css
/* ── Rename panel ── */
#rename-panel { border-top: 2px solid #1e4d8c; background: #1a1a1a; flex-shrink: 0; padding: 8px 12px; max-height: 260px; display: flex; flex-direction: column; gap: 6px; }
#rename-header { display: flex; align-items: center; gap: 8px; font-size: 12px; }
#rename-task-label { flex: 1; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#rename-task-name { color: #7af; font-family: monospace; font-size: 11px; }
#rename-panel-close { background: none; border: none; color: #666; cursor: pointer; font-size: 18px; line-height: 1; padding: 0 4px; flex-shrink: 0; }
#rename-panel-close:hover { color: #aaa; }
#drop-zone { border: 1px dashed #444; border-radius: 5px; padding: 10px 16px; text-align: center; color: #666; font-size: 12px; cursor: default; transition: border-color 0.15s, background 0.15s; }
#drop-zone.drag-over { border-color: #4a9; color: #4a9; background: rgba(68,170,153,0.06); }
#drop-zone button { background: none; border: none; color: #5af; cursor: pointer; font-size: 12px; text-decoration: underline; padding: 0; }
#file-list { overflow-y: auto; flex: 1; }
.file-row { display: flex; align-items: center; gap: 10px; padding: 3px 2px; font-size: 12px; border-bottom: 1px solid #242424; }
.fname { color: #888; min-width: 180px; overflow: hidden; text-overflow: ellipsis; }
.fdims { color: #555; min-width: 72px; font-size: 11px; }
.ftype { min-width: 28px; }
.ftype.ratio { color: #4a9; font-weight: bold; }
.ftype.unknown { color: #fa0; }
.farrow { color: #555; }
.fnew { color: #d4d4d4; font-family: monospace; font-size: 11px; }
.ferror { color: #f66; font-size: 11px; }
#rename-footer { display: flex; align-items: center; gap: 8px; padding-top: 4px; }
#rename-warning { flex: 1; font-size: 11px; color: #fa0; }
button.primary { background: #1e4d8c; border: 1px solid #2a5ea8; color: #fff; padding: 4px 14px; border-radius: 4px; cursor: pointer; font-size: 12px; }
button.primary:hover { background: #2a5ea8; }
button { background: #2d2d2d; border: 1px solid #444; color: #d4d4d4; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
button:hover { background: #3a3a3a; }
```

Replace with:
```css
/* ── Rename panel ── */
#rename-panel { border-top: 2px solid var(--accent); background: var(--bg-surface); flex-shrink: 0; padding: var(--space-4); max-height: 260px; display: flex; flex-direction: column; gap: var(--space-2); }
#rename-header { display: flex; align-items: center; gap: var(--space-3); font-size: 12px; }
#rename-task-label { flex: 1; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#rename-task-name { color: var(--accent); font-family: monospace; font-size: 11px; }
#rename-panel-close { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 18px; line-height: 1; padding: 0 var(--space-2); flex-shrink: 0; }
#rename-panel-close:hover { color: var(--text-primary); }
#drop-zone { border: 1px dashed var(--border-strong); border-radius: var(--radius-md); padding: var(--space-4) var(--space-5); text-align: center; color: var(--text-muted); font-size: 12px; cursor: default; transition: border-color 0.15s, background 0.15s; }
#drop-zone.drag-over { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }
#drop-zone button { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 12px; text-decoration: underline; padding: 0; }
#file-list { overflow-y: auto; flex: 1; }
.file-row { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-1) var(--space-1); font-size: 12px; border-bottom: 1px solid var(--border); }
.fname { color: var(--text-secondary); min-width: 180px; overflow: hidden; text-overflow: ellipsis; }
.fdims { color: var(--text-muted); min-width: 72px; font-size: 11px; }
.ftype { min-width: 28px; }
.ftype.ratio { color: var(--accent); font-weight: bold; }
.ftype.unknown { color: #fa0; }
.farrow { color: var(--text-muted); }
.fnew { color: var(--text-primary); font-family: monospace; font-size: 11px; }
.ferror { color: #f66; font-size: 11px; }
#rename-footer { display: flex; align-items: center; gap: var(--space-3); padding-top: var(--space-1); }
#rename-warning { flex: 1; font-size: 11px; color: #fa0; }
button.primary { background: var(--accent); border: 1px solid var(--accent-strong); color: #0d1512; padding: var(--space-2) var(--space-5); border-radius: var(--radius-sm); cursor: pointer; font-size: 12px; font-weight: 600; }
button.primary:hover { background: var(--accent-strong); }
button { background: var(--bg-surface-2); border: 1px solid var(--border-strong); color: var(--text-primary); padding: var(--space-2) var(--space-4); border-radius: var(--radius-sm); cursor: pointer; font-size: 12px; }
button:hover { background: var(--border); }
```

Note: `button.primary`'s text color changes from `#fff` to `#0d1512` (a near-black) because the new accent (`#4fd6ad`) is a light, bright color — white text on it would fail contrast. Dark text on a bright accent button is the correct choice here.

- [ ] **Step 2: Replace the status bar block**

Find:
```css
/* ── Status bar ── */
footer#statusbar { padding: 3px 10px; font-size: 11px; color: #555; border-top: 1px solid #2a2a2a; flex-shrink: 0; }
footer#statusbar.error { color: #f66; }
```

Replace with:
```css
/* ── Status bar ── */
footer#statusbar { padding: var(--space-1) var(--space-4); font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border); flex-shrink: 0; }
footer#statusbar.error { color: #f66; }
```

- [ ] **Step 3: Replace the progress bar block**

Find:
```css
/* ── Progress bar ── */
#progress-bar { height: 2px; flex-shrink: 0; overflow: hidden; opacity: 0; transition: opacity 0.15s; background: #222; }
#progress-bar.active { opacity: 1; }
#progress-bar-fill { height: 100%; width: 30%; background: #4a9; transform: translateX(-100%); animation: progress-slide 1.2s ease-in-out infinite; }
@keyframes progress-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }
```

Replace with:
```css
/* ── Progress bar ── */
#progress-bar { height: 2px; flex-shrink: 0; overflow: hidden; opacity: 0; transition: opacity 0.15s; background: var(--border); }
#progress-bar.active { opacity: 1; }
#progress-bar-fill { height: 100%; width: 30%; background: var(--accent); transform: translateX(-100%); animation: progress-slide 1.2s ease-in-out infinite; }
@keyframes progress-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }
```

- [ ] **Step 4: Replace the bulk actions bar block**

Find:
```css
/* ── Bulk actions ── */
#bulk-actions-bar { display: flex; align-items: center; gap: 12px; padding: 6px 12px; background: #1e3a5f; border-bottom: 1px solid #2a5ea8; font-size: 12px; flex-shrink: 0; }
#bulk-actions-bar.hidden { display: none; }
#bulk-actions-count { color: #9cc7f0; }
```

Replace with:
```css
/* ── Bulk actions ── */
#bulk-actions-bar { display: flex; align-items: center; gap: var(--space-4); padding: var(--space-2) var(--space-4); background: rgba(79, 214, 173, 0.12); border-bottom: 1px solid var(--accent-strong); font-size: 12px; flex-shrink: 0; }
#bulk-actions-bar.hidden { display: none; }
#bulk-actions-count { color: var(--accent); font-weight: 600; }
```

This keeps the bar visually distinct from a plain `bg-surface` panel (a stronger accent-tinted background than the passive row-selection tint) so it still reads as "an action is available here," per the spec.

- [ ] **Step 5: Full-app visual regression pass**

Run through every major view and screenshot each one:

```bash
# Main table default
node /tmp/cdp_shot.js /tmp/final-table.png ""
# Dashboard
node /tmp/cdp_shot.js /tmp/final-dashboard.png "document.getElementById('dashboard-btn').click()"
# Record modal — openRecordModal() is synchronous, so this needs no wait,
# and doesn't need the VCP tab to be active: recordsCache is populated
# regardless of which tab is showing.
node /tmp/cdp_shot.js /tmp/final-record.png "openRecordModal(recordsCache['VCP Creatives'][0], 'VCP Creatives')"
# Settings modal
node /tmp/cdp_shot.js /tmp/final-settings.png "(() => { closeRecordModal(); showSettingsModal(false); })()"
# Bulk actions bar + rename panel together
node /tmp/cdp_shot.js /tmp/final-bulk.png "(() => { hideSettingsModal(); const rows = [...document.querySelectorAll('#records-container tbody tr')]; rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); rows[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); })()"
```

Read each screenshot. Expected: every surface uses the Warm Charcoal palette consistently — no leftover blue (`#1e4d8c`, `#1e3a5f`, `#2a5ea8`), no leftover old cyan-teal (`#4a9`, `#44aa99`) alongside the new accent, no leftover sharp 4px corners next to the new 6–12px scale elsewhere. Grep for regressions as a backstop:

```bash
grep -nE '#1e4d8c|#1e3a5f|#2a5ea8|#4a9\b|#44aa99|rgba\(68,170,153|rgba\(74,153,255' renderer/styles.css
```
Expected: no output (empty). If anything matches, that rule was missed in an earlier task — fix it in this task since it's the final cleanup pass.

- [ ] **Step 6: Run the test suite one last time**

```bash
npm test
```
Expected: all 5 tests pass.

- [ ] **Step 7: Clean up test artifacts**

```bash
pkill -f "user-data-dir=/tmp/higgtable-redesign-test" 2>/dev/null
rm -rf /tmp/higgtable-redesign-test /tmp/higgtable_redesign.log /tmp/higgtable_redesign.pid /tmp/cdp_shot.js /tmp/shot*.png /tmp/final-*.png
```

- [ ] **Step 8: Commit**

```bash
git add renderer/styles.css
git commit -m "Apply design tokens to buttons, rename panel, bulk actions bar, and misc; complete redesign"
```
