// drive-browser.js  (main process)
// Owns a persistent-session BrowserWindow logged into Google Drive, and the
// navigation primitives that need no DOM knowledge. Every DOM assumption lives
// in drive-probes.js instead, so a Google UI change has exactly one place to be
// repaired.
//
// The user logs in manually, in Google's real login page. This module never
// reads, stores, types, or transmits credentials.

const { BrowserWindow } = require('electron');

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
    uploadProbe = await withDebugger(win, async (dbg) => {
      const events = [];
      const onMessage = (_e, method, params) => {
        if (method === 'Page.fileChooserOpened') events.push({ method, params });
      };
      dbg.on('message', onMessage);
      try {
        await dbg.sendCommand('Page.enable');
        await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });

        const newCandidates = await win.webContents.executeJavaScript(describeCandidatesScript('New'));
        const clickedNew = await win.webContents.executeJavaScript(clickByTextScript('New'));
        await sleep(1800);
        const menu = await win.webContents.executeJavaScript(DUMP_MENU_SCRIPT);

        // Drive labels this differently across versions; try each in turn.
        let clickedUpload = null;
        for (const label of ['File upload', 'Upload files', 'Upload file']) {
          clickedUpload = await win.webContents.executeJavaScript(clickByTextScript(label));
          if (clickedUpload && clickedUpload.clicked) { clickedUpload.matchedLabel = label; break; }
        }
        await sleep(2500);

        return {
          newCandidates,
          clickedNew,
          menuItems: menu,
          clickedUpload,
          fileChooserIntercepted: events.length > 0,
          fileChooserEvent: events[0] ? events[0].params : null,
        };
      } finally {
        dbg.removeListener('message', onMessage);
        try { await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }); } catch (e) { /* best effort */ }
        // Close any menu/dialog left open so the page is clean for the next run.
        await win.webContents.executeJavaScript(
          'document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})), true'
        ).catch(() => {});
      }
    });
  }

  return { loggedIn: true, navigatedTo: nav, report, rows, uploadProbe };
}

module.exports = {
  getDriveWindow,
  waitForLoad,
  waitForSelector,
  ensureLoggedIn,
  navigateToFolder,
  diagnose,
  withDebugger,
  PARTITION,
};
