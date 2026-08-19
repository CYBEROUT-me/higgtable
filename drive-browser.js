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

// Reports what the live Drive DOM actually contains, so probes can be written
// from evidence instead of guesswork. Returns counts and small samples only —
// never file contents.
async function diagnose(folderId) {
  const login = await ensureLoggedIn();
  if (!login.loggedIn) return { loggedIn: false, url: login.url };

  const nav = folderId ? await navigateToFolder(folderId) : { url: login.url, folderId: null };
  const win = getDriveWindow({ show: false });

  // Give the SPA a moment to render its listing before sampling the DOM.
  await waitForSelector(win, '[data-id]', 15000);

  const report = await win.webContents.executeJavaScript(`(() => {
    const sample = (list, n) => Array.prototype.slice.call(list, 0, n);
    const desc = (el) => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      dataId: el.getAttribute('data-id'),
      dataTooltip: el.getAttribute('data-tooltip'),
      text: (el.innerText || '').trim().slice(0, 60),
    });
    const fileInputs = document.querySelectorAll('input[type=file]');
    const dataIdEls = document.querySelectorAll('[data-id]');
    const buttons = document.querySelectorAll('[role=button],button');
    const newBtns = Array.prototype.filter.call(buttons, b => {
      const s = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).toLowerCase();
      return s.includes('new') || s.includes('folder');
    });
    return {
      title: document.title,
      href: location.href,
      lang: document.documentElement.lang,
      counts: {
        fileInputs: fileInputs.length,
        dataIdElements: dataIdEls.length,
        buttons: buttons.length,
        newButtonCandidates: newBtns.length,
      },
      fileInputs: sample(fileInputs, 5).map(i => ({
        multiple: i.multiple,
        accept: i.accept,
        hidden: i.hidden,
        name: i.name,
        id: i.id,
        className: (i.className || '').slice(0, 80),
        parentRole: i.parentElement && i.parentElement.getAttribute('role'),
      })),
      dataIdSamples: sample(dataIdEls, 8).map(desc),
      newButtonSamples: newBtns.slice(0, 8).map(desc),
      mainRegions: sample(document.querySelectorAll('[role=main],[role=grid],[role=list]'), 5).map(desc),
    };
  })()`);

  return { loggedIn: true, navigatedTo: nav, report };
}

module.exports = {
  getDriveWindow,
  waitForLoad,
  waitForSelector,
  ensureLoggedIn,
  navigateToFolder,
  diagnose,
  PARTITION,
};
