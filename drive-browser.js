// drive-browser.js  (main process)
// Owns a persistent-session BrowserWindow logged into Google Drive, and the
// navigation primitives that need no DOM knowledge. Every DOM assumption lives
// in drive-probes.js instead, so a Google UI change has exactly one place to be
// repaired.
//
// The user logs in manually, in Google's real login page. This module never
// reads, stores, types, or transmits credentials.

const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { PROBES, PREFLIGHT_PROBES } = require('./drive-probes');

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

// Waits for the current navigation to settle. Uses did-stop-loading rather than
// a fixed sleep so slow loads aren't truncated.
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

// Drive is a single-page app: did-stop-loading fires before the file listing is
// rendered. Poll for a selector instead of guessing with a fixed sleep.
async function waitForSelector(win, selector, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await win.webContents.executeJavaScript(
      `!!document.querySelector(${JSON.stringify(selector)})`
    ).catch(() => false);
    if (found) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

// Login state is determined from the settled URL, not the DOM: Google redirects
// unauthenticated requests to accounts.google.com. That keeps this check immune
// to UI changes.
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

// Runs `fn` with the CDP debugger attached, always detaching afterwards so a
// failure can't leave it attached and block later runs.
async function withDebugger(win, fn) {
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  try {
    return await fn(dbg);
  } finally {
    if (dbg.isAttached()) dbg.detach();
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Clicks a control by visible text or aria-label. Two things the naive version
// got wrong: there are several buttons reading "New" (some hidden), so this
// filters to visible elements; and Google's UI reacts to pointer/mouse events
// rather than a bare element.click(), so this dispatches the full sequence.
function clickByTextScript(label) {
  return `(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const want = ${JSON.stringify(label)};
    const all = [...document.querySelectorAll('[role=button],button,[role=menuitem],[role=option]')];
    const visible = all.filter(e => {
      const r = e.getBoundingClientRect();
      return e.offsetParent !== null && r.width > 0 && r.height > 0;
    });
    const pick = visible.find(e => norm(e.innerText) === want)
              || visible.find(e => norm(e.getAttribute('aria-label')) === want)
              || visible.find(e => norm(e.innerText).startsWith(want))
              || visible.find(e => norm(e.getAttribute('aria-label')).startsWith(want));
    if (!pick) {
      return { clicked: false, visibleCandidates: visible.length,
               sample: visible.slice(0, 12).map(e => norm(e.innerText).slice(0, 30) || norm(e.getAttribute('aria-label')).slice(0, 30)) };
    }
    const r = pick.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    pick.dispatchEvent(new PointerEvent('pointerdown', o));
    pick.dispatchEvent(new MouseEvent('mousedown', o));
    pick.dispatchEvent(new PointerEvent('pointerup', o));
    pick.dispatchEvent(new MouseEvent('mouseup', o));
    pick.dispatchEvent(new MouseEvent('click', o));
    return { clicked: true, tag: pick.tagName,
             text: norm(pick.innerText).slice(0, 40),
             ariaLabel: norm(pick.getAttribute('aria-label')).slice(0, 40) };
  })()`;
}

// Dumps only VISIBLE menu items. The first attempt dumped every [role=menuitem]
// in the DOM and picked up a hidden Help menu, which looked like the New menu
// had opened when it hadn't.
const DUMP_MENU_SCRIPT = `(() => {
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const items = [...document.querySelectorAll('[role=menuitem],[role=option]')].filter(e => {
    const r = e.getBoundingClientRect();
    return e.offsetParent !== null && r.width > 0 && r.height > 0;
  });
  return items.slice(0, 25).map(e => ({
    text: norm(e.innerText).slice(0, 40),
    aria: norm(e.getAttribute('aria-label')).slice(0, 40),
    role: e.getAttribute('role'),
  }));
})()`;

// Lists every control matching a label, with visibility, so we can tell which
// of the duplicate "New" buttons is the real one.
function describeCandidatesScript(label) {
  return `(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const want = ${JSON.stringify(label)};
    return [...document.querySelectorAll('[role=button],button')]
      .filter(e => norm(e.innerText).startsWith(want) || norm(e.getAttribute('aria-label')).startsWith(want))
      .slice(0, 8)
      .map(e => {
        const r = e.getBoundingClientRect();
        return { tag: e.tagName, text: norm(e.innerText).slice(0, 30),
                 aria: norm(e.getAttribute('aria-label')).slice(0, 30),
                 visible: e.offsetParent !== null && r.width > 0 && r.height > 0,
                 w: Math.round(r.width), h: Math.round(r.height) };
      });
  })()`;
}

// Samples the several ways Drive might expose a child item's identity. The
// first diagnostic only looked at [data-id] and found nothing usable, so this
// casts a wider net — run it against a folder WITH contents.
const ROW_SAMPLE_SCRIPT = '(() => {' +
  'const desc = (el) => ({' +
  '  tag: el.tagName, role: el.getAttribute("role"),' +
  '  ariaLabel: (el.getAttribute("aria-label") || "").slice(0, 60),' +
  '  dataId: el.getAttribute("data-id"), dataTarget: el.getAttribute("data-target"),' +
  '  href: el.getAttribute("href"),' +
  '  text: (el.innerText || "").trim().slice(0, 50)' +
  '});' +
  'const take = (sel, n) => [...document.querySelectorAll(sel)].slice(0, n).map(desc);' +
  'return {' +
  '  counts: {' +
  '    roleRow: document.querySelectorAll("[role=row]").length,' +
  '    gridcell: document.querySelectorAll("[role=gridcell]").length,' +
  '    listitem: document.querySelectorAll("[role=listitem]").length,' +
  '    folderLinks: document.querySelectorAll(\'a[href*="/folders/"]\').length,' +
  '    fileLinks: document.querySelectorAll(\'a[href*="/file/d/"]\').length,' +
  '    dataTarget: document.querySelectorAll("[data-target]").length,' +
  '    dataId: document.querySelectorAll("[data-id]").length' +
  '  },' +
  '  roleRow: take("[role=row]", 5),' +
  '  listitem: take("[role=listitem]", 5),' +
  '  folderLinks: take(\'a[href*="/folders/"]\', 5),' +
  '  fileLinks: take(\'a[href*="/file/d/"]\', 5),' +
  '  dataTarget: take("[data-target]", 5)' +
  '};' +
'})()';

// Reports what the live Drive DOM actually contains, so probes can be written
// from evidence instead of guesswork. Returns counts and small samples only —
// never file contents.
//
// opts.probeUpload: additionally clicks New -> File upload with the file
// chooser INTERCEPTED, to learn whether Chromium hands us a backendNodeId we
// can feed to DOM.setFileInputFiles. Nothing is ever uploaded: the chooser is
// cancelled and no files are supplied.
async function diagnose(folderId, opts = {}) {
  const login = await ensureLoggedIn();
  if (!login.loggedIn) return { loggedIn: false, url: login.url };

  const nav = folderId ? await navigateToFolder(folderId) : { url: login.url, folderId: null };
  const win = getDriveWindow({ show: false });

  // Drive is an SPA: did-stop-loading fires before the listing renders.
  await waitForSelector(win, '[role=main]', 15000);
  await sleep(1500);

  const report = await win.webContents.executeJavaScript(`(() => {
    const sample = (list, n) => Array.prototype.slice.call(list, 0, n);
    const desc = (el) => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      dataId: el.getAttribute('data-id'),
      text: (el.innerText || '').trim().slice(0, 60),
    });
    const fileInputs = document.querySelectorAll('input[type=file]');
    const buttons = document.querySelectorAll('[role=button],button');
    const newBtns = Array.prototype.filter.call(buttons, b => {
      const s = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).toLowerCase();
      return s.includes('new') || s.includes('folder');
    });
    return {
      title: document.title,
      href: location.href,
      counts: {
        fileInputs: fileInputs.length,
        buttons: buttons.length,
        newButtonCandidates: newBtns.length,
      },
      newButtonSamples: newBtns.slice(0, 5).map(desc),
    };
  })()`);

  const rows = await win.webContents.executeJavaScript(ROW_SAMPLE_SCRIPT);

  let uploadProbe = null;
  if (opts.probeUpload) {
    // Show and focus the window: keyboard input needs focus, and it lets the
    // user watch what the automation is doing.
    win.show();
    win.focus();
    win.webContents.focus();
    await sleep(600);

    uploadProbe = await withDebugger(win, async (dbg) => {
      const seenEvents = [];
      let chooser = null;
      const onMessage = (_e, method, params) => {
        seenEvents.push(method);
        if (method === 'Page.fileChooserOpened') chooser = params;
      };
      dbg.on('message', onMessage);

      const pressKey = (keyCode) => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        win.webContents.sendInputEvent({ type: 'char', keyCode });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      };

      try {
        await dbg.sendCommand('Page.enable');
        await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });

        // ATTEMPT 1 — Drive's own chord shortcut ("File upload: c then u"),
        // sent as real input events through Chromium rather than synthetic
        // DOM events, which the menu item ignored.
        await win.webContents.executeJavaScript(
          'document.activeElement && document.activeElement.blur(), document.body.click(), true'
        ).catch(() => {});
        await sleep(400);
        pressKey('c');
        await sleep(250);
        pressKey('u');
        await sleep(3000);
        const viaKeyboard = !!chooser;

        // ATTEMPT 2 — open the New menu, then click "File upload" with a REAL
        // mouse event at its coordinates (not a synthetic DOM click).
        let viaMouse = false;
        let mouseTarget = null;
        if (!chooser) {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
          await sleep(500);
          await win.webContents.executeJavaScript(clickByTextScript('New'));
          await sleep(1500);
          mouseTarget = await win.webContents.executeJavaScript(`(() => {
            const norm = s => (s || '').replace(/\s+/g, ' ').trim();
            const it = [...document.querySelectorAll('[role=menuitem]')].find(e => {
              const r = e.getBoundingClientRect();
              return e.offsetParent !== null && r.width > 0 && norm(e.innerText).startsWith('File upload');
            });
            if (!it) return null;
            const r = it.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                     text: norm(it.innerText).slice(0, 30) };
          })()`);
          if (mouseTarget) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x: mouseTarget.x, y: mouseTarget.y });
            await sleep(150);
            win.webContents.sendInputEvent({ type: 'mouseDown', x: mouseTarget.x, y: mouseTarget.y, button: 'left', clickCount: 1 });
            win.webContents.sendInputEvent({ type: 'mouseUp', x: mouseTarget.x, y: mouseTarget.y, button: 'left', clickCount: 1 });
            await sleep(3000);
            viaMouse = !!chooser && !viaKeyboard;
          }
        }

        return {
          viaKeyboard,
          viaMouse,
          mouseTarget,
          fileChooserIntercepted: !!chooser,
          fileChooserEvent: chooser,
          cdpEventsSeen: [...new Set(seenEvents)].slice(0, 25),
        };
      } finally {
        dbg.removeListener('message', onMessage);
        try { await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }); } catch (e) { /* best effort */ }
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        win.hide();
      }
    });
  }

  // Probes the New folder dialog: opens it, records its input/buttons, then
  // cancels with Escape. Nothing is created.
  let newFolderProbe = null;
  if (opts.probeNewFolder) {
    win.show();
    win.focus();
    win.webContents.focus();
    await sleep(600);
    try {
      await win.webContents.executeJavaScript(clickByTextScript('New'));
      await sleep(1500);
      const target = await win.webContents.executeJavaScript(`(() => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim();
        const it = [...document.querySelectorAll('[role=menuitem]')].find(e => {
          const r = e.getBoundingClientRect();
          return e.offsetParent !== null && r.width > 0 && norm(e.innerText).startsWith('New folder');
        });
        if (!it) return null;
        const r = it.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      if (target) {
        // Menu items need REAL input events; synthetic DOM clicks don't activate them.
        win.webContents.sendInputEvent({ type: 'mouseMove', x: target.x, y: target.y });
        await sleep(150);
        win.webContents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 });
        await sleep(2000);
      }
      newFolderProbe = await win.webContents.executeJavaScript(`(() => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim();
        const vis = e => { const r = e.getBoundingClientRect(); return e.offsetParent !== null && r.width > 0 && r.height > 0; };
        const inputs = [...document.querySelectorAll('input,textarea')].filter(vis).map(e => ({
          tag: e.tagName, type: e.type, value: e.value, ariaLabel: norm(e.getAttribute('aria-label')).slice(0, 40),
          placeholder: e.placeholder, id: e.id, className: (e.className || '').slice(0, 60),
        }));
        const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(vis).map(e => ({
          role: e.getAttribute('role'), ariaLabel: norm(e.getAttribute('aria-label')).slice(0, 40),
          text: norm(e.innerText).slice(0, 120),
        }));
        const buttons = [...document.querySelectorAll('[role=dialog] button,[role=dialog] [role=button]')].filter(vis)
          .map(e => norm(e.innerText).slice(0, 25));
        return { menuOpened: ${target ? 'true' : 'false'}, inputs, dialogs, dialogButtons: buttons };
      })()`);
    } finally {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await sleep(300);
      win.hide();
    }
  }

  return { loggedIn: true, navigatedTo: nav, report, rows, uploadProbe, newFolderProbe };
}


// ── Operations ──────────────────────────────────────────────────────────
// Interaction rules learned from the 2026-08-19 diagnostics:
//   * A synthetic pointer sequence DOES open the New menu.
//   * A synthetic click does NOT activate a menu item — only real
//     sendInputEvent mouse events at the element's coordinates do.
//   * There is no <input type=file> in the DOM; uploads work by intercepting
//     the file chooser and handing Chromium file PATHS (no size limit).

// Real mouse click through Chromium's input pipeline, at an element's centre.
async function realClickAt(win, point) {
  win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  await sleep(120);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

// Centre coordinates of the first VISIBLE element matching a probe's text.
function locateByTextScript(text, selector) {
  return `(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => {
      const r = e.getBoundingClientRect();
      return e.offsetParent !== null && r.width > 0 && r.height > 0 &&
             norm(e.innerText).startsWith(${JSON.stringify(text)});
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;
}

// Verifies the probes that must exist on a loaded folder page, BEFORE any file
// is uploaded. Turns "the automation broke and silently delivered nothing" into
// "the automation broke and named the probe".
async function preflight() {
  const win = getDriveWindow({ show: false });
  const failures = [];
  for (const key of PREFLIGHT_PROBES) {
    const ok = await win.webContents.executeJavaScript(
      `!!document.querySelector(${JSON.stringify(PROBES[key].selector)})`
    ).catch(() => false);
    if (!ok) failures.push(key);
  }
  const newBtn = await win.webContents.executeJavaScript(
    locateByTextScript(PROBES.newButton.text, '[role=button],button')
  );
  if (!newBtn) failures.push('newButton');
  return { ok: failures.length === 0, failures };
}

// Lists the children of the currently-open folder view.
const LIST_ITEMS_SCRIPT = `(() => {
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  return [...document.querySelectorAll(${JSON.stringify(PROBES.itemRow.selector)})].map(el => {
    const aria = el.getAttribute('aria-label') || '';
    return {
      id: el.getAttribute(${JSON.stringify(PROBES.itemRow.idAttribute)}),
      name: (el.innerText || '').split('\n')[0].trim(),
      isFolder: aria.endsWith(${JSON.stringify(PROBES.itemRow.folderAriaLabelSuffix)}),
    };
  }).filter(i => i.id && i.name);
})()`;

async function listFolderItems(folderId) {
  await navigateToFolder(folderId);
  const win = getDriveWindow({ show: false });
  await waitForSelector(win, PROBES.mainRegion.selector, 15000);
  await sleep(1500);
  return win.webContents.executeJavaScript(LIST_ITEMS_SCRIPT);
}

async function listFolderFileNames(folderId) {
  const items = await listFolderItems(folderId);
  return items.filter(i => !i.isFolder).map(i => i.name);
}

// Finds direct child folders by EXACT name. Returns EVERY match so the caller
// can abort on duplicates instead of creating yet another one. Exact match
// only: a prefix match would conflate "08_August" with "08_August_old".
async function findChildFoldersByName(parentId, name) {
  const items = await listFolderItems(parentId);
  return items.filter(i => i.isFolder && i.name === name).map(i => i.id);
}

// Creates a folder via New -> New folder -> type -> Create. Returns nothing
// useful on its own; findOrCreateFolder reads the id back from a fresh listing.
async function createFolder(parentId, name) {
  await navigateToFolder(parentId);
  const win = getDriveWindow({ show: true });
  win.focus();
  win.webContents.focus();
  await waitForSelector(win, PROBES.mainRegion.selector, 15000);
  await sleep(1200);

  const newBtn = await win.webContents.executeJavaScript(
    locateByTextScript(PROBES.newButton.text, '[role=button],button')
  );
  if (!newBtn) throw new Error('could not find the New button — run driveDiagnose and update drive-probes.js');
  await realClickAt(win, newBtn);
  await sleep(1500);

  const item = await win.webContents.executeJavaScript(
    locateByTextScript(PROBES.menuItemNewFolder.text, '[role=menuitem]')
  );
  if (!item) throw new Error('could not find the "New folder" menu item — run driveDiagnose and update drive-probes.js');
  await realClickAt(win, item);
  await sleep(1800);

  const hasInput = await waitForSelector(win, PROBES.folderNameInput.selector, 10000);
  if (!hasInput) throw new Error('New folder dialog did not appear — run driveDiagnose and update drive-probes.js');

  // The field is pre-filled with "Untitled folder": focus, select all, then
  // type real characters so the framework registers the change.
  await win.webContents.executeJavaScript(
    `(() => { const i = document.querySelector(${JSON.stringify(PROBES.folderNameInput.selector)}); i.focus(); i.select(); return true; })()`
  );
  await sleep(200);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: ['cmd'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: ['cmd'] });
  await sleep(150);
  for (const ch of name) {
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
  }
  await sleep(400);

  const typed = await win.webContents.executeJavaScript(
    `(() => { const i = document.querySelector(${JSON.stringify(PROBES.folderNameInput.selector)}); return i ? i.value : null; })()`
  );
  if (typed !== name) {
    throw new Error(`folder name field reads "${typed}" but should be "${name}" — refusing to create a wrongly-named folder`);
  }

  const createBtn = await win.webContents.executeJavaScript(
    locateByTextScript(PROBES.createButton.text, '[role=dialog] button,[role=dialog] [role=button]')
  );
  if (!createBtn) throw new Error('could not find the Create button — run driveDiagnose and update drive-probes.js');
  await realClickAt(win, createBtn);
  await sleep(2500);
  win.hide();
}

// Find-or-create with the duplicate guard. The ONLY sanctioned way to obtain a
// month or task folder id.
async function findOrCreateFolder(parentId, name) {
  const existing = await findChildFoldersByName(parentId, name);
  if (existing.length === 1) return existing[0];
  if (existing.length > 1) {
    throw new Error(`Drive already has ${existing.length} folders named "${name}" in this parent. Resolve that by hand — refusing to add another.`);
  }
  await createFolder(parentId, name);
  const after = await findChildFoldersByName(parentId, name);
  if (after.length !== 1) {
    throw new Error(`Created "${name}" but read back ${after.length} matches — aborting before upload to avoid duplicating files.`);
  }
  return after[0];
}

// Uploads by intercepting Drive's file chooser and handing Chromium the file
// PATHS. Chromium streams from disk, so there is no size ceiling — which is
// what makes .aep project files deliverable.
async function uploadFiles(folderId, filePaths) {
  await navigateToFolder(folderId);
  const win = getDriveWindow({ show: true });
  win.focus();
  win.webContents.focus();
  await waitForSelector(win, PROBES.mainRegion.selector, 15000);
  await sleep(1200);

  return withDebugger(win, async (dbg) => {
    let chooser = null;
    const onMessage = (_e, method, params) => {
      if (method === 'Page.fileChooserOpened') chooser = params;
    };
    dbg.on('message', onMessage);
    try {
      await dbg.sendCommand('Page.enable');
      await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });

      const newBtn = await win.webContents.executeJavaScript(
        locateByTextScript(PROBES.newButton.text, '[role=button],button')
      );
      if (!newBtn) throw new Error('could not find the New button — run driveDiagnose and update drive-probes.js');
      await realClickAt(win, newBtn);
      await sleep(1500);

      const item = await win.webContents.executeJavaScript(
        locateByTextScript(PROBES.menuItemFileUpload.text, '[role=menuitem]')
      );
      if (!item) throw new Error('could not find the "File upload" menu item — run driveDiagnose and update drive-probes.js');
      await realClickAt(win, item);

      // Wait for the intercepted chooser rather than guessing with a sleep.
      const deadline = Date.now() + 15000;
      while (!chooser && Date.now() < deadline) await sleep(300);
      if (!chooser) {
        throw new Error('file chooser never opened — nothing was uploaded. Run driveDiagnose with { probeUpload: true }.');
      }

      await dbg.sendCommand('DOM.setFileInputFiles', {
        files: filePaths,
        backendNodeId: chooser.backendNodeId,
      });

      return { strategy: 'fileChooser', mode: chooser.mode, uploaded: filePaths.map(p => path.basename(p)) };
    } finally {
      dbg.removeListener('message', onMessage);
      try { await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }); } catch (e) { /* best effort */ }
    }
  });
}

// Resolves the destination, uploads, and verifies. NEVER writes to Airtable —
// the caller decides that, and only when `missing` is empty.
async function deliver({ appFolderId, monthName, taskName, filePaths }) {
  if (!appFolderId) throw new Error('no Drive folder configured for this app code');
  if (!monthName || !taskName) throw new Error('missing month or task folder name');
  if (!Array.isArray(filePaths) || !filePaths.length) throw new Error('no files to upload');

  const login = await ensureLoggedIn();
  if (!login.loggedIn) throw new Error('not signed in to Google — sign in the Drive window, then retry');

  // The <App>_creatives folder must already exist; a typo-created sibling would
  // silently split a client's deliverables, so never create at this level.
  const appNav = await navigateToFolder(appFolderId);
  if (appNav.folderId !== appFolderId) {
    throw new Error(`configured app folder ${appFolderId} is not reachable — check the Settings URL`);
  }

  const pre = await preflight();
  if (!pre.ok) {
    throw new Error(`Drive UI has changed; aborted before uploading. Failing probes: ${pre.failures.join(', ')}. Run driveDiagnose and update drive-probes.js`);
  }

  const warnings = [];
  const monthId = await findOrCreateFolder(appFolderId, monthName);
  const taskId = await findOrCreateFolder(monthId, taskName);

  const existing = await listFolderFileNames(taskId);
  const clashes = filePaths.map(p => path.basename(p)).filter(n => existing.includes(n));
  if (clashes.length) {
    warnings.push(`Drive already has these files and will create duplicates rather than replace them: ${clashes.join(', ')}`);
  }

  await uploadFiles(taskId, filePaths);

  // Verification gate: reload fresh and confirm every expected name arrived.
  // Uploads are async, so poll rather than checking once.
  const expected = filePaths.map(p => path.basename(p));
  let missing = expected.slice();
  const deadline = Date.now() + 120000;
  while (missing.length && Date.now() < deadline) {
    await sleep(4000);
    const present = await listFolderFileNames(taskId);
    missing = expected.filter(n => !present.includes(n));
  }

  const nav = await navigateToFolder(taskId);
  getDriveWindow({ show: false }).hide();
  return { folderUrl: nav.url, folderId: taskId, missing, warnings };
}

module.exports = {
  getDriveWindow,
  waitForLoad,
  waitForSelector,
  ensureLoggedIn,
  navigateToFolder,
  diagnose,
  withDebugger,
  preflight,
  listFolderItems,
  listFolderFileNames,
  findChildFoldersByName,
  findOrCreateFolder,
  createFolder,
  uploadFiles,
  deliver,
  PARTITION,
};
