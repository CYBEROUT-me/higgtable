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
// Pure matching helpers, shared with the renderer. Dependency-free, so the main
// process can require them directly.
const {
  matchTasksToFolders, monthSearchOrder, classifyPeriodFolders, yearSearchOrder,
} = require('./renderer/drive-link');

const PARTITION = 'persist:gdrive';
const DRIVE_ROOT = 'https://drive.google.com/drive/my-drive';

let driveWin = null;

// Progress logging. main.js injects its logger so each step lands in
// higgtable.log — without this a slow run is indistinguishable from a hung one.
let logFn = () => {};
function setLogger(fn) { logFn = typeof fn === 'function' ? fn : () => {}; }

// Only one Drive operation may run at a time: they all drive the SAME
// BrowserWindow, so a second concurrent call navigates out from under the
// first and both fail in confusing ways.
let inFlight = null;

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
      // Chromium throttles timers and suspends rendering in hidden or occluded
      // windows. Drive's grid then never populates, so listings read empty and
      // uploads appear to stall whenever this window is not in front — which is
      // most of a bulk run. Without this the automation only works while the
      // user keeps the window visible.
      backgroundThrottling: false,
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
async function ensureLoggedIn({ trustCurrentPage = false } = {}) {
  const win = getDriveWindow({ show: false });
  const current = win.webContents.getURL();
  // Loading My Drive purely to prove we are signed in cost a full page load per
  // task AND moved the window off the folder the caller was about to use, so
  // the next step had to navigate back. Already sitting on a drive.google.com
  // page is proof enough, by the same redirect logic used below. If the session
  // does expire mid-run, the next folder navigation redirects away and
  // openFolderForWork reports it.
  if (trustCurrentPage && current.startsWith('https://drive.google.com/') && !win.webContents.isLoading()) {
    return { loggedIn: true, url: current };
  }
  await loadAndWait(win, DRIVE_ROOT);
  const url = win.webContents.getURL();
  const loggedIn = url.startsWith('https://drive.google.com/');
  if (!loggedIn) win.show(); // surface the real Google login page for the user
  return { loggedIn, url };
}

// loadURL() already returns a promise that settles when the navigation
// completes. The old code fired loadURL and THEN attached a did-stop-loading
// listener, so a load that finished in between was missed and the wait hung
// forever — which is exactly what happened when re-loading the current URL.
// loadURL's promise can simply never settle when Drive stalls mid-load, and an
// unbounded await there hung a whole run with nothing in the log — a blank
// window and no error. Every navigation gets a hard ceiling.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function loadAndWait(win, url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await withTimeout(win.webContents.loadURL(url), 45000, `loading ${url}`);
      return;
    } catch (err) {
      const msg = String(err && err.message);
      // Normal when a navigation is superseded or same-document.
      if (msg.includes('ERR_ABORTED')) return;
      // ERR_FAILED is usually a cancelled/raced load; retry once before giving up.
      if (attempt === 2) throw err;
      logFn(`loadAndWait: ${msg} — retrying once`);
      try { win.webContents.stop(); } catch (e) { /* best effort */ }
      await sleep(1500);
    }
  }
}

async function navigateToFolder(folderId, { force = false } = {}) {
  const win = getDriveWindow({ show: false });
  const current = win.webContents.getURL();
  // Already there and idle: skip the reload. Callers that need FRESH content
  // (e.g. reading back a folder just created) must pass { force: true }, or
  // they'd re-read the stale listing rendered before the change.
  if (!force && current.includes(`/folders/${folderId}`) && !win.webContents.isLoading()) {
    return { url: current, folderId };
  }
  await loadAndWait(win, `https://drive.google.com/drive/folders/${folderId}`);
  const url = win.webContents.getURL();
  const m = url.match(/\/folders\/([A-Za-z0-9_-]+)/);
  return { url, folderId: m ? m[1] : null };
}

// Opens a folder and waits for it to actually render. Drive intermittently
// serves a blank page — the title updates but nothing else does — so a single
// attempt is not enough to conclude the folder is unusable.
async function openFolderForWork(folderId, { force = false } = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Not forced on the first attempt: Drive updates its listing live — the
    // post-upload read-back relies on exactly that — so a window already
    // showing this folder is already current, and reloading it just burns a
    // full SPA load. The retry forces, since that is the blank-page recovery.
    const nav = await navigateToFolder(folderId, { force: force || attempt === 2 });
    const win = getDriveWindow();
    if (nav.url && !nav.url.startsWith('https://drive.google.com/')) {
      throw new Error(`Drive redirected to ${nav.url} — the Google session has expired; sign in again in the Drive window`);
    }
    try {
      await waitForSelector(win, PROBES.mainRegion.selector, 20000);
      return win;
    } catch (err) {
      if (attempt === 2) throw new Error(`Drive never rendered folder ${folderId} (blank page): ${err.message}`);
      logFn(`openFolderForWork: ${folderId} came up blank — reloading once`);
      try { win.webContents.stop(); } catch (e) { /* best effort */ }
      await sleep(2500);
    }
  }
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
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
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
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
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
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
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
            const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
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
        const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
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
        const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
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

  // Probes "Folder upload": whether the directory chooser is interceptable the
  // same way file upload is, and whether it accepts one or several folder paths.
  //
  // SAFE BY DEFAULT: with no opts.folderPaths it only reports the chooser mode
  // and cancels — nothing is uploaded. Passing folderPaths performs a REAL
  // upload into whatever folder is open, so point it at a scratch folder.
  let folderUploadProbe = null;
  if (opts.probeFolderUpload) {
    win.show();
    win.focus();
    win.webContents.focus();
    await sleep(600);

    folderUploadProbe = await withDebugger(win, async (dbg) => {
      const seenEvents = [];
      let chooser = null;
      const onMessage = (_e, method, params) => {
        seenEvents.push(method);
        if (method === 'Page.fileChooserOpened') chooser = params;
      };
      dbg.on('message', onMessage);
      try {
        await dbg.sendCommand('Page.enable');
        await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });

        await execJS(win, 'click:new', clickByTextScript(PROBES.newButton.text));
        await sleep(1500);
        const target = await execJS(win, 'locate:folderUpload',
          locateByTextScript('Folder upload', '[role=menuitem]'));
        if (!target) {
          return { error: 'could not find the "Folder upload" menu item', menuSeen: await execJS(win, 'dumpMenu', DUMP_MENU_SCRIPT) };
        }
        await realClickAt(win, target);

        const deadline = Date.now() + 15000;
        while (!chooser && Date.now() < deadline) await sleep(300);
        if (!chooser) {
          return { chooserIntercepted: false, cdpEventsSeen: [...new Set(seenEvents)] };
        }

        const result = {
          chooserIntercepted: true,
          mode: chooser.mode,                 // differs from file upload's "selectMultiple"
          backendNodeId: chooser.backendNodeId,
          cdpEventsSeen: [...new Set(seenEvents)],
        };

        // Optional live test: does setFileInputFiles accept directory paths,
        // and can it take more than one at a time?
        const paths = Array.isArray(opts.folderPaths) ? opts.folderPaths : [];
        if (paths.length) {
          try {
            await dbg.sendCommand('DOM.setFileInputFiles', {
              files: paths,
              backendNodeId: chooser.backendNodeId,
            });
            result.setFilesAccepted = true;
            result.pathsSent = paths.length;
          } catch (err) {
            result.setFilesAccepted = false;
            result.setFilesError = err.message;
          }
          await sleep(2500);
          // Drive asks for confirmation on folder uploads; capture its wording.
          result.dialogAfter = await execJS(win, 'dumpDialogs', `(() => {
            const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
            const vis = e => { const r = e.getBoundingClientRect(); return e.offsetParent !== null && r.width > 0; };
            return [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(vis).map(d => ({
              text: norm(d.innerText).slice(0, 200),
              buttons: [...d.querySelectorAll('button,[role=button]')].filter(vis).map(b => norm(b.innerText).slice(0, 25)),
            }));
          })()`).catch(e => ({ err: e.message }));
        }
        return result;
      } finally {
        dbg.removeListener('message', onMessage);
        try { await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }); } catch (e) { /* best effort */ }
        if (!Array.isArray(opts.folderPaths) || !opts.folderPaths.length) {
          // Nothing was uploaded — close any menu/dialog left open.
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
          win.hide();
        }
      }
    });
  }

  return { loggedIn: true, navigatedTo: nav, report, rows, uploadProbe, newFolderProbe, folderUploadProbe };
}


// Electron's executeJavaScript failure message ("Script failed to execute")
// names neither the script nor the cause, which makes debugging blind. Wrap
// each call with a label so a broken script identifies itself.
async function execJS(win, label, script) {
  try {
    return await win.webContents.executeJavaScript(script);
  } catch (err) {
    throw new Error(`page script "${label}" failed: ${err.message}`);
  }
}

// Snapshot of what the Drive page actually looks like right now. Used in error
// messages so a failure reports observed reality instead of leaving us guessing.
async function pageState(win) {
  const base = {
    url: win.webContents.getURL(),
    windowVisible: win.isVisible(),
    loading: win.webContents.isLoading(),
  };
  try {
    const dom = await win.webContents.executeJavaScript(`(() => ({
      title: document.title,
      main: document.querySelectorAll('[role=main]').length,
      gridcell: document.querySelectorAll('[role=gridcell]').length,
      gridcellWithId: document.querySelectorAll('[role=gridcell][data-id]').length,
      dataId: document.querySelectorAll('[data-id]').length,
      bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
    }))()`);
    return { ...base, ...dom };
  } catch (err) {
    return { ...base, domError: err.message };
  }
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
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
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
  return [...document.querySelectorAll(${JSON.stringify(PROBES.itemRow.selector)})].map(el => {
    const aria = (el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    const name = (el.innerText || '').split('\\n')[0].trim();
    // Drive labels items "<name> <TypeWord> [More info ...]". Strip the name and
    // read the type word. An endsWith(' Folder') test fails whenever "More info"
    // is appended, and a contains(' Folder') test would wrongly match a file
    // called "My Folder.png" — this handles both.
    const rest = aria.startsWith(name) ? aria.slice(name.length).trim() : aria;
    return {
      id: el.getAttribute(${JSON.stringify(PROBES.itemRow.idAttribute)}),
      name,
      isFolder: rest.startsWith('Folder'),
      aria,
    };
  }).filter(i => i.id && i.name);
})()`;

// Reading a Drive listing has two distinct hazards, and getting either wrong
// creates duplicate folders:
//   1. Drive paints the page shell — [role=main] included — well before the
//      file grid. A grid that has not rendered yet reads as ZERO rows, which
//      is indistinguishable from a genuinely empty folder. Believing that
//      zero is what made findOrCreateFolder create a second "08_August".
//   2. The grid streams rows in. A listing read mid-stream can be non-empty
//      yet still be missing the very folder being looked for.
// So: a non-empty listing is trusted only once two consecutive reads agree,
// and an empty listing is trusted only after a full patience window of
// nothing but empty reads. Waiting costs seconds; a wrong answer costs a
// duplicate folder and a failed run.
const LISTING_PATIENCE_MS = 30000;

// Reads the listing of the folder the window is ALREADY showing. Navigation is
// by far the expensive part of a Drive read, and Drive updates its listing
// live, so callers already on the right page should poll here rather than
// reload.
async function readListingHere(win, opts = {}) {
  const patienceMs = opts.patienceMs != null ? opts.patienceMs : LISTING_PATIENCE_MS;
  const deadline = Date.now() + patienceMs;
  let previous = null;
  let items = [];
  while (Date.now() < deadline) {
    await sleep(1500);
    items = await execJS(win, 'listItems', LIST_ITEMS_SCRIPT);
    const fingerprint = JSON.stringify(items.map(i => i.id).sort());
    if (items.length && fingerprint === previous) return items;
    previous = fingerprint;
  }
  logFn(`readListingHere: read empty for ${Math.round(patienceMs / 1000)}s — treating it as an empty folder`);
  return items;
}

async function listFolderItems(folderId, opts = {}) {
  logFn(`listFolderItems: ${folderId}${opts.force ? ' (forced reload)' : ''}`);
  await navigateToFolder(folderId, opts);
  const win = getDriveWindow({ show: false });
  await waitForSelector(win, PROBES.mainRegion.selector, 15000);
  return readListingHere(win, opts);
}

async function listFolderFileNames(folderId) {
  const items = await listFolderItems(folderId);
  return items.filter(i => !i.isFolder).map(i => i.name);
}

// Finds direct child folders by EXACT name. Returns EVERY match so the caller
// can abort on duplicates instead of creating yet another one. Exact match
// only: a prefix match would conflate "08_August" with "08_August_old".
async function findChildFoldersByName(parentId, name, opts = {}) {
  const items = await listFolderItems(parentId, opts);
  return items.filter(i => i.isFolder && i.name === name).map(i => i.id);
}

// Creates a folder via New -> New folder -> type -> Create. Returns nothing
// useful on its own; findOrCreateFolder reads the id back from a fresh listing.
async function createFolder(parentId, name) {
  logFn(`createFolder: "${name}" in ${parentId}`);
  await navigateToFolder(parentId);
  const win = getDriveWindow({ show: true });
  win.focus();
  win.webContents.focus();
  await waitForSelector(win, PROBES.mainRegion.selector, 15000);
  await sleep(1200);

  const newBtn = await execJS(win, 'locate:newButton',
    locateByTextScript(PROBES.newButton.text, '[role=button],button'));
  if (!newBtn) throw new Error('could not find the New button — run driveDiagnose and update drive-probes.js');
  await realClickAt(win, newBtn);
  await sleep(1500);

  const item = await execJS(win, 'locate:menuItemNewFolder',
    locateByTextScript(PROBES.menuItemNewFolder.text, '[role=menuitem]'));
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
}

// Find-or-create with the duplicate guard. The ONLY sanctioned way to obtain a
// month or task folder id.
async function findOrCreateFolder(parentId, name) {
  const existing = await findChildFoldersByName(parentId, name, { force: true });
  if (existing.length === 1) return existing[0];
  if (existing.length > 1) {
    throw new Error(`Drive already has ${existing.length} folders named "${name}" in this parent. Resolve that by hand — refusing to add another.`);
  }

  await createFolder(parentId, name);

  // Navigate ONCE, then poll the DOM in place. Re-navigating on every retry
  // issued a new loadURL before the previous one finished, aborting it
  // (ERR_FAILED). Drive updates its listing live, so re-reading the current
  // page is both correct and much faster.
  await navigateToFolder(parentId, { force: true });
  const win = getDriveWindow({ show: false });
  await waitForSelector(win, PROBES.mainRegion.selector, 15000);

  let after = [];
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const items = await execJS(win, 'listItems', LIST_ITEMS_SCRIPT);
    after = items.filter(i => i.isFolder && i.name === name).map(i => i.id);
    if (after.length) break;
  }

  if (after.length !== 1) {
    const all = await execJS(win, 'listItems', LIST_ITEMS_SCRIPT).catch(e => ({ err: e.message }));
    const state = await pageState(win);
    throw new Error(`Created "${name}" but read back ${after.length} matches.\nItems seen: ${JSON.stringify(all)}\nPage state: ${JSON.stringify(state)}`);
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

      const newBtn = await execJS(win, 'locate:newButton',
        locateByTextScript(PROBES.newButton.text, '[role=button],button'));
      if (!newBtn) throw new Error('could not find the New button — run driveDiagnose and update drive-probes.js');
      await realClickAt(win, newBtn);
      await sleep(1500);

      const item = await execJS(win, 'locate:menuItemFileUpload',
        locateByTextScript(PROBES.menuItemFileUpload.text, '[role=menuitem]'));
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
async function deliver(args) {
  if (inFlight) {
    throw new Error('a Drive upload is already running — wait for it to finish before starting another');
  }
  const watchdog = new Promise((_r, reject) =>
    setTimeout(() => reject(new Error('Drive upload timed out after 5 minutes — check higgtable.log for the last [drive] step reached')), 300000));
  inFlight = Promise.race([doDeliver(args), watchdog]).finally(() => { inFlight = null; });
  return inFlight;
}

async function doDeliver({ appFolderId, monthName, taskName, filePaths }) {
  if (!appFolderId) throw new Error('no Drive folder configured for this app code');
  if (!monthName || !taskName) throw new Error('missing month or task folder name');
  if (!Array.isArray(filePaths) || !filePaths.length) throw new Error('no files to upload');

  logFn(`deliver: start ${monthName}/${taskName}, ${filePaths.length} file(s)`);
  const login = await ensureLoggedIn();
  if (!login.loggedIn) throw new Error('not signed in to Google — sign in the Drive window, then retry');
  logFn('deliver: signed in');

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
  logFn('deliver: preflight ok');

  const warnings = [];
  const monthId = await findOrCreateFolder(appFolderId, monthName);
  logFn(`deliver: month folder ${monthName} -> ${monthId}`);
  const taskId = await findOrCreateFolder(monthId, taskName);
  logFn(`deliver: task folder ${taskName} -> ${taskId}`);

  const existing = await listFolderFileNames(taskId);
  const expected = filePaths.map(p => path.basename(p));
  const clashes = expected.filter(n => existing.includes(n));
  if (clashes.length) {
    warnings.push(`Drive already has these files and will create duplicates rather than replace them: ${clashes.join(', ')}`);
  }

  const up = await uploadFiles(taskId, filePaths);
  logFn(`deliver: upload triggered via ${up.strategy}`);

  // Verification gate. The upload happens in the folder view we're already on
  // and Drive updates that listing in place, so re-read the CURRENT page rather
  // than re-navigating on every poll (which made this take minutes).
  const win = getDriveWindow({ show: false });
  let missing = expected.slice();
  const deadline = Date.now() + 90000;
  while (missing.length && Date.now() < deadline) {
    await sleep(3000);
    const items = await execJS(win, 'listItems', LIST_ITEMS_SCRIPT).catch(() => []);
    const present = items.filter(i => !i.isFolder).map(i => i.name);
    missing = expected.filter(n => !present.includes(n));
    if (missing.length) logFn(`deliver: waiting on ${missing.length} file(s)`);
  }
  logFn(`deliver: verification done, missing=${JSON.stringify(missing)}`);

  const nav = await navigateToFolder(taskId);
  win.hide();
  return { folderUrl: nav.url, folderId: taskId, missing, warnings };
}


// Reads Drive's upload progress: { done, total } from the "X of Y" counter, or
// null when no progress dialog is visible.
const PROGRESS_SCRIPT = `(() => {
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = e => { const r = e.getBoundingClientRect(); return e.offsetParent !== null && r.width > 0; };
  for (const d of [...document.querySelectorAll(${JSON.stringify(PROBES.uploadProgressDialog.selector)})].filter(vis)) {
    const m = norm(d.innerText).match(/${PROBES.uploadProgressDialog.counterPattern}/);
    if (m) return { done: Number(m[1]), total: Number(m[2]) };
  }
  return null;
})()`;

// ---------------------------------------------------------------------------
// DIAGNOSTIC ONLY. Answers, against the user's live Drive, whether several task
// folders can be delivered in ONE action instead of one action per task. Two
// candidates, cheapest first:
//   'chooser' — hand DOM.setFileInputFiles an ARRAY of directory paths through
//     the already-proven New -> Folder upload path. Drive reports the chooser
//     as mode "selectSingle", but that is Drive's hint, not a hard limit of the
//     protocol call, so it is worth measuring before building anything new.
//   'drag' — CDP Input.dispatchDragEvent with DragData.files. Closer to what a
//     human does, but it is unknown whether Chromium turns dropped directory
//     paths into the directory entries Drive's drop handler reads.
// This UPLOADS into whatever folder id it is given. Point it at a scratch
// folder, never a client folder. It never touches Airtable.
async function probeMultiFolderUpload(folderId, folderPaths, mode = 'chooser') {
  if (!folderId) throw new Error('probeMultiFolderUpload needs a destination folder id');
  if (!Array.isArray(folderPaths) || folderPaths.length < 2) {
    throw new Error('pass at least two local folder paths — one proves nothing about batching');
  }
  for (const fp of folderPaths) {
    if (!fs.existsSync(fp) || !fs.statSync(fp).isDirectory()) throw new Error(`not a directory: ${fp}`);
  }

  const login = await ensureLoggedIn();
  if (!login.loggedIn) return { error: 'not signed in to Google' };

  const win = await openFolderForWork(folderId);
  win.webContents.focus();
  const before = (await readListingHere(win)).map(i => i.name);
  const result = { mode, folderId, attempted: folderPaths.length, before };

  if (mode === 'chooser') {
    await withDebugger(win, async (dbg) => {
      let chooser = null;
      const onMessage = (_e, method, params) => {
        if (method === 'Page.fileChooserOpened') chooser = params;
      };
      dbg.on('message', onMessage);
      try {
        await dbg.sendCommand('Page.enable');
        await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
        await execJS(win, 'click:new', clickByTextScript(PROBES.newButton.text));
        await sleep(1500);
        const item = await execJS(win, 'locate:folderUpload',
          locateByTextScript(PROBES.menuItemFolderUpload.text, '[role=menuitem]'));
        if (!item) { result.error = 'no "Folder upload" menu item'; return; }
        await realClickAt(win, item);
        const deadline = Date.now() + 15000;
        while (!chooser && Date.now() < deadline) await sleep(300);
        if (!chooser) { result.error = 'chooser never opened'; return; }
        result.chooserMode = chooser.mode;
        try {
          const r = await dbg.sendCommand('DOM.setFileInputFiles', {
            files: folderPaths,
            backendNodeId: chooser.backendNodeId,
          });
          result.setFilesAccepted = true;
          result.setFilesResult = r || null;
        } catch (err) {
          result.setFilesAccepted = false;
          result.setFilesError = String(err && err.message);
        }
      } finally {
        dbg.removeListener('message', onMessage);
        try { await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }); } catch (e) { /* best effort */ }
      }
    });
  } else if (mode === 'drag') {
    const rect = await execJS(win, 'mainRect', `(() => {
      const el = document.querySelector(${JSON.stringify(PROBES.mainRegion.selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!rect) return { ...result, error: 'could not locate the drop target' };
    result.dropPoint = rect;
    await withDebugger(win, async (dbg) => {
      const data = { items: [], files: folderPaths, dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        try {
          await dbg.sendCommand('Input.dispatchDragEvent', { type, x: rect.x, y: rect.y, data });
          result[type] = 'ok';
        } catch (err) {
          result[type] = String(err && err.message);
          result.error = `Input.dispatchDragEvent(${type}) failed`;
          return;
        }
        await sleep(600);
      }
    });
  } else {
    return { ...result, error: `unknown probe mode "${mode}"` };
  }

  // Did Drive actually start ingesting anything?
  const progress = [];
  const watchUntil = Date.now() + 45000;
  while (Date.now() < watchUntil) {
    const p = await execJS(win, 'uploadProgress', PROGRESS_SCRIPT).catch(() => null);
    if (p) {
      const last = progress[progress.length - 1];
      if (!last || last.done !== p.done || last.total !== p.total) progress.push(p);
      if (p.done >= p.total) break;
    }
    await sleep(2000);
  }
  result.progress = progress;
  result.after = (await readListingHere(win, { patienceMs: 20000 })).map(i => i.name);
  result.landed = result.after.filter(n => !before.includes(n));
  logFn(`probeMultiFolderUpload(${mode}): landed ${result.landed.length}/${folderPaths.length}`);
  return result;
}

// Uploads a whole local folder via New -> Folder upload. Drive creates the task
// folder itself, which removes the New-folder dialog — the most failure-prone
// part of the single-file path. Only the MONTH folder is find-or-created here.
async function uploadFolderToDrive({ appFolderId, monthName, taskName, localFolderPath, monthFolderId }) {
  if (!appFolderId) throw new Error('no Drive folder configured for this app code');
  if (!monthName || !taskName || !localFolderPath) throw new Error('missing month, task name, or local folder');

  const login = await ensureLoggedIn({ trustCurrentPage: true });
  if (!login.loggedIn) throw new Error('not signed in to Google — sign in the Drive window, then retry');

  // A bulk run passes the month folder it already resolved. The answer cannot
  // change between tasks in one run, and every extra find-or-create is another
  // chance to misread a slow listing and create a duplicate month folder.
  // Reaching the destination and preflighting the UI are proved by that first
  // task too, and each is a full SPA reload, so later tasks skip both.
  let monthId = monthFolderId;
  if (!monthId) {
    const appNav = await navigateToFolder(appFolderId);
    if (appNav.folderId !== appFolderId) {
      throw new Error(`configured app folder ${appFolderId} is not reachable — check the Settings URL`);
    }
    const pre = await preflight();
    if (!pre.ok) {
      throw new Error(`Drive UI has changed; aborted before uploading. Failing probes: ${pre.failures.join(', ')}`);
    }
    monthId = await findOrCreateFolder(appFolderId, monthName);
  }
  logFn(`uploadFolderToDrive: month ${monthName} -> ${monthId}${monthFolderId ? ' (reused)' : ''}`);

  // ONE navigation serves both the duplicate check and the upload: the check
  // reads the very page the upload is about to act on.
  const win = await openFolderForWork(monthId);
  win.webContents.focus();

  // Folder upload cannot merge into an existing folder — it would create a
  // second one with the same name. Refuse rather than duplicate.
  const already = (await readListingHere(win)).filter(i => i.isFolder && i.name === taskName);
  if (already.length) {
    throw new Error(`"${taskName}" already exists in ${monthName}; Folder upload would create a duplicate rather than merge. Delete it first, or use the single-task upload.`);
  }

  await withDebugger(win, async (dbg) => {
    let chooser = null;
    const onMessage = (_e, method, params) => {
      if (method === 'Page.fileChooserOpened') chooser = params;
    };
    dbg.on('message', onMessage);
    try {
      await dbg.sendCommand('Page.enable');
      await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });

      // The window stays hidden. sendInputEvent is delivered straight to the
      // webContents, so unlike real OS input it needs no on-screen window —
      // but that is reasoned, not measured, for this menu specifically. So if
      // the chooser does not open, show the window and try once more instead
      // of failing the task. The fallback is logged: if it fires every run,
      // hidden operation does not work and the default must change back.
      for (let attempt = 1; attempt <= 2 && !chooser; attempt++) {
        if (attempt === 2) {
          logFn('uploadFolderToDrive: chooser did not open while hidden — showing the window and retrying');
          win.show();
          win.focus();
          win.webContents.focus();
          await sleep(1000);
        }
        await execJS(win, 'click:new', clickByTextScript(PROBES.newButton.text));
        await sleep(1500);
        const item = await execJS(win, 'locate:folderUpload',
          locateByTextScript(PROBES.menuItemFolderUpload.text, '[role=menuitem]'));
        if (!item) {
          if (attempt === 2) throw new Error('could not find the "Folder upload" menu item — run driveDiagnose');
          continue;
        }
        await realClickAt(win, item);
        const chooserDeadline = Date.now() + 15000;
        while (!chooser && Date.now() < chooserDeadline) await sleep(300);
      }
      if (!chooser) throw new Error('folder chooser never opened — nothing was uploaded');

      // mode is "selectSingle": exactly one directory path.
      await dbg.sendCommand('DOM.setFileInputFiles', {
        files: [localFolderPath],
        backendNodeId: chooser.backendNodeId,
      });
      logFn(`uploadFolderToDrive: handed Chromium ${localFolderPath}`);
    } finally {
      dbg.removeListener('message', onMessage);
      try { await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }); } catch (e) { /* best effort */ }
    }
  });

  // Progress-based wait. A 99-file folder took ~26 minutes, so a fixed deadline
  // would report false failures; only a STALL means something is wrong.
  const STALL_MS = 4 * 60 * 1000;
  const CEILING_MS = 2 * 60 * 60 * 1000;
  const started = Date.now();
  let lastDone = -1;
  let lastChange = Date.now();
  let sawProgress = false;
  while (Date.now() - started < CEILING_MS) {
    const p = await execJS(win, 'uploadProgress', PROGRESS_SCRIPT).catch(() => null);
    if (p) {
      sawProgress = true;
      if (p.done !== lastDone) {
        lastDone = p.done;
        lastChange = Date.now();
        logFn(`uploadFolderToDrive: ${p.done}/${p.total}`);
      }
      if (p.done >= p.total) break;
    } else if (sawProgress) {
      break; // dialog dismissed once complete
    }
    if (Date.now() - lastChange > STALL_MS) {
      throw new Error(`upload stalled at ${lastDone < 0 ? 'no progress' : lastDone} — Creative Link not written for this task`);
    }
    await sleep(5000);
  }

  // Read back the folder Drive created; the link comes from the URL. Poll the
  // page we are already on — Drive adds the uploaded folder to the live
  // listing, so the old force-reload-per-attempt cost seconds each time and
  // kept discarding a rendered grid. That is what reported "read back 0
  // folders" for folders that had in fact uploaded correctly. Finding the name
  // is positive evidence, so unlike concluding absence it needs no settling.
  let found = [];
  const readDeadline = Date.now() + 120000;
  while (Date.now() < readDeadline) {
    await sleep(2000);
    const items = await execJS(win, 'listItems', LIST_ITEMS_SCRIPT).catch(() => []);
    found = items.filter(i => i.isFolder && i.name === taskName).map(i => i.id);
    if (found.length) break;
  }
  if (!found.length) {
    // Last resort before failing a task whose files may well have arrived:
    // maybe the live listing never refreshed. Reload once and look again.
    logFn(`uploadFolderToDrive: "${taskName}" not in the live listing after 120s — reloading once`);
    found = (await listFolderItems(monthId, { force: true }))
      .filter(i => i.isFolder && i.name === taskName).map(i => i.id);
  }
  if (found.length !== 1) {
    throw new Error(`uploaded but read back ${found.length} folders named "${taskName}" — Creative Link not written`);
  }
  // The folder URL is derivable from the id: it is the exact shape
  // navigateToFolder builds and parseFolderIdFromUrl reads. Navigating into the
  // folder purely to read getURL() cost a full reload per task and left the
  // window on the wrong folder for the next one.
  const folderUrl = `https://drive.google.com/drive/folders/${found[0]}`;
  logFn(`uploadFolderToDrive: done -> ${folderUrl}`);
  return { folderUrl, folderId: found[0], monthFolderId: monthId };
}

// Finds already-uploaded task folders by EXACT name. READ-ONLY: this function
// never creates anything in Drive, not even the month folder — if the month
// folder is missing the search simply widens to the other months and then
// reports what it could not find. The guard is duplicated from deliver() rather
// than refactored into it, so the working upload path is left untouched.
async function findFoldersByNames(args) {
  if (inFlight) {
    throw new Error('a Drive operation is already running — wait for it to finish before starting another');
  }
  const watchdog = new Promise((_r, reject) =>
    setTimeout(() => reject(new Error('Drive lookup timed out after 5 minutes — check higgtable.log for the last [drive] step reached')), 300000));
  inFlight = Promise.race([doFindFoldersByNames(args), watchdog]).finally(() => { inFlight = null; });
  return inFlight;
}

async function doFindFoldersByNames({ appFolderId, monthName, monthYear, taskNames }) {
  if (!appFolderId) throw new Error('no Drive folder configured for this app code');
  if (!Array.isArray(taskNames) || !taskNames.length) throw new Error('no task names to look up');

  const login = await ensureLoggedIn({ trustCurrentPage: true });
  if (!login.loggedIn) throw new Error('not signed in to Google — sign in the Drive window, then retry');

  // A folder's id only exists in its parent's listing, so each level has to be
  // read on the way down. Real delivery folders are <app>/<year>/<month>/<task>;
  // the scratch folder used for testing is flat, <test>/<month>/<task>. Both are
  // handled by classifying what is actually present rather than assuming.
  const appWin = await openFolderForWork(appFolderId);
  const rootItems = await readListingHere(appWin);
  const { years, months } = classifyPeriodFolders(rootItems);
  const currentYear = String(monthYear || new Date().getFullYear());
  logFn(`findFoldersByNames: ${taskNames.length} task(s) under ${appFolderId} — ${years.length} year folder(s), ${months.length} flat month folder(s), ${rootItems.length} item(s) total`);

  const matched = {};
  const duplicates = [];
  const searched = [];
  let remaining = taskNames.slice();

  // The task folders may sit directly in the configured folder — that happens
  // when the setting points at a month or year folder rather than the app root,
  // and whenever the user drops folders straight into a scratch folder. This
  // listing is already read, so checking it costs nothing.
  const atRoot = matchTasksToFolders(remaining, rootItems);
  Object.assign(matched, atRoot.matched);
  for (const d of atRoot.duplicates) if (!duplicates.includes(d)) duplicates.push(d);
  remaining = atRoot.unmatched;
  searched.push('the folder itself');
  logFn(`findFoldersByNames: folder itself -> matched ${Object.keys(atRoot.matched).length}, ${remaining.length} still missing`);

  // Searches one month folder. Returns true when every task has been decided.
  const searchMonth = async (folder, label) => {
    const win = await openFolderForWork(folder.id);
    const result = matchTasksToFolders(remaining, await readListingHere(win));
    Object.assign(matched, result.matched);
    for (const d of result.duplicates) if (!duplicates.includes(d)) duplicates.push(d);
    searched.push(label);
    // A duplicate is a decided outcome, not something to keep hunting for, so
    // only the genuinely unmatched names carry into the next month folder.
    remaining = result.unmatched;
    logFn(`findFoldersByNames: ${label} -> matched ${Object.keys(result.matched).length}, ${remaining.length} still missing`);
    return remaining.length === 0;
  };

  // Flat months directly under the destination first: that is the scratch-folder
  // layout, and when it applies there are no year folders to descend into.
  for (const m of monthSearchOrder(months.map(f => ({ ...f, isFolder: true })), monthName)) {
    if (!remaining.length) break;
    if (await searchMonth(m, m.name)) break;
  }

  for (const year of yearSearchOrder(years, currentYear)) {
    if (!remaining.length) break;
    const yearWin = await openFolderForWork(year.id);
    const yearMonths = monthSearchOrder(await readListingHere(yearWin), monthName);
    for (const m of yearMonths) {
      if (!remaining.length) break;
      if (await searchMonth(m, `${year.name}/${m.name}`)) break;
    }
  }

  // When something is still missing, hand back what the destination actually
  // contains. A bare "not found" gives the user nothing to act on; the folder
  // names do.
  const sampleNames = remaining.length
    ? rootItems.filter(i => i.isFolder).map(i => i.name).slice(0, 20)
    : [];
  return { matched, duplicates, unmatched: remaining, searched, sampleNames };
}

module.exports = {
  getDriveWindow,
  waitForLoad,
  waitForSelector,
  ensureLoggedIn,
  navigateToFolder,
  diagnose,
  withDebugger,
  setLogger,
  preflight,
  readListingHere,
  probeMultiFolderUpload,
  openFolderForWork,
  listFolderItems,
  listFolderFileNames,
  findChildFoldersByName,
  findOrCreateFolder,
  createFolder,
  uploadFiles,
  deliver,
  uploadFolderToDrive,
  findFoldersByNames,
  PARTITION,
};
