# Header Icon Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the header's mismatched emoji/unicode icon glyphs (▤, 🔊, 🔇, 🔔, ⟳, ⚙) with one consistent custom inline-SVG icon set, give the icon buttons a shared rounded hover background, and keep the mute icon's on/off swap working via CSS instead of `textContent`.

**Architecture:** Pure HTML/CSS/JS change across `renderer/index.html`, `renderer/styles.css`, and `renderer/app.js`. Icons are hand-authored inline `<svg>` markup (no dependency, no build step). The mute button holds both volume-on and volume-off SVGs at all times; CSS shows exactly one based on the existing `.muted` class, so the two `app.js` lines that used to set `textContent` are simply deleted.

**Tech Stack:** Plain HTML/CSS/JS (Electron renderer, no framework, no build step).

## Global Constraints

- No control's `id`, `title` tooltip, or position changes (per spec Non-goals).
- No icon library, icon font, or build tooling introduced (per spec Goals).
- Nav tabs (VCP/PLM/CMC/LB/Dashboard/Canvas) and status chips are untouched — their emoji stay (per spec Non-goals).
- `#notify-badge`/`#notify-dropdown` behavior is unchanged — only the bell button's glyph changes (per spec Non-goals).
- Work happens in the `in-app-notifications` worktree at `/Users/pc-63/Desktop/HiggTable/.claude/worktrees/in-app-notifications` — all paths below are relative to that directory.

---

### Task 1: Swap header icons for custom SVGs, add hover chrome, drop textContent mute-swap

**Files:**
- Modify: `renderer/index.html:20-35` (the `#header-actions` block)
- Modify: `renderer/styles.css` (header icon section, currently spanning the `/* ── Header ── */` comment through `#notify-badge { ... }`)
- Modify: `renderer/app.js:494-499` (`toggleMute()`) and `renderer/app.js:1953-1956` (cold-start mute restore)

**Interfaces:**
- Consumes: nothing (first and only task).
- Produces: final state — no later task depends on this.

- [ ] **Step 1: Replace the `#header-actions` markup in `renderer/index.html`**

Replace the current block:

```html
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
```

with:

```html
      <div id="header-actions">
        <button id="columns-btn" title="Choose which columns to show">
          <svg class="icon-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="1.5" y="2.5" width="3.4" height="11" rx="1"/>
            <rect x="6.3" y="2.5" width="3.4" height="11" rx="1"/>
            <rect x="11.1" y="2.5" width="3.4" height="11" rx="1"/>
          </svg>
          <span>Columns</span>
        </button>
        <div id="notifications-control">
          <button id="notify-mute-btn" title="Mute notification sound">
            <svg class="icon-svg icon-volume-on" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2.5 6.3h1.9L7.8 3.6v8.8L4.4 9.7H2.5z"/>
              <path d="M10.4 6.4a2.7 2.7 0 0 1 0 3.2"/>
              <path d="M12.1 4.9a5 5 0 0 1 0 6.2"/>
            </svg>
            <svg class="icon-svg icon-volume-off" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2.5 6.3h1.9L7.8 3.6v8.8L4.4 9.7H2.5z"/>
              <path d="M10.6 6.6l3 3"/>
              <path d="M13.6 6.6l-3 3"/>
            </svg>
          </button>
          <button id="notify-bell-btn" title="Notifications">
            <svg class="icon-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 2.25a1 1 0 0 1 1 1v.3c1.7.42 3 2.02 3 3.95v2.05c0 .8.32 1.56.9 2.13l.35.35H2.75l.35-.35c.58-.57.9-1.34.9-2.13V7.5c0-1.93 1.3-3.53 3-3.95v-.3a1 1 0 0 1 1-1z"/>
              <path d="M6.4 13.1a1.6 1.6 0 0 0 3.2 0"/>
            </svg>
            <span id="notify-badge" class="hidden">0</span>
          </button>
          <div id="notify-dropdown" class="hidden">
            <div id="notify-dropdown-empty">No notifications yet</div>
            <div id="notify-dropdown-list"></div>
          </div>
        </div>
        <button id="refresh-btn" title="Refresh current table">
          <svg class="icon-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 8a5 5 0 0 1 8.5-3.5"/>
            <path d="M13 8a5 5 0 0 1-8.5 3.5"/>
            <path d="M11.5 2.5v2.3h-2.3"/>
            <path d="M4.5 13.5v-2.3h2.3"/>
          </svg>
        </button>
        <button id="settings-btn" title="Settings">
          <svg class="icon-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="2.2"/>
            <path d="M8 1.8v2M8 12.2v2M14.2 8h-2M3.8 8h-2M12.4 3.6l-1.4 1.4M4.9 11.1l-1.4 1.4M12.4 12.4l-1.4-1.4M4.9 4.9L3.5 3.5"/>
          </svg>
        </button>
      </div>
```

`#notify-badge` keeps the same `id`/`class="hidden"` — `renderer/app.js`'s badge-count logic (`document.getElementById('notify-badge')`) needs no change. `#notify-dropdown` and its children are untouched.

- [ ] **Step 2: Replace the header icon CSS in `renderer/styles.css`**

Find the header section — it currently runs from the `/* ── Header ── */` comment down through the `#notify-badge { ... }` rule (the `#header-top`/`#header-filters`/`.tab`/`.status-chip`/`#des-control` rules from the two-row-layout task, followed by the `#columns-btn`/`#settings-btn, #refresh-btn`/`#notify-mute-btn, #notify-bell-btn`/`#notify-badge` icon rules). Replace that entire section with:

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
#des-control { display: flex; align-items: center; gap: var(--space-3); font-size: 11px; color: var(--text-secondary); }
#multiselect-hint { font-size: 10px; color: var(--text-muted); cursor: default; user-select: none; }
#des-select { background: var(--bg-surface-2); border: 1px solid var(--border-strong); color: var(--text-primary); padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); font-size: 11px; cursor: pointer; }
.icon-svg { width: 16px; height: 16px; display: block; }
#columns-btn { display: inline-flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-3); font-size: 11px; }
#notify-mute-btn, #notify-bell-btn, #refresh-btn, #settings-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; background: none; border: none; border-radius: var(--radius-sm); color: var(--text-muted); cursor: pointer; position: relative; transition: background-color 0.15s, color 0.15s; }
#notify-mute-btn:hover, #notify-bell-btn:hover, #refresh-btn:hover, #settings-btn:hover { background: var(--bg-surface-2); color: var(--text-primary); }
#refresh-btn:disabled { color: var(--border-strong); cursor: default; }
#refresh-btn.spinning { animation: refresh-spin 0.8s linear infinite; }
@keyframes refresh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

#notifications-control { position: relative; display: flex; align-items: center; gap: var(--space-1); }
#notify-mute-btn.muted { opacity: 0.4; }
#notify-mute-btn .icon-volume-off { display: none; }
#notify-mute-btn.muted .icon-volume-on { display: none; }
#notify-mute-btn.muted .icon-volume-off { display: block; }
#notify-badge { position: absolute; top: -2px; right: -2px; background: var(--accent); color: #0a0a0a; font-size: 9px; font-weight: 700; line-height: 1; padding: 2px 4px; border-radius: 999px; min-width: 14px; text-align: center; }
```

This: (a) bumps `#des-control`'s gap from `var(--space-2)` to `var(--space-3)` to match `#header-actions`'s gap — the row-rhythm tightening from the spec; (b) adds `.icon-svg` sizing; (c) gives `#columns-btn` flex layout for its icon+label; (d) merges the old separate `#settings-btn, #refresh-btn` and `#notify-mute-btn, #notify-bell-btn` rules into one 28×28 hover-background rule covering all four bare-icon buttons; (e) adds the volume-on/off visibility toggle driven by `.muted`.

- [ ] **Step 3: Remove the `textContent` mute-icon swaps in `renderer/app.js`**

In `toggleMute()` (around line 494), change:

```javascript
function toggleMute() {
  const next = !isNotificationsMuted();
  localStorage.setItem(MUTE_KEY, String(next));
  document.getElementById('notify-mute-btn').classList.toggle('muted', next);
  document.getElementById('notify-mute-btn').textContent = next ? '🔇' : '🔊';
}
```

to:

```javascript
function toggleMute() {
  const next = !isNotificationsMuted();
  localStorage.setItem(MUTE_KEY, String(next));
  document.getElementById('notify-mute-btn').classList.toggle('muted', next);
}
```

In the cold-start mute-restore block (around line 1953), change:

```javascript
if (isNotificationsMuted()) {
  document.getElementById('notify-mute-btn').classList.add('muted');
  document.getElementById('notify-mute-btn').textContent = '🔇';
}
```

to:

```javascript
if (isNotificationsMuted()) {
  document.getElementById('notify-mute-btn').classList.add('muted');
}
```

The `.muted` class toggle in both spots is unchanged — only the `textContent` line is deleted in each. CSS (Step 2) now solely controls which volume icon shows.

- [ ] **Step 4: Visually verify in the browser**

Load `file:///Users/pc-63/Desktop/HiggTable/.claude/worktrees/in-app-notifications/renderer/index.html` in a fresh browser tab (a previously-used tab may serve a cached copy of `styles.css` — open a new tab if anything looks stale) at a wide viewport (e.g. 1400×800).

Expected:
- All six icons (Columns, mute/volume, bell, refresh, settings) render as monochrome line icons of matching size and weight — no colorful emoji left.
- Hovering over the bare-icon buttons (mute, bell, refresh, settings) shows a soft rounded rectangular background; `#columns-btn` keeps its existing bordered-pill look with the icon inline before the "Columns" label.
- Run this in the browser's JS console (or via the automation tool's JS-eval) to confirm the mute toggle still swaps icons correctly:
  ```js
  const btn = document.getElementById('notify-mute-btn');
  btn.click(); // simulate toggling — should flip .muted class
  getComputedStyle(btn.querySelector('.icon-volume-on')).display // 'none' when muted
  getComputedStyle(btn.querySelector('.icon-volume-off')).display // 'block' when muted
  ```
  Expected: exactly one of the two is `'none'` and the other is `'block'`, and clicking again flips them back.

- [ ] **Step 5: Run the existing test suite**

Run: `npm test`
Expected: PASS (28/28, same as before — no test in `tests/` touches header DOM or the mute button).

- [ ] **Step 6: Commit**

```bash
cd /Users/pc-63/Desktop/HiggTable/.claude/worktrees/in-app-notifications
git add renderer/index.html renderer/styles.css renderer/app.js
git commit -m "Replace header icon glyphs with a consistent custom SVG icon set"
```
