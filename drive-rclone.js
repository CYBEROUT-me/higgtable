// drive-rclone.js
// Reads the Google Drive delivery folders through rclone, for main.js. Read
// only: it runs `rclone lsjson` and nothing else (never `rclone link`, which
// would change a file's sharing). The user sets rclone up and signs in to
// Google themselves; the app never sees those credentials.
//
// Drive layout: <root> / <App>_creatives / <YYYY> / <MM_Month> / <task name> /
// Listing a folder by its id (root_folder_id=<id>) is one Drive call, while a
// path costs one call per level, so folder ids are cached (memory and
// settings) and month listings are kept for a couple of minutes.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  monthFolder, countCodes, codeMapFromCounts, matchTaskFolders, taskCode,
} = require('./renderer/drive-index');

const LISTING_TTL_MS = 2 * 60 * 1000;
const RELEARN_MS = 30 * 60 * 1000;
const RCLONE_TIMEOUT_MS = 3 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_REMOTE = /^[A-Za-z0-9_.-]+$/;

// rclone from Settings, else the one shipped in the app (main.js passes its
// resolver: resources/bin when packaged, vendor/ or Homebrew in development).
function findRclone(custom, bundled) {
  if (custom) {
    try { if (fs.statSync(custom).isFile()) return custom; } catch {}
  }
  return bundled || (process.platform === 'win32' ? 'rclone.exe' : 'rclone');
}

function runRclone(bin, args, { timeout = RCLONE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 256 * 1024 * 1024, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || '').split('\n').filter(l => /ERROR|Failed|error/i.test(l)).pop()
          || (err.code === 'ENOENT' ? 'rclone is not installed (or not found)' : err.message);
        reject(new Error(msg.trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

class DriveIndex {
  // `getSettings` / `saveSettings` read and merge settings.json; `log` logs.
  constructor({ getSettings, saveSettings, log, bundledRclone }) {
    this.bundledRclone = bundledRclone || (() => null);
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.log = log || (() => {});
    this.listings = new Map(); // folder id -> { at, entries }
    this.queue = Promise.resolve();
  }

  config() {
    const s = this.getSettings();
    const remote = s.rcloneRemote || 'gdrive';
    const root = s.driveRootFolderId || '';
    if (!root) throw new Error('No Drive root folder set (Settings → Google Drive)');
    if (!SAFE_ID.test(root)) throw new Error('The Drive root folder id is not valid');
    if (!SAFE_REMOTE.test(remote)) throw new Error('The rclone remote name is not valid');
    return { bin: findRclone(s.rclonePath, this.bundledRclone()), remote, root, settings: s };
  }

  // Sub-folders of a folder, by id: [{ Name, ID, ModTime }].
  async listDirs(folderId, { fresh = false } = {}) {
    if (!SAFE_ID.test(folderId)) throw new Error(`Bad folder id: ${folderId}`);
    const cached = this.listings.get(folderId);
    if (!fresh && cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.entries;
    const { bin, remote } = this.config();
    const t0 = Date.now();
    const out = await runRclone(bin, ['lsjson', `${remote},root_folder_id=${folderId}:`, '--dirs-only', '--no-mimetype']);
    const entries = JSON.parse(out || '[]').map(e => ({ Name: e.Name, ID: e.ID, ModTime: e.ModTime }));
    this.listings.set(folderId, { at: Date.now(), entries });
    this.log(`drive-rclone: listed ${folderId} (${entries.length} folders) in ${Date.now() - t0}ms`);
    return entries;
  }

  // Cached id of a folder path ("Lowins_creatives/2026/11_November"); lists
  // the parent once to find it. null when it does not exist.
  async folderId(relPath) {
    const { root, settings } = this.config();
    const cache = { ...(settings.driveFolderIds || {}) };
    if (cache.__root !== root) Object.keys(cache).forEach(k => delete cache[k]);
    if (!relPath) return root;
    if (cache[relPath]) return cache[relPath];
    const parts = relPath.split('/');
    const parentId = await this.folderId(parts.slice(0, -1).join('/'));
    if (!parentId) return null;
    const entries = await this.listDirs(parentId);
    const prefix = parts.slice(0, -1).join('/');
    const fresh = { ...(this.getSettings().driveFolderIds || {}) };
    if (fresh.__root !== root) Object.keys(fresh).forEach(k => delete fresh[k]);
    fresh.__root = root;
    entries.forEach(e => { fresh[prefix ? `${prefix}/${e.Name}` : e.Name] = e.ID; });
    this.saveSettings({ driveFolderIds: fresh });
    return fresh[relPath] || null;
  }

  // The app folders under the root: ['Lowins_creatives', …].
  async appFolders() {
    const { root } = this.config();
    return (await this.listDirs(root)).map(e => e.Name).sort();
  }

  // One app's month: { path, id, entries } or null when that month folder
  // does not exist. Learns task-name prefixes from what it sees.
  async monthListing(app, ym, counts) {
    const mf = monthFolder(ym);
    if (!mf) return null;
    const rel = `${app}/${mf.year}/${mf.folder}`;
    let id = await this.folderId(rel);
    if (!id) return null;
    let entries;
    try {
      entries = await this.listDirs(id);
    } catch (err) {
      // A cached id can go stale (folder deleted and made again): forget it,
      // look the path up again, and try once more.
      this.log(`drive-rclone: ${rel} by cached id failed (${err.message}), looking it up again`);
      const ids = { ...(this.getSettings().driveFolderIds || {}) };
      delete ids[rel];
      this.saveSettings({ driveFolderIds: ids });
      const parentId = await this.folderId(rel.split('/').slice(0, -1).join('/'));
      if (parentId) await this.listDirs(parentId, { fresh: true });
      id = await this.folderId(rel);
      if (!id) return null;
      entries = await this.listDirs(id, { fresh: true });
    }
    if (counts) countCodes(app, entries.map(e => e.Name), counts);
    return { path: rel, id, entries };
  }

  // Finds each task's folder in the given months. Prefixes not yet known are
  // learned first (slow the first time: rclone's shared Google client is
  // throttled by Google).
  // Returns { matches: { name: [{ id, path, modTime }] }, months: [{ app, ym, id, path }] }.
  async findTaskFolders(names, months) {
    // One lookup at a time: a second one (Autofill opening while "Open GD
    // Folder" runs) waits and then reuses what the first learned and cached,
    // instead of racing it with half-built state.
    const run = this.queue.then(() => this.findTaskFoldersNow(names, months));
    this.queue = run.catch(() => {});
    return run;
  }

  async findTaskFoldersNow(names, months) {
    const s = this.getSettings();
    const counts = {};
    let codeMap = { ...(s.driveCodeApps || {}) };
    const codes = [...new Set(names.map(taskCode).filter(Boolean))];
    const listings = [];
    const monthFolders = [];
    const seen = new Set();
    const addListing = async (app, ym) => {
      const key = `${app}|${ym}`;
      if (seen.has(key)) return;
      seen.add(key);
      const l = await this.monthListing(app, ym, counts);
      if (!l) return;
      listings.push(l);
      monthFolders.push({ app, ym, id: l.id, path: l.path });
    };

    // Prefixes not yet known: learn them from every app's latest month folder,
    // at most every half hour (a prefix no app holds would rescan each time).
    if (codes.some(c => !codeMap[c]) && Date.now() - (this.learnedAt || 0) > RELEARN_MS) {
      this.learnedAt = Date.now();
      for (const app of await this.appFolders()) {
        // The newest month with tasks in it (a month folder made in advance is empty).
        for (const rel of await this.latestMonthPaths(app, 3)) {
          const id = await this.folderId(rel);
          const names = id ? (await this.listDirs(id)).map(e => e.Name) : [];
          countCodes(app, names, counts);
          if (names.length) break;
        }
      }
      const learned = codeMapFromCounts(counts);
      codeMap = { ...codeMap, ...learned };
      this.saveSettings({ driveCodeApps: codeMap });
      this.log(`drive-rclone: learned prefixes ${JSON.stringify(learned)}`);
    }

    let apps = [...new Set(codes.map(c => codeMap[c]).filter(Boolean))];
    // A prefix whose own app folder is empty (LowChat, Ochat…) is filed in
    // another app's folder: look through every app's months once, and keep
    // where it was found for next time.
    this.noFolder = this.noFolder || new Map(); // code -> when it was last searched for in vain
    const toFind = codes.filter(c => !codeMap[c] && Date.now() - (this.noFolder.get(c) || 0) > RELEARN_MS);
    if (toFind.length) {
      const counts2 = {};
      for (const app of [...new Set(Object.values(codeMap))]) {
        for (const ym of months) {
          const l = await this.monthListing(app, ym, counts2);
          if (l && !seen.has(`${app}|${ym}`)) { seen.add(`${app}|${ym}`); listings.push(l); monthFolders.push({ app, ym, id: l.id, path: l.path }); }
        }
      }
      const found = codeMapFromCounts(counts2);
      const added = {};
      const scanned = Object.values(codeMap).length > 0;
      toFind.forEach(c => { if (found[c]) added[c] = found[c]; else if (scanned) this.noFolder.set(c, Date.now()); });
      if (Object.keys(added).length) {
        codeMap = { ...codeMap, ...added };
        this.saveSettings({ driveCodeApps: codeMap });
        this.log(`drive-rclone: found prefixes in other apps' folders ${JSON.stringify(added)}`);
      }
      apps = [...new Set(codes.map(c => codeMap[c]).filter(Boolean))];
    }
    for (const app of apps) {
      for (const ym of months) await addListing(app, ym);
    }
    const unknownCodes = codes.filter(c => !codeMap[c]);
    return {
      matches: matchTaskFolders(names, listings),
      months: monthFolders.filter(m => apps.includes(m.app)),
      unknownCodes,
    };
  }

  // The app's newest month folders, newest first: ["<App>/2026/11_November", …].
  async latestMonthPaths(app, max) {
    const out = [];
    const appId = await this.folderId(app);
    if (!appId) return out;
    const years = (await this.listDirs(appId)).map(e => e.Name).filter(n => /^\d{4}$/.test(n)).sort().reverse();
    for (const year of years) {
      const yearId = await this.folderId(`${app}/${year}`);
      if (!yearId) continue;
      const months = (await this.listDirs(yearId)).map(e => e.Name).filter(n => /^\d{2}_/.test(n)).sort().reverse();
      for (const m of months) {
        out.push(`${app}/${year}/${m}`);
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  // Which rclone is used, and whether its remote exists yet (Settings).
  async status() {
    const s = this.getSettings();
    const remote = s.rcloneRemote || 'gdrive';
    const bin = findRclone(s.rclonePath, this.bundledRclone());
    const version = (await runRclone(bin, ['version'], { timeout: 20000 })).split('\n')[0].trim();
    const remotes = (await runRclone(bin, ['listremotes'], { timeout: 20000 })).split('\n').map(l => l.trim().replace(/:$/, '')).filter(Boolean);
    return { bin, version, remote, connected: remotes.includes(remote) };
  }

  // Creates the remote, read only. rclone opens the Google sign-in in the
  // user's browser and stores the token in its own config file; the app never
  // sees the account or the token. Waits up to 5 minutes for the sign-in.
  async connect() {
    const s = this.getSettings();
    const remote = s.rcloneRemote || 'gdrive';
    if (!SAFE_REMOTE.test(remote)) throw new Error('The rclone remote name is not valid');
    const st = await this.status();
    if (st.connected) return st;
    this.log(`drive-rclone: creating remote "${remote}" (read only), waiting for Google sign-in in the browser`);
    await runRclone(st.bin, ['config', 'create', remote, 'drive', 'scope=drive.readonly'], { timeout: 5 * 60 * 1000 });
    return this.status();
  }

  // Lists the root, to check the setup from Settings.
  async check() {
    const apps = await this.appFolders();
    return { apps };
  }
}

module.exports = { DriveIndex, findRclone };
