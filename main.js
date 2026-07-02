const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { fetchBases, fetchTables, fetchRecords } = require('./airtable');

// GitHub repo hosting releases — used for update checks below.
const UPDATE_REPO = 'CYBEROUT-me/higgtable';

// ── Settings ───────────────────────────────────────────────────────────

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettingsFile() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return {}; }
}

function saveSettingsFile(data) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
}

let cachedApiKey = null;
function getApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const s = loadSettingsFile();
  if (s.apiKey) cachedApiKey = s.apiKey;
  return cachedApiKey || '';
}

// ── File dimensions ────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.gif','.webp','.bmp','.tiff','.tif']);
const VIDEO_EXTS = new Set(['.mp4','.mov','.avi','.mkv','.m4v','.webm']);

function getFileDimensions(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return getImageDimensions(filePath);
  if (VIDEO_EXTS.has(ext)) return getMp4Dimensions(filePath);
  throw new Error(`Unsupported file type: ${ext}`);
}

function getImageDimensions(filePath) {
  const mod = require('image-size');
  const sizeOf = typeof mod === 'function' ? mod : (mod.imageSize || mod.default);
  const buf = fs.readFileSync(filePath);
  const dims = sizeOf(buf);
  return { width: dims.width, height: dims.height };
}

function getMp4Dimensions(filePath) {
  const buf = Buffer.alloc(8);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.statSync(filePath).size;
    const result = parseMp4Boxes(fd, 0, size, buf);
    if (!result) throw new Error('Could not find video dimensions in file');
    return result;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function parseMp4Boxes(fd, start, end, buf) {
  let pos = start;
  while (pos < end - 8) {
    fs.readSync(fd, buf, 0, 8, pos);
    const size = buf.readUInt32BE(0);
    const type = buf.slice(4, 8).toString('ascii');
    if (size < 8) break;
    if (type === 'moov' || type === 'trak') {
      const found = parseMp4Boxes(fd, pos + 8, pos + size, buf);
      if (found) return found;
    } else if (type === 'tkhd') {
      const tkhd = Buffer.alloc(size);
      fs.readSync(fd, tkhd, 0, size, pos);
      const ver = tkhd[8];
      const wFixed = ver === 1 ? tkhd.readUInt32BE(96) : tkhd.readUInt32BE(84);
      const hFixed = ver === 1 ? tkhd.readUInt32BE(100) : tkhd.readUInt32BE(88);
      const w = wFixed >> 16;
      const h = hFixed >> 16;
      if (w > 0 && h > 0) return { width: w, height: h };
    }
    pos += size;
  }
  return null;
}

// ── Auto-update ────────────────────────────────────────────────────────
// Windows: electron-updater silently downloads and installs the next
// version. macOS: the app isn't code-signed (no paid Apple Developer
// account), so Squirrel.Mac can't verify a silent update — instead we
// just check GitHub Releases and point the user at the new .dmg.

function initAutoUpdate(win) {
  if (process.platform === 'win32') {
    autoUpdater.on('update-downloaded', (info) => {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Update ready',
        message: `HiggTable ${info.version} has been downloaded.`,
        detail: 'Restart now to install it?',
        buttons: ['Restart', 'Later'],
      }).then(res => { if (res.response === 0) autoUpdater.quitAndInstall(); });
    });
    autoUpdater.on('error', err => console.error('AutoUpdater error:', err));
    autoUpdater.checkForUpdates().catch(err => console.error('AutoUpdater check failed:', err));
  } else if (process.platform === 'darwin') {
    checkMacUpdate(win).catch(err => console.error('Update check failed:', err));
  }
}

async function checkMacUpdate(win) {
  const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
  if (!res.ok) return;
  const data = await res.json();
  const latest = (data.tag_name || '').replace(/^v/, '');
  const current = app.getVersion();
  if (!latest || !isNewerVersion(latest, current)) return;

  const asset = (data.assets || []).find(a => a.name.endsWith('.dmg'));
  const url = asset ? asset.browser_download_url : data.html_url;
  const result = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Update available',
    message: `HiggTable ${latest} is available (you have ${current}).`,
    detail: 'Download the new version and reinstall it to update.',
    buttons: ['Download', 'Later'],
  });
  if (result.response === 0) shell.openExternal(url);
}

function isNewerVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// ── Window ─────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  win.loadFile('renderer/index.html');
  win.webContents.once('did-finish-load', () => initAutoUpdate(win));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── IPC ────────────────────────────────────────────────────────────────

ipcMain.handle('get-bases', async () => {
  const key = getApiKey();
  if (!key) throw new Error('NO_API_KEY');
  try { return await fetchBases(key); }
  catch (err) { throw new Error(`get-bases failed: ${err.message}`); }
});
ipcMain.handle('get-tables', async (_e, baseId) => {
  const key = getApiKey();
  if (!key) throw new Error('NO_API_KEY');
  try { return await fetchTables(key, baseId); }
  catch (err) { throw new Error(`get-tables failed: ${err.message}`); }
});
ipcMain.handle('get-records', async (_e, baseId, tableId) => {
  const key = getApiKey();
  if (!key) throw new Error('NO_API_KEY');
  try { return await fetchRecords(key, baseId, tableId); }
  catch (err) { throw new Error(`get-records failed: ${err.message}`); }
});

ipcMain.handle('get-settings', () => loadSettingsFile());
ipcMain.handle('save-settings', (_e, data) => {
  saveSettingsFile(data);
  if (data.apiKey) cachedApiKey = data.apiKey;
});
ipcMain.handle('has-api-key', () => !!getApiKey());

ipcMain.handle('open-file-dialog', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media', extensions: ['mp4','mov','avi','mkv','m4v','jpg','jpeg','png','gif','webp'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('get-file-dimensions', (_e, filePath) => {
  try { return getFileDimensions(filePath); }
  catch (err) { throw new Error(err.message); }
});

ipcMain.handle('rename-file', (_e, fromPath, toPath) => {
  if (fs.existsSync(toPath)) throw new Error(`Already exists: ${path.basename(toPath)}`);
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  fs.renameSync(fromPath, toPath);
  return true;
});
