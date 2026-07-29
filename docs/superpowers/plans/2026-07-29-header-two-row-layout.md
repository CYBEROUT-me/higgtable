# Two-Row Header Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split HiggTable's single-row header into two rows (nav tabs + icon actions on top, status filters + assignee/hint on bottom) so it fits cleanly at non-fullscreen window widths without any label wrapping onto multiple lines.

**Architecture:** Pure HTML/CSS change in `renderer/index.html` and `renderer/styles.css`. The header's child elements are regrouped into two new wrapper `<div>`s (`#header-top`, `#header-filters`); every existing element keeps its current `id`, so `renderer/app.js` (which looks elements up by id) needs no changes.

**Tech Stack:** Plain HTML/CSS (Electron renderer, no framework, no build step — edits take effect on a renderer reload).

## Global Constraints

- No element is added, removed, or renamed (per spec Goals) — only regrouped and restyled.
- `.tab` and `.status-chip` must never wrap their own text onto multiple lines (per spec Goals) — enforce with `white-space: nowrap; flex-shrink: 0;`.
- No changes to `renderer/app.js`, `renderer/canvas.js`, `renderer/canvas-data.js`, or any other panel/modal styling (per spec Non-goals).
- Work happens in the `in-app-notifications` worktree at `/Users/pc-63/Desktop/HiggTable/.claude/worktrees/in-app-notifications` — all file paths below are relative to that directory.

---

### Task 1: Restructure header markup and styles into two rows

**Files:**
- Modify: `renderer/index.html:10-41`
- Modify: `renderer/styles.css:29-45`

**Interfaces:**
- Consumes: nothing (first and only task).
- Produces: final DOM structure `header > #header-top > (nav#tabs, #header-actions)` and `header > #header-filters > (#status-filters, #header-filters-right > (#des-control, #multiselect-hint))`. All existing element ids (`tabs`, `dashboard-btn`, `canvas-btn`, `controls`→removed, `status-filters`, `des-control`, `des-select`, `multiselect-hint`, `columns-btn`, `notifications-control`, `notify-mute-btn`, `notify-bell-btn`, `notify-badge`, `notify-dropdown`, `notify-dropdown-empty`, `notify-dropdown-list`, `refresh-btn`, `settings-btn`) are preserved except `#controls`, which is deleted and replaced by `#header-top`/`#header-filters`/`#header-actions`/`#header-filters-right`. No later task depends on this — this is the whole plan.

- [ ] **Step 1: Replace the header markup**

Open `renderer/index.html` and replace lines 10-41 (the entire `<header>...</header>` block) with:

```html
  <header>
    <div id="header-top">
      <nav id="tabs">
        <button class="tab active" data-table="VCP Creatives">VCP</button>
        <button class="tab" data-table="PLM Creatives">PLM</button>
        <button class="tab" data-table="CMC Creatives">CMC</button>
        <button class="tab" data-table="LB Creatives">LB</button>
        <button id="dashboard-btn" class="tab" title="Task completion dashboard">📊 Dashboard</button>
        <button id="canvas-btn" class="tab" title="Lineage canvas — see how creatives branch from one another">🕸 Canvas</button>
      </nav>
      <div id="header-actions">
        <button id="columns-btn" title="Choose which columns to show">▤ Columns</button>
        <div id="notifications-control">
          <button id="notify-mute-btn" title="Mute notification sound">🔊</button>
          <button id="notify-bell-btn" title="Notifications">
            🔔
            <span id="notify-badge" class="hidden">0</span>
          </button>
          <div id="notify-dropdown" class="hidden">
            <div id="notify-dropdown-empty">No notifications yet</div>
            <div id="notify-dropdown-list"></div>
          </div>
        </div>
        <button id="refresh-btn" title="Refresh current table">⟳</button>
        <button id="settings-btn" title="Settings">⚙</button>
      </div>
    </div>
    <div id="header-filters">
      <div id="status-filters"></div>
      <div id="header-filters-right">
        <div id="des-control">
          <span>You:</span>
          <select id="des-select"><option value="">All</option></select>
        </div>
        <span id="multiselect-hint" title="Shift+click to select a range, Cmd/Ctrl+click to select individual rows">ⓘ multi-select</span>
      </div>
    </div>
  </header>
```

Nothing else in the file changes — `#status-filters` stays an empty div (populated by `renderer/app.js`'s `renderStatusFilters()`), and every button/id used by `renderer/app.js` is present verbatim.

- [ ] **Step 2: Replace the header CSS block**

Open `renderer/styles.css` and replace lines 29-45 (from the `/* ── Header ── */` comment through the `@keyframes refresh-spin` line) with:

```css
/* ── Header ── */
header { display: flex; flex-direction: column; border-bottom: 1px solid var(--border); background: var(--bg-surface); flex-shrink: 0; }
#header-top { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; padding: var(--space-3) var(--space-4) var(--space-2); }
#header-filters { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; padding: 0 var(--space-4) var(--space-3); }
nav#tabs { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.tab { background: none; border: 1px solid var(--border-strong); color: var(--text-secondary); padding: var(--space-1) var(--space-3); border-radius: var(--radius-sm); cursor: pointer; font-size: 11px; white-space: nowrap; flex-shrink: 0; }
.tab:hover { color: var(--text-primary); border-color: var(--accent); }
.tab.active { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); font-weight: 600; }
#header-actions { display: flex; align-items: center; gap: var(--space-3); margin-left: auto; }
#status-filters { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.status-chip { display: inline-flex; align-items: center; font-size: 10px; cursor: pointer; padding: var(--space-1) var(--space-2); border: 1px solid var(--border-strong); border-radius: 999px; color: var(--text-secondary); user-select: none; white-space: nowrap; flex-shrink: 0; }
.status-chip.on { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }
#header-filters-right { display: flex; align-items: center; gap: var(--space-3); margin-left: auto; }
#des-control { display: flex; align-items: center; gap: var(--space-2); font-size: 11px; color: var(--text-secondary); }
#multiselect-hint { font-size: 10px; color: var(--text-muted); cursor: default; user-select: none; }
#des-select { background: var(--bg-surface-2); border: 1px solid var(--border-strong); color: var(--text-primary); padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); font-size: 11px; cursor: pointer; }
#columns-btn { padding: var(--space-1) var(--space-3); font-size: 11px; }
#settings-btn, #refresh-btn { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 14px; padding: var(--space-1) var(--space-2); line-height: 1; }
#settings-btn:hover, #refresh-btn:hover { color: var(--text-primary); }
#refresh-btn:disabled { color: var(--border-strong); cursor: default; }
#refresh-btn.spinning { animation: refresh-spin 0.8s linear infinite; }
@keyframes refresh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
```

This drops the old single-row `header`/`nav#tabs`/`#controls` rules and replaces them with the two-row structure above. `#columns-btn` keeps its bordered look from the global `button` rule (`renderer/styles.css:88` in the unmodified file — unaffected by this edit) — the new `#columns-btn` rule here only overrides padding/font-size to match the other shrunk controls.

Immediately below, further down `renderer/styles.css` (originally lines 48-49), tighten the notification icon buttons to match: change

```css
#notify-mute-btn, #notify-bell-btn { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 16px; padding: var(--space-1) var(--space-2); line-height: 1; position: relative; }
```

to

```css
#notify-mute-btn, #notify-bell-btn { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 14px; padding: var(--space-1) var(--space-2); line-height: 1; position: relative; }
```

(font-size `16px` → `14px`, everything else unchanged) so the bell/mute icons visually match the shrunk refresh/settings icons next to them.

- [ ] **Step 3: Visually verify at full width**

Load `file:///Users/pc-63/Desktop/HiggTable/.claude/worktrees/in-app-notifications/renderer/index.html` in a browser (static preview is fine — `renderer/app.js`'s Airtable calls will fail harmlessly with "Enter your API key to get started", which doesn't affect header layout) at a wide viewport (e.g. 1400×800).

Expected: two visually distinct rows — top row has the 6 nav tabs on the left and 4 icon controls (Columns, mute, bell, refresh, settings) on the right; bottom row has status chips on the left (empty until `app.js` populates them — that's fine, the row should still not collapse to zero height) and "You:"/multi-select hint on the right. No control's text is wrapped onto two lines.

- [ ] **Step 4: Visually verify at narrow width**

Resize the same preview to roughly half-width (e.g. 800×700).

Expected: same two rows, tabs/icons/chips do not shrink below their content width or wrap their own text — if the row runs out of horizontal space, whole tabs/chips wrap down to a new line (because of `flex-wrap: wrap` on `#header-top`/`#header-filters`/`nav#tabs`/`#status-filters`), never mid-label.

- [ ] **Step 5: Run the existing test suite**

Run: `npm test`
Expected: PASS (no test in `tests/` touches the header DOM — see `tests/airtable.test.js`, `tests/canvas-data.test.js`, `tests/notifications-data.test.js` — so this is a regression check, not expected to catch anything new).

- [ ] **Step 6: Commit**

```bash
cd /Users/pc-63/Desktop/HiggTable/.claude/worktrees/in-app-notifications
git add renderer/index.html renderer/styles.css
git commit -m "Split header into two rows so it fits at non-fullscreen widths"
```
