const TARGET_BASE = 'UT Marketing Team';
const TARGET_TABLES = ['VCP Creatives', 'PLM Creatives', 'CMC Creatives', 'LB Creatives', 'OMGF Creatives'];
const DEFAULT_STATUSES = ['In work', 'Ready for Design'];
// Format is not a column: it shows as a video / image icon in front of the name.
const COLUMNS = ['Name', 'Priority', 'Deadline', 'Branch', 'Model ID', 'Script ID', 'Size', 'CP', 'DES', 'Network', 'Type', 'Language', 'Status'];
const FORMAT_ICONS = { Video: 'video', Stat: 'image' };
const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };

// Airtable single-select colors are "<hue><Light2|Light1|Bright|Dark1>"
// (e.g. "greenBright") — map that pattern to CSS instead of hardcoding every
// option's color, so any select field's choices render consistently.
const AIRTABLE_HUES = {
  blue: 217, cyan: 192, teal: 172, green: 130, yellow: 48,
  orange: 28, red: 355, pink: 320, purple: 265, gray: 210,
};
const AIRTABLE_SHADES = {
  Light2: { s: 70, l: 90 },
  Light1: { s: 72, l: 80 },
  Bright: { s: 78, l: 48 },
  Dark1:  { s: 55, l: 30 },
};
function airtableColorToCss(colorSlug) {
  const m = colorSlug && colorSlug.match(/^([a-z]+)(Light2|Light1|Bright|Dark1)$/);
  if (!m) return null;
  const [, hue, shade] = m;
  const hDeg = AIRTABLE_HUES[hue];
  if (hDeg === undefined) return null;
  const { s, l } = AIRTABLE_SHADES[shade];
  const sat = hue === 'gray' ? Math.round(s / 6) : s;
  const textDark = shade === 'Light2' || shade === 'Light1';
  return { bg: `hsl(${hDeg}, ${sat}%, ${l}%)`, text: textDark ? '#1a1a1a' : '#ffffff' };
}

// Looks up the Airtable choice color for a single-select field's current
// value — factors out what render()'s selectColors computation already
// does inline, so the lineage canvas can reuse the exact same colors
// without duplicating the lookup.
function singleSelectSwatch(tableName, fieldName, value) {
  if (!value) return null;
  const field = (state.tables[tableName]?.fields || []).find(f => f.name === fieldName);
  const choice = field?.options?.choices?.find(c => c.name === value);
  return choice ? airtableColorToCss(choice.color) : null;
}

const state = {
  baseId: null,
  tables: {},
  activeTable: TARGET_TABLES[0],
  records: [],
  allDES: [],
  selectedDES: localStorage.getItem('higgtable_des') || '',
  activeStatuses: new Set(DEFAULT_STATUSES),
  statusOptions: [],
  selectedTask: null,
  pendingFiles: [],
  sortCol: null,
  sortDir: 'asc',
  dashboardView: (() => { try { return localStorage.getItem('higgtable_dash_view') === 'detailed' ? 'detailed' : 'compact'; } catch { return 'compact'; } })(),
  dashboardPreset: 'week', // 'week' | 'lastWeek' | 'month' | 'prevMonth' | 'quarter' | 'prevQuarter' | 'all' | 'custom'
  dashboardDes: '', // the load chart's designer ('' = everyone)
  dashboardCustomFrom: '',
  dashboardCustomTo: '',
  workloadTable: '',   // '' = all tables
  workloadProduct: '', // '' = all products (Project values)
  highlightRecordId: null,
  hiddenFields: JSON.parse(localStorage.getItem('higgtable_hidden_fields') || '{}'), // { tableName: [fieldName, ...] }
  selectedIds: new Set(), // multi-selected rows in the active table, for bulk actions
  selectionAnchorId: null, // last row touched by a plain/Cmd click, for Shift-click ranges
  workingDirectory: '', // folder searched by "Set Previews" for "<task>_1x1.png" files
  autoFixRatio: false, // crop off-ratio statics on add, without asking
  driveAccountIndex: '', // Google account index (drive.google.com/drive/u/N/...) for rewriting Drive links before opening; '' = no rewriting
};

let currentDetailRecord = null;
let currentDetailTable = null;

const recordsCache = {};
// Per table: { syncedAt, fullSyncedAt } (ms) of the records in recordsCache.
const tableSyncMeta = {};
const seenTaskIds = {};
const tablesInFlight = new Set(); // prevents duplicate concurrent fetches for the same table
const POLL_INTERVAL_MS = 5 * 60 * 1000;
// Upper bound on how often a partially-loaded table is redrawn while paging in.
const PROGRESS_RENDER_MS = 500;
let lastProgressRender = 0;
let progressRenderTimer = null;
let pollTimer = null;
let requestCounter = 0;

const SEEN_IDS_KEY = 'higgtable_seen_ids_v1';
const NOTIFICATIONS_KEY = 'higgtable_notifications_v1';
// Deadline alerts already raised, as deadlineAlertKey strings, so each task
// alerts once per deadline across restarts.
const DEADLINE_ALERTS_KEY = 'higgtable_deadline_alerts_v1';

// Returns { [tableName]: string[] } from the last session, or null if this
// is the first time the app has ever run (nothing persisted yet).
function loadPersistedSeenIds() {
  const raw = localStorage.getItem(SEEN_IDS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    log(`loadPersistedSeenIds: JSON.parse failed, discarding malformed data — ${err.message}`);
    return null;
  }
}

function persistSeenIds() {
  const out = {};
  TARGET_TABLES.forEach(name => {
    if (seenTaskIds[name]) out[name] = [...seenTaskIds[name]];
  });
  localStorage.setItem(SEEN_IDS_KEY, JSON.stringify(out));
}

function loadNotifications() {
  const raw = localStorage.getItem(NOTIFICATIONS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (err) {
    log(`loadNotifications: JSON.parse failed, discarding malformed data — ${err.message}`);
    return [];
  }
}

function persistNotifications() {
  localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifications));
}

// Surfaces anything assigned while the app was closed: diffs the seen-ID
// set persisted from the last session against what's now in recordsCache,
// per table, using the same DES filter a live poll already applies. Must
// run after tables are loaded (recordsCache populated) but before
// snapshotSeenIds() overwrites the persisted set with the fresh one.
function runColdStartCatchUp() {
  const persisted = loadPersistedSeenIds();
  if (!persisted) return; // first-ever run — no baseline, don't spam

  const missedEntries = TARGET_TABLES.flatMap(name => {
    const fresh = recordsCache[name] || [];
    return diffMissedRecords(persisted[name] || [], fresh, state.selectedDES)
      .map(r => recordToNotification(r, name, Date.now()));
  });
  if (!missedEntries.length) return;

  notifications = appendNotificationBatch(notifications, missedEntries);
  persistNotifications();
  renderNotificationBell();
  playNotificationSound();
  log(`runColdStartCatchUp: ${missedEntries.length} notification(s) for tasks assigned while closed`);
}

// ── Logging ─────────────────────────────────────────────────────────────
// Mirrors to DevTools console and to main's log file (visible from a
// packaged app via window.app.getLogPath()), so slow loads can be diagnosed
// after the fact instead of only while DevTools happens to be open.

function log(msg) {
  console.log(msg);
  window.app.log(msg).catch(() => {});
}

// Airtable returns records in creation order (oldest first), which buries
// the newest tasks on the last page. Reverse so newest shows first by default.
function newestFirst(records) {
  return records.slice().reverse();
}

// ── Date helpers (for the dashboard period filter) ─────────────────────────
// "Date Done" in Airtable is a plain YYYY-MM-DD string, so ISO strings
// compare correctly with plain < / > — no need to parse into Date objects
// for the actual filtering, only for computing the range boundaries.

function pad2(n) { return String(n).padStart(2, '0'); }
function toISO(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

function getDashboardRange() {
  return dashboardRange(state.dashboardPreset, toISO(new Date()),
    { from: state.dashboardCustomFrom, to: state.dashboardCustomTo });
}

// ── Boot ────────────────────────────────────────────────────────────────

async function boot() {
  log('boot: checking for API key');
  const settings = await window.app.getSettings();
  state.workingDirectory = settings.workingDirectory || '';
  refreshTaskFileIndex(true);
  state.autoFixRatio = settings.autoFixRatio === true;
  state.driveAccountIndex = settings.driveAccountIndex || '';
  state.driveRootFolderId = settings.driveRootFolderId || '';
  state.rcloneRemote = settings.rcloneRemote || '';
  const hasKey = await window.app.hasApiKey();
  if (!hasKey) {
    log('boot: no API key, showing settings modal');
    showSettingsModal(true);
    return;
  }
  await init();
}

async function init() {
  const t0 = Date.now();
  setStatus('Connecting...');
  try {
    log('init: fetching bases');
    const bases = await window.airtable.getBases();
    const base = bases.find(b => b.name === TARGET_BASE);
    if (!base) throw new Error(`Base "${TARGET_BASE}" not found`);
    state.baseId = base.id;
    log(`init: found base "${TARGET_BASE}" (${Date.now() - t0}ms elapsed)`);

    const tables = await window.airtable.getTables(state.baseId);
    TARGET_TABLES.forEach(name => {
      const t = tables.find(t => t.name === name);
      if (t) state.tables[name] = { id: t.id, fields: t.fields };
    });
    log(`init: resolved ${Object.keys(state.tables).length}/${TARGET_TABLES.length} target tables (${Date.now() - t0}ms elapsed)`);

    const firstTable = state.tables[TARGET_TABLES[0]];
    if (firstTable) {
      const sf = firstTable.fields.find(f => f.name === 'Status');
      if (sf && sf.options && sf.options.choices) {
        state.statusOptions = sf.options.choices.map(c => c.name);
      }
    }

    renderStatusChips();
    await primeFromDiskCache();
    await loadTable(state.activeTable);
    log(`init: active table ready (${Date.now() - t0}ms elapsed), syncing and preloading the rest in background`);
    // Tables shown from disk get their changes now; tables with no cache yet are
    // downloaded in full, as before.
    await Promise.all(TARGET_TABLES.filter(n => recordsCache[n] && tableSyncMeta[n]).map(async name => {
      tablesInFlight.add(name);
      try {
        await syncTable(name);
        if (state.activeTable === name) { state.records = recordsCache[name]; refreshDES(); render(); }
      } catch (err) {
        log(`init: sync of ${name} FAILED — ${err.message}`);
      } finally {
        tablesInFlight.delete(name);
      }
    }));
    maybeRefreshDashboard();
    await preloadOtherTables();
    log(`init: all tables preloaded, total init took ${Date.now() - t0}ms`);
    runColdStartCatchUp();
    checkDeadlineAlerts();
    snapshotSeenIds();
    startPolling();
    requestNotificationPermission();
  } catch (err) {
    log(`init: FAILED after ${Date.now() - t0}ms — ${err.message}`);
    if (err.message === 'NO_API_KEY' || err.message.includes('NO_API_KEY')) {
      showSettingsModal(true);
    } else {
      setStatus(`Error: ${err.message}`, true);
      document.getElementById('records-container').innerHTML = `<p class="empty error">${err.message}</p>`;
    }
  }
}

// ── Records ─────────────────────────────────────────────────────────────

// ── Disk cache + incremental sync ────────────────────────────────────────
// Records are kept on disk (main.js, userData/records-cache) so the app opens
// at once with the last known data; after that only records modified since the
// last sync are fetched. A full download still runs every 6 h and on refresh,
// since an incremental sync cannot see deleted records.

function recordsCacheKey(name) {
  return `${state.baseId}_${state.tables[name].id}`;
}

// Puts a table's records in place and writes them to disk. `startedAt` is when
// the fetch began: anything modified after it is picked up by the next sync.
// `persist: false` skips the disk write (an incremental sync that found
// nothing: the next start just asks for a slightly longer window).
function storeTable(name, records, { full = false, startedAt = Date.now(), persist = true } = {}) {
  recordsCache[name] = records;
  const meta = tableSyncMeta[name] || (tableSyncMeta[name] = {});
  meta.syncedAt = startedAt;
  if (full) meta.fullSyncedAt = startedAt;
  if (!meta.fullSyncedAt) return;
  if (!persist) {
    // Nothing changed: record only the sync time, for the Claude server's
    // "synced at" line (mcp-server.js), without rewriting the whole table.
    window.app.touchRecordsCache(recordsCacheKey(name), meta.syncedAt, name)
      .catch(err => log(`storeTable(${name}): sync-time write FAILED — ${err.message}`));
    return;
  }
  window.app.writeRecordsCache(recordsCacheKey(name), {
    v: RECORDS_CACHE_VERSION, tableId: state.tables[name].id, tableName: name,
    syncedAt: meta.syncedAt, fullSyncedAt: meta.fullSyncedAt, records,
  }).catch(err => log(`storeTable(${name}): cache write FAILED — ${err.message}`));
}

async function primeFromDiskCache() {
  const t0 = Date.now();
  await Promise.all(TARGET_TABLES.map(async name => {
    if (!state.tables[name] || recordsCache[name]) return;
    const payload = await window.app.readRecordsCache(recordsCacheKey(name)).catch(() => null);
    if (!usableCache(payload, state.tables[name].id)) return;
    recordsCache[name] = payload.records;
    tableSyncMeta[name] = { syncedAt: payload.syncedAt, fullSyncedAt: payload.fullSyncedAt };
  }));
  const loaded = TARGET_TABLES.filter(n => recordsCache[n]);
  log(`primeFromDiskCache: ${loaded.length} table(s) from disk in ${Date.now() - t0}ms`);
}

// Brings one table up to date: only the changes when possible, else a full
// download. Returns the fresh list, or null on failure (cache left as it was).
async function syncTable(name) {
  const info = state.tables[name];
  if (!info) return null;
  const startedAt = Date.now();
  const since = recordsCache[name] ? incrementalSince(tableSyncMeta[name], startedAt) : null;
  if (!since) {
    const records = newestFirst(await window.airtable.getRecords(state.baseId, info.id));
    storeTable(name, records, { full: true, startedAt });
    log(`syncTable: ${name} — full, ${records.length} records in ${Date.now() - startedAt}ms`);
    return records;
  }
  const changed = await window.airtable.getRecords(state.baseId, info.id, undefined, since);
  const { records, added } = mergeChangedRecords(recordsCache[name], changed);
  storeTable(name, records, { startedAt, persist: changed.length > 0 });
  log(`syncTable: ${name} — ${changed.length} changed (${added.length} new) in ${Date.now() - startedAt}ms`);
  return records;
}

async function loadTable(tableName) {
  state.activeTable = tableName;
  clearTaskSelection();
  state.selectedIds.clear();
  updateBulkActionsBar();

  const tableInfo = state.tables[tableName];
  if (!tableInfo) {
    document.getElementById('records-container').innerHTML = `<p class="empty error">Table "${tableName}" not found</p>`;
    setStatus(`Table "${tableName}" not found`, true);
    return;
  }

  if (recordsCache[tableName]) {
    state.records = recordsCache[tableName];
    refreshDES();
    render();
    setStatus(`${state.records.length} records (cached)`);
    log(`loadTable(${tableName}): served ${state.records.length} records from cache`);
    return;
  }

  if (tablesInFlight.has(tableName)) {
    // A fetch for this table is already running (e.g. the user switched away
    // and back before it finished). Don't start a second one — that would
    // race the first and make the record count/rows flicker between two
    // independent in-progress datasets. The original fetch's progress
    // handler re-matches state.activeTable on its next page and takes over.
    log(`loadTable(${tableName}): fetch already in progress, waiting for it instead of starting another`);
    document.getElementById('records-container').innerHTML = '<p class="empty">Loading...</p>';
    setStatus(`Loading ${tableName}...`);
    return;
  }

  document.getElementById('records-container').innerHTML = '<p class="empty">Loading...</p>';
  setStatus(`Loading ${tableName}...`);
  const t0 = Date.now();
  log(`loadTable(${tableName}): cache miss, fetching from Airtable`);
  showProgressBar();
  setRefreshBusy(true);
  tablesInFlight.add(tableName);

  const requestId = ++requestCounter;
  let partial = [];
  const unsubscribe = window.airtable.onRecordsProgress(({ requestId: rid, tableId, newRecords, totalSoFar, page }) => {
    if (rid !== requestId || tableId !== tableInfo.id || state.activeTable !== tableName) return;
    // Append at the bottom during loading so already-visible rows don't
    // reflow on every page; the whole list gets reversed to newest-first
    // once in a single pass when the fetch completes (below).
    partial = partial.concat(newRecords);
    state.records = partial;
    setStatus(`Loading ${tableName}... ${totalSoFar} records so far (page ${page})`);
    // Rendering on EVERY page redrew a table that grows toward its full size, so
    // a 9.7k-record load did ~98 renders averaging ~4.9k rows — quadratic work
    // that also blocked the renderer while further pages arrived. Coalesce to at
    // most one render per PROGRESS_RENDER_MS; the final render below is what
    // guarantees the complete list is shown.
    const now = Date.now();
    if (now - lastProgressRender >= PROGRESS_RENDER_MS) {
      lastProgressRender = now;
      refreshDES();
      render();
    } else if (!progressRenderTimer) {
      progressRenderTimer = setTimeout(() => {
        progressRenderTimer = null;
        lastProgressRender = Date.now();
        if (state.activeTable === tableName) { refreshDES(); render(); }
      }, PROGRESS_RENDER_MS);
    }
  });

  try {
    const records = newestFirst(await window.airtable.getRecords(state.baseId, tableInfo.id, requestId));
    log(`loadTable(${tableName}): fetched ${records.length} records in ${Date.now() - t0}ms`);
    // Guard: user may have switched tabs while this fetch was in flight
    if (state.activeTable !== tableName) {
      storeTable(tableName, records, { full: true, startedAt: t0 });
      log(`loadTable(${tableName}): tab changed mid-fetch, caching only`);
      return;
    }
    storeTable(tableName, records, { full: true, startedAt: t0 });
    state.records = records;
    refreshDES();
    render();
  } catch (err) {
    log(`loadTable(${tableName}): FAILED after ${Date.now() - t0}ms — ${err.message}`);
    if (state.activeTable !== tableName) return;
    document.getElementById('records-container').innerHTML = `<p class="empty error">${err.message}</p>`;
    setStatus(`Error: ${err.message}`, true);
  } finally {
    unsubscribe();
    // Drop any pending coalesced render: the final render above already drew the
    // complete list, so a trailing one would only redraw it.
    if (progressRenderTimer) { clearTimeout(progressRenderTimer); progressRenderTimer = null; }
    hideProgressBar();
    setRefreshBusy(false);
    tablesInFlight.delete(tableName);
  }
}

// Forces a fresh fetch of one table, bypassing the cache. Used by the
// per-table refresh button and by the dashboard's "refresh all" button.
async function refreshTableData(name) {
  const info = state.tables[name];
  if (!info || tablesInFlight.has(name)) return;
  delete recordsCache[name];
  if (state.activeTable === name) {
    await loadTable(name);
    return;
  }
  const t0 = Date.now();
  tablesInFlight.add(name);
  try {
    storeTable(name, newestFirst(await window.airtable.getRecords(state.baseId, info.id)), { full: true, startedAt: t0 });
    log(`refreshTableData: ${name} — ${recordsCache[name].length} records in ${Date.now() - t0}ms`);
  } catch (err) {
    log(`refreshTableData: ${name} — FAILED after ${Date.now() - t0}ms — ${err.message}`);
  } finally {
    tablesInFlight.delete(name);
  }
}

async function preloadOtherTables() {
  // Runs concurrently across tables — airtable.js now caps actual in-flight
  // HTTP requests network-wide (see MAX_CONCURRENT_REQUESTS), so multiple
  // tables can each make progress on their own pagination at once without
  // bursting past Airtable's per-base rate limit. This used to be a
  // sequential for-loop for that exact safety reason; the limiter now lives
  // one layer down, so several tables loading side by side is safe.
  const names = TARGET_TABLES.filter(name => name !== state.activeTable && !recordsCache[name] && !tablesInFlight.has(name));
  await Promise.all(names.map(async name => {
    const info = state.tables[name];
    if (!info) return;
    const t0 = Date.now();
    tablesInFlight.add(name);
    try {
      storeTable(name, newestFirst(await window.airtable.getRecords(state.baseId, info.id)), { full: true, startedAt: t0 });
      log(`preloadOtherTables: ${name} — ${recordsCache[name].length} records in ${Date.now() - t0}ms`);
      maybeRefreshDashboard();
    } catch (err) {
      log(`preloadOtherTables: ${name} — FAILED after ${Date.now() - t0}ms — ${err.message}`);
    } finally {
      tablesInFlight.delete(name);
    }
  }));
}

// ── Auto-refresh & notifications ──────────────────────────────────────────

function snapshotSeenIds() {
  TARGET_TABLES.forEach(name => {
    if (recordsCache[name]) seenTaskIds[name] = new Set(recordsCache[name].map(r => r.id));
  });
  persistSeenIds();
}

// A fixed 5-minute setInterval was fine while a full refresh took seconds. Once
// the four tables grew to ~16k records a cycle took 16+ MINUTES, so cycles ran
// essentially back-to-back — the app spent ~85% of its life re-downloading
// everything, and every table the user opened queued behind ~160 requests
// (MAX_CONCURRENT_REQUESTS is 3, network-wide). Self-scheduling after the cycle
// FINISHES, resting at least as long as the cycle took, keeps the duty cycle at
// or below half and makes runaway impossible however large the data grows.
function startPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  scheduleNextPoll(POLL_INTERVAL_MS);
}

function scheduleNextPoll(delayMs) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    const started = Date.now();
    try {
      await pollForUpdates();
    } finally {
      const took = Date.now() - started;
      const rest = Math.max(POLL_INTERVAL_MS, took);
      if (took > POLL_INTERVAL_MS) {
        log(`scheduleNextPoll: cycle took ${Math.round(took / 1000)}s — resting ${Math.round(rest / 1000)}s before the next one`);
      }
      scheduleNextPoll(rest);
    }
  }, delayMs);
}

function requestNotificationPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

let pollInFlight = false;
async function pollForUpdates() {
  if (!state.baseId) return;
  if (pollInFlight) { log('pollForUpdates: skipped, previous cycle still running'); return; }
  pollInFlight = true;
  const t0 = Date.now();
  log('pollForUpdates: starting 5-minute refresh cycle');
  try {
    await pollAllTables();
    checkDeadlineAlerts();
    log(`pollForUpdates: cycle finished in ${Date.now() - t0}ms`);
  } finally {
    pollInFlight = false;
  }
}

async function pollAllTables() {
  // Runs concurrently across tables — see preloadOtherTables for why this
  // is safe (airtable.js caps real in-flight HTTP requests network-wide).
  await Promise.all(TARGET_TABLES.map(name => pollOneTable(name)));
}

async function pollOneTable(name) {
  const info = state.tables[name];
  if (!info) return;
  if (tablesInFlight.has(name)) {
    log(`pollAllTables: ${name} — skipped, a fetch is already in progress elsewhere`);
    return;
  }
  let fresh;
  const t0 = Date.now();
  tablesInFlight.add(name);
  try {
    fresh = await syncTable(name);
    if (!fresh) return;
    log(`pollAllTables: ${name} — ${fresh.length} records in ${Date.now() - t0}ms`);
  } catch (err) {
    log(`pollAllTables: ${name} — FAILED after ${Date.now() - t0}ms — ${err.message}`);
    return; // leave cache/seen set untouched; retry next cycle
  } finally {
    tablesInFlight.delete(name);
  }

  const prevSeen = seenTaskIds[name];
  if (prevSeen && state.selectedDES) {
    fresh
      .filter(r => !prevSeen.has(r.id) && (r.fields['DES'] || '') === state.selectedDES)
      .forEach(r => { notifyNewTask(r, name); addLiveNotification(r, name); });
  }
  seenTaskIds[name] = new Set(fresh.map(r => r.id));
  persistSeenIds();
  maybeRefreshDashboard();

  if (state.activeTable === name) {
    state.records = fresh;
    refreshDES();
    render();
  }
}

function notifyNewTask(rec, tableName) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const shortTable = tableName.replace(' Creatives', '');
  const n = new Notification('New task assigned', {
    body: `${rec.fields['Name'] || 'Untitled task'} (${shortTable})`,
  });
  n.onclick = () => { window.focus(); goToRecord(rec, tableName); };
}

// ── In-app notification bell ───────────────────────────────────────────
// Runs alongside notifyNewTask's OS banner (unchanged, above) — this adds
// a persistent, sound-backed, in-app history so a missed/dismissed OS
// banner isn't the only record a new task ever existed.

const MUTE_KEY = 'higgtable_notify_muted';
let notifications = loadNotifications();
let notifyDropdownOpen = false;

function isNotificationsMuted() {
  return localStorage.getItem(MUTE_KEY) === 'true';
}

function toggleMute() {
  const next = !isNotificationsMuted();
  localStorage.setItem(MUTE_KEY, String(next));
  document.getElementById('notify-mute-btn').classList.toggle('muted', next);
}

// Synthesizes short tones via the Web Audio API — no bundled audio asset to
// ship or license. No-ops while muted.
function playTones(freqs, { type = 'sine', step = 0.09, length = 0.18 } = {}) {
  if (isNotificationsMuted()) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const now = ctx.currentTime;
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = type;
    const start = now + i * step;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + length + 0.02);
  });
  setTimeout(() => ctx.close(), (freqs.length * step + length) * 1000 + 300);
}

// New task: a rising two-tone chime.
function playNotificationSound() {
  playTones([880, 1320]);
}

// Deadline alert: a different, more insistent pattern (three repeated
// triangle-wave beeps, falling) so it can't be mistaken for a new task.
function playDeadlineSound() {
  playTones([1046, 1046, 784], { type: 'triangle', step: 0.16, length: 0.12 });
}

function renderNotificationBell() {
  const badge = document.getElementById('notify-badge');
  const count = unreadCount(notifications);
  badge.textContent = String(count);
  badge.classList.toggle('hidden', count === 0);
}

function renderNotificationDropdown() {
  const listEl = document.getElementById('notify-dropdown-list');
  const emptyEl = document.getElementById('notify-dropdown-empty');
  emptyEl.classList.toggle('hidden', notifications.length > 0);
  listEl.innerHTML = '';
  const today = toISO(new Date());
  const DEADLINE_LABELS = { overdue: 'Overdue', today: 'Due today', tomorrow: 'Due tomorrow' };
  notifications.forEach(n => {
    const liveRec = (recordsCache[n.tableName] || []).find(r => r.id === n.recordId);
    const { priority, deadline, urgency, isUrgent } = resolveNotificationBadges(n, liveRec, today);
    const btn = document.createElement('button');
    const isDeadlineAlert = n.kind === 'deadline';
    btn.className = `notify-item${n.read ? ' read' : ''}${isUrgent ? ' urgent' : ''}${isDeadlineAlert ? ' deadline-alert' : ''}`;
    const shortTable = n.tableName.replace(' Creatives', '');
    const timeSpan = document.createElement('span');
    timeSpan.className = 'notify-item-time';
    timeSpan.textContent = new Date(n.timestamp).toLocaleString();
    btn.appendChild(timeSpan);
    if (isDeadlineAlert) {
      const title = document.createElement('span');
      title.className = 'notify-alert-title';
      title.innerHTML = iconSvg('clock');
      title.append(`Deadline approaching — ${deadlineAlertLabel(deadline, today) || 'no deadline now'}`);
      btn.appendChild(title);
    }
    btn.appendChild(document.createTextNode(n.taskName));
    if (priority) {
      const priorityPill = document.createElement('span');
      priorityPill.className = 'select-pill';
      priorityPill.textContent = priority;
      const swatch = singleSelectSwatch(n.tableName, 'Priority', priority);
      if (swatch) { priorityPill.style.background = swatch.bg; priorityPill.style.color = swatch.text; }
      btn.appendChild(priorityPill);
    }
    if (DEADLINE_LABELS[urgency] && !isDeadlineAlert) {
      const deadlineSpan = document.createElement('span');
      deadlineSpan.className = `notify-deadline ${urgency}`;
      deadlineSpan.textContent = DEADLINE_LABELS[urgency];
      btn.appendChild(deadlineSpan);
    }
    const tableSpan = document.createElement('span');
    tableSpan.className = 'notify-item-table';
    tableSpan.textContent = shortTable;
    btn.appendChild(tableSpan);
    btn.addEventListener('click', () => {
      const rec = (recordsCache[n.tableName] || []).find(r => r.id === n.recordId);
      if (!rec) {
        btn.textContent = 'This task is no longer available.';
        return;
      }
      toggleNotificationDropdown();
      goToRecord(rec, n.tableName);
    });
    listEl.appendChild(btn);
  });
}

function toggleNotificationDropdown() {
  notifyDropdownOpen = !notifyDropdownOpen;
  document.getElementById('notify-dropdown').classList.toggle('hidden', !notifyDropdownOpen);
  if (notifyDropdownOpen) {
    notifications = markAllRead(notifications);
    persistNotifications();
    renderNotificationBell();
    renderNotificationDropdown();
  }
}

function addLiveNotification(rec, tableName) {
  notifications = appendNotification(notifications, recordToNotification(rec, tableName, Date.now()));
  persistNotifications();
  renderNotificationBell();
  if (notifyDropdownOpen) renderNotificationDropdown();
  playNotificationSound();
}

function loadDeadlineAlertKeys() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DEADLINE_ALERTS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    log(`loadDeadlineAlertKeys: JSON.parse failed, discarding malformed data — ${err.message}`);
    return [];
  }
}

// Raises a deadline alert for each of the selected designer's unfinished tasks
// due in 1-2 days, once per task per deadline. Runs after the initial load,
// after every poll cycle (which also catches a task crossing into the window
// overnight), and when the designer picker changes.
// Removes deadline alerts whose task has since moved to To accept or Done.
// Runs on every poll (via checkDeadlineAlerts) and after the bulk status buttons.
function pruneCompletedDeadlineAlerts() {
  const kept = dropCompletedDeadlineAlerts(notifications,
    n => (recordsCache[n.tableName] || []).find(r => r.id === n.recordId));
  if (kept.length === notifications.length) return;
  notifications = kept;
  persistNotifications();
  renderNotificationBell();
  renderNotificationDropdown();
}

function checkDeadlineAlerts() {
  pruneCompletedDeadlineAlerts();
  if (!state.selectedDES) return;
  const today = toISO(new Date());
  const keys = pruneDeadlineAlertKeys(loadDeadlineAlertKeys(), today);
  const alerted = new Set(keys);
  const found = TARGET_TABLES.flatMap(name =>
    findDeadlineAlerts(recordsCache[name] || [], name, state.selectedDES, today, alerted));
  localStorage.setItem(DEADLINE_ALERTS_KEY, JSON.stringify([...keys, ...found.map(a => a.key)]));
  if (!found.length) return;

  const now = Date.now();
  notifications = appendNotificationBatch(notifications,
    found.map(a => recordToDeadlineAlert(a.rec, a.tableName, now, a.daysAway)));
  persistNotifications();
  renderNotificationBell();
  if (notifyDropdownOpen) renderNotificationDropdown();
  playDeadlineSound();
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const first = found[0];
    const n = new Notification(found.length === 1 ? 'Deadline approaching' : `${found.length} deadlines approaching`, {
      body: found.map(a => `${a.rec.fields['Name'] || 'Untitled task'} — ${deadlineAlertLabel(a.rec.fields['Deadline'], today)}`).join('\n'),
    });
    n.onclick = () => { window.focus(); goToRecord(first.rec, first.tableName); };
  }
  log(`checkDeadlineAlerts: ${found.length} alert(s) for ${state.selectedDES}`);
}

// Jumps straight to a specific record from a notification click: switches to
// its table, makes sure its Status chip is active (so it isn't hidden by the
// current filter), and highlights + scrolls to the row once rendered.
function goToRecord(rec, tableName) {
  hideDashboard();
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const tabBtn = document.querySelector(`.tab[data-table="${tableName.replace(/"/g, '\\"')}"]`);
  if (tabBtn) tabBtn.classList.add('active');

  const status = rec.fields['Status'] || '';
  if (status && !state.activeStatuses.has(status)) {
    state.activeStatuses.add(status);
    renderStatusChips();
  }

  state.highlightRecordId = rec.id;
  if (state.activeTable === tableName && recordsCache[tableName]) {
    render();
  } else {
    loadTable(tableName);
  }
}

function refreshDES() {
  const desSet = new Set(state.records.map(r => r.fields['DES']).filter(Boolean));
  state.allDES = [...desSet].sort();
  renderDESPicker();
}

// ── Render ──────────────────────────────────────────────────────────────

// Table and board order: Priority, then Deadline, then the chosen column
// (Name by default).
function compareForList(a, b) {
  const pa = PRIORITY_RANK[a.fields['Priority']] ?? 3;
  const pb = PRIORITY_RANK[b.fields['Priority']] ?? 3;
  if (pa !== pb) return pa - pb;

  const da = a.fields['Deadline'] || '';
  const db = b.fields['Deadline'] || '';
  if (da !== db) return !da ? 1 : !db ? -1 : (da < db ? -1 : 1);

  const col = state.sortCol || 'Name';
  const dir = state.sortCol ? state.sortDir : 'asc';
  const cmp = String(a.fields[col] || '').localeCompare(String(b.fields[col] || ''));
  return dir === 'asc' ? cmp : -cmp;
}

function render() {
  document.getElementById('status-filters').classList.toggle('board-mode', state.view === 'board');
  document.querySelectorAll('#view-toggle button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  if (state.view === 'board') { renderBoard(); return; }
  const filtered = state.records.filter(r => {
    const des = r.fields['DES'] || '';
    const status = r.fields['Status'] || '';
    return (!state.selectedDES || des === state.selectedDES)
      && (state.activeStatuses.size === 0 || state.activeStatuses.has(status));
  });

  // Base sort is always Priority, then Deadline — the user's chosen column
  // (Name by default) only breaks ties within that.
  filtered.sort(compareForList);

  const container = document.getElementById('records-container');
  if (!filtered.length) {
    container.innerHTML = '<p class="empty">No records match the current filters.</p>';
    setStatus('0 records');
    updateBulkActionsBar();
    return;
  }

  const tableFields = state.tables[state.activeTable]?.fields || [];
  const fieldNames = tableFields.map(f => f.name);
  const hiddenCols = new Set(state.hiddenFields[state.activeTable] || []);
  const cols = COLUMNS.filter(c => fieldNames.includes(c) && !hiddenCols.has(c));

  // Priority and Status get a colored pill using that field's own Airtable
  // choice colors — kept to just these two so the table doesn't turn into
  // a wall of colored badges for every select column (Branch, Size, etc.).
  const PILL_COLUMNS = new Set(['Priority', 'Status']);
  const selectColors = {};
  tableFields.forEach(f => {
    if (f.type !== 'singleSelect' || !PILL_COLUMNS.has(f.name)) return;
    const map = {};
    (f.options?.choices || []).forEach(c => { map[c.name] = c.color; });
    selectColors[f.name] = map;
  });

  const table = document.createElement('table');
  const hr = table.createTHead().insertRow();

  const showReady = !!taskFileIndex;
  const readyFieldNames = readinessFieldNames();
  ['#', '', ...cols, ...(showReady ? ['Ready'] : [])].forEach(name => {
    const th = document.createElement('th');
    if (name === '') {
      th.className = 'thumb-head';
    } else if (name === '#' || name === 'Ready') {
      th.textContent = name;
      if (name === 'Ready') th.title = 'What is left before this task can be handed in (files in the working directory + fields)';
    } else {
      const isSorted = state.sortCol === name;
      th.textContent = name + (isSorted ? (state.sortDir === 'asc' ? ' ↑' : ' ↓') : '');
      th.style.cursor = 'pointer';
      th.title = `Sort by ${name}`;
      th.onclick = () => {
        if (state.sortCol === name) {
          state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortCol = name;
          state.sortDir = 'asc';
        }
        render();
      };
    }
    hr.appendChild(th);
  });

  const tbody = table.createTBody();
  let highlightedRow = null;
  // Packs (tasks from one parent on one day) read as one block: a stronger
  // line above and below, and a thin accent bar down the left edge.
  const packs = packLayout(filtered);
  const multiSelected = state.selectedIds.size > 1;
  table.classList.toggle('multi-select', multiSelected);
  const colCount = 2 + cols.length + (showReady ? 1 : 0);
  filtered.forEach((rec, i) => {
    const pack = packs[i];
    if (pack.size > 1 && pack.index === 0) {
      renderPackHeader(tbody, filtered.slice(i, i + pack.size), colCount);
    }
    if (pack.size > 1 && collapsedPacks.has(packKey(rec))) return;
    const tr = tbody.insertRow();
    if (pack.size > 1) {
      tr.classList.add('in-pack');
      if (pack.index === 0) tr.classList.add('pack-first');
      if (pack.index === pack.size - 1) tr.classList.add('pack-last');
    }
    if (state.selectedTask && state.selectedTask.id === rec.id) tr.classList.add('selected');
    if (state.selectedIds.has(rec.id)) tr.classList.add('bulk-selected');
    if (state.highlightRecordId === rec.id) {
      tr.classList.add('highlight-flash');
      highlightedRow = tr;
    }
    tr.onclick = e => onRowClick(rec, tr, e, i, filtered);
    tr.ondblclick = () => openRecordModal(rec, state.activeTable);

    const tdN = tr.insertCell();
    // With several rows selected each one shows a check instead of its number,
    // so the selection reads at a glance; the focused row stays brighter.
    if (multiSelected && state.selectedIds.has(rec.id)) {
      tdN.innerHTML = iconSvg('check');
      tdN.className = 'sel-check';
    } else {
      tdN.textContent = i + 1;
    }
    const tdThumb = tr.insertCell();
    tdThumb.className = 'thumb-cell';
    tdThumb.append(previewElement(rec, 'small', pending => {
      const ph = document.createElement('span');
      ph.className = `thumb-ph${pending ? ' pending' : ''}`;
      ph.innerHTML = iconSvg(FORMAT_ICONS[rec.fields['Format']] || 'image');
      if (pending) ph.title = 'Preview link expired, loading a fresh one…';
      return ph;
    }));
    cols.forEach(col => {
      const td = tr.insertCell();
      const val = rec.fields[col];
      if (selectColors[col] && val) {
        const pill = document.createElement('span');
        pill.className = 'select-pill';
        pill.textContent = val;
        const swatch = airtableColorToCss(selectColors[col][val]);
        if (swatch) { pill.style.background = swatch.bg; pill.style.color = swatch.text; }
        td.appendChild(pill);
        return;
      }
      td.textContent = val == null ? '' : Array.isArray(val) ? val.join(', ') : String(val);
      if (col === 'Name') {
        const format = rec.fields['Format'] || '';
        td.title = format ? `${val || ''}\n${format}` : String(val || '');
        td.classList.add('name-cell');
      }
    });
    if (showReady) {
      const td = tr.insertCell();
      const r = readinessFor(rec, readyFieldNames);
      if (r) {
        td.textContent = r.promote ? `⚠ ${r.warning}` : readinessLabel(r);
        td.className = `ready-cell ${r.handedIn ? 'muted' : r.ready && !r.promote ? 'ok' : 'warn'}`;
        td.title = r.handedIn ? '' : [r.warning, ...r.missing.map(i => i.label)].filter(Boolean).join('\n');
      }
    }
  });

  container.innerHTML = '';
  container.appendChild(table);
  state.visibleRecords = filtered;
  setStatus(`${filtered.length} of ${state.records.length} records`);
  updateBulkActionsBar();
  renderTaskPanel();

  if (state.highlightRecordId) {
    if (highlightedRow) highlightedRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    state.highlightRecordId = null; // one-shot — don't replay on the next unrelated render
  }
}

// ── Board view ───────────────────────────────────────────────────────────
// The active table's tasks as cards in workflow columns. The status chips do
// not apply here (the columns are the statuses); the designer picker does.
// Dragging cards to another column changes their Status, with Undo.
const BOARD_STATUSES = ['Rework', 'Ready for Design', 'In work', 'To accept'];
const BOARD_CARD_LIMIT = 150;

function renderBoard() {
  const statuses = BOARD_STATUSES.filter(s => !state.statusOptions.length || state.statusOptions.includes(s));
  const recs = state.records
    .filter(r => (!state.selectedDES || (r.fields['DES'] || '') === state.selectedDES)
      && statuses.includes(r.fields['Status'] || ''))
    .sort(compareForList);
  const byStatus = new Map(statuses.map(s => [s, []]));
  recs.forEach(r => byStatus.get(r.fields['Status']).push(r));
  // Tasks of one pack sit together under a pack header, in each column.
  const groupsByStatus = new Map(statuses.map(s => [s, groupIntoPacks(byStatus.get(s))]));
  const ordered = statuses.flatMap(s => groupsByStatus.get(s).flatMap(g => g.records));
  const today = toISO(new Date());

  const board = document.createElement('div');
  board.id = 'board';
  statuses.forEach(status => {
    const list = byStatus.get(status);
    const col = document.createElement('section');
    col.className = 'board-col';
    col.dataset.status = status;
    const head = document.createElement('header');
    const title = document.createElement('span');
    title.className = 'board-col-title';
    title.textContent = status;
    const swatch = singleSelectSwatch(state.activeTable, 'Status', status);
    if (swatch) title.style.setProperty('--dot', swatch.bg);
    const count = document.createElement('span');
    count.className = 'board-col-count';
    count.textContent = list.length;
    head.append(title, count);
    const cards = document.createElement('div');
    cards.className = 'board-cards';
    let shown = 0;
    for (const group of groupsByStatus.get(status)) {
      if (shown >= BOARD_CARD_LIMIT) break;
      if (group.records.length > 1) {
        cards.append(boardPack(group.records, ordered, today));
      } else {
        cards.append(boardCard(group.records[0], ordered, today));
      }
      shown += group.records.length;
    }
    if (list.length > shown) {
      const more = document.createElement('div');
      more.className = 'board-more';
      more.textContent = `+${list.length - shown} more — use the table to see them all`;
      cards.append(more);
    }
    col.append(head, cards);
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drop-target'); });
    col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop-target'); });
    col.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('drop-target');
      let ids = [];
      try { ids = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (Array.isArray(ids) && ids.length) moveToStatus(ids, status);
    });
    board.append(col);
  });

  const container = document.getElementById('records-container');
  container.replaceChildren(board);
  state.visibleRecords = ordered;
  setStatus(`${recs.length} tasks on the board`);
  updateBulkActionsBar();
  renderTaskPanel();
}

// A pack in a board column: a compact header (fold, concept, parent, languages,
// day, ready k/N) over its cards. Clicking the header selects the pack like the
// table's pack header; dragging it moves the whole pack to another column.
function boardPack(members, ordered, today) {
  const key = packKey(members[0]);
  const collapsed = collapsedPacks.has(key);
  const ids = members.map(r => r.id);
  const allSelected = ids.every(id => state.selectedIds.has(id));
  const wrap = document.createElement('div');
  wrap.className = `board-pack${collapsed ? ' collapsed' : ''}${allSelected ? ' selected-pack' : ''}`;

  const head = document.createElement('div');
  head.className = 'board-pack-head';
  head.draggable = true;
  head.title = 'Click to select the pack · drag to move the whole pack';
  const toggle = document.createElement('button');
  toggle.className = 'pack-toggle';
  toggle.title = collapsed ? 'Show the tasks in this pack' : 'Fold this pack';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.innerHTML = iconSvg('down');
  toggle.onclick = e => {
    e.stopPropagation();
    collapsed ? collapsedPacks.delete(key) : collapsedPacks.add(key);
    render();
  };
  const sum = packSummary(members);
  const label = document.createElement('span');
  label.className = 'board-pack-label';
  const strong = document.createElement('strong');
  strong.textContent = sum.concept || 'Pack';
  const meta = document.createElement('span');
  meta.className = 'pack-meta';
  meta.textContent = [
    sum.parent && `from ${sum.parent}`,
    sum.languages.length && sum.languages.join(' '),
    sum.date && `${sum.date.slice(8, 10)}.${sum.date.slice(5, 7)}`,
  ].filter(Boolean).join(' · ');
  label.append(strong, meta);
  label.title = `${sum.concept || 'Pack'} · ${meta.textContent} · ${members.length} tasks`;
  const count = document.createElement('span');
  count.className = 'board-pack-count';
  if (taskFileIndex) {
    const ready = members.filter(r => readinessFor(r)?.ready).length;
    count.textContent = `${ready}/${members.length} ready`;
    count.classList.toggle('ok', ready === members.length);
  } else {
    count.textContent = `${members.length} tasks`;
  }
  head.append(toggle, label, count);
  head.onclick = e => selectPack(members, e);
  head.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    wrap.classList.add('dragging');
  });
  head.addEventListener('dragend', () => wrap.classList.remove('dragging'));
  wrap.append(head);

  if (!collapsed) {
    const body = document.createElement('div');
    body.className = 'board-pack-cards';
    members.forEach(rec => body.append(boardCard(rec, ordered, today)));
    wrap.append(body);
  }
  return wrap;
}

// Selects every task of a pack (Cmd/Ctrl adds it to the selection).
function selectPack(members, e) {
  const ids = members.map(r => r.id);
  if (!(e.metaKey || e.ctrlKey)) state.selectedIds.clear();
  ids.forEach(id => state.selectedIds.add(id));
  state.selectionAnchorId = ids[0];
  state.selectionCursorId = ids[ids.length - 1];
  state.selectedTask = members[0];
  render();
}

function boardCard(rec, ordered, today) {
  const card = document.createElement('article');
  card.className = 'board-card';
  card.draggable = true;
  if (state.selectedIds.has(rec.id)) card.classList.add('bulk-selected');
  if (state.selectedTask && state.selectedTask.id === rec.id) card.classList.add('selected');

  const thumb = document.createElement('div');
  thumb.className = 'board-thumb';
  thumb.append(previewElement(rec, 'large', pending => {
    const ph = document.createElement('span');
    ph.className = `thumb-ph${pending ? ' pending' : ''}`;
    ph.innerHTML = iconSvg(FORMAT_ICONS[rec.fields['Format']] || 'image');
    return ph;
  }));
  const body = document.createElement('div');
  body.className = 'board-card-body';
  const name = document.createElement('div');
  name.className = 'board-card-name';
  name.textContent = rec.fields['Name'] || 'Untitled task';
  name.title = rec.fields['Name'] || '';
  const meta = document.createElement('div');
  meta.className = 'board-card-meta';
  const pr = rec.fields['Priority'];
  if (pr) {
    const pill = document.createElement('span');
    pill.className = 'select-pill';
    pill.textContent = pr;
    const sw = singleSelectSwatch(state.activeTable, 'Priority', pr);
    if (sw) { pill.style.background = sw.bg; pill.style.color = sw.text; }
    meta.append(pill);
  }
  const deadline = rec.fields['Deadline'];
  if (deadline && rec.fields['Status'] !== 'To accept') {
    const days = daysUntilDeadline(deadline, today);
    const chip = document.createElement('span');
    chip.className = `deadline-chip ${days < 0 ? 'overdue' : days <= 1 ? 'soon' : ''}`;
    chip.innerHTML = iconSvg('clock');
    chip.append(deadlineAlertLabel(deadline, today));
    chip.title = deadline;
    meta.append(chip);
  }
  if (rec.fields['Type']) {
    const tag = document.createElement('span');
    tag.className = 'meta-tag';
    tag.textContent = rec.fields['Type'];
    meta.append(tag);
  }
  body.append(name, meta);
  card.append(thumb, body);

  card.onclick = e => onRowClick(rec, card, e, ordered.indexOf(rec), ordered);
  card.ondblclick = () => openRecordModal(rec, state.activeTable);
  card.addEventListener('dragstart', e => {
    const ids = state.selectedIds.has(rec.id) && state.selectedIds.size > 1 ? [...state.selectedIds] : [rec.id];
    e.dataTransfer.setData('text/plain', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  return card;
}

// Sets Status on the given tasks (a board drop), then offers Undo.
async function moveToStatus(ids, status) {
  const tableInfo = state.tables[state.activeTable];
  if (!tableInfo) return;
  const recs = ids.map(id => state.records.find(r => r.id === id)).filter(r => r && r.fields['Status'] !== status);
  if (!recs.length) return;
  const before = recs.map(r => ({ id: r.id, status: r.fields['Status'] || null }));
  try {
    const results = await window.airtable.updateRecords(state.baseId, tableInfo.id,
      recs.map(r => ({ id: r.id, fields: { Status: status } })));
    const byId = new Map(results.map(r => [r.id, r]));
    state.records.forEach(rec => {
      const updated = byId.get(rec.id);
      if (updated) rec.fields = updated.fields;
    });
    log(`moveToStatus: ${results.length} record(s) → ${status}`);
    pruneCompletedDeadlineAlerts();
    toast(`${results.length} task${results.length === 1 ? '' : 's'} → ${status}`, {
      action: { label: 'Undo', run: () => restoreStatuses(before) },
    });
    render();
    maybeRefreshDashboard();
  } catch (err) {
    toastError(`Could not move to ${status}: ${err.message}`);
  }
}

// The task's Preview image from Airtable ('small' ≈ 36 px, 'large' ≈ 512 px),
// or null when it has none.
function previewUrl(rec, size) {
  const att = (rec.fields['Preview'] || [])[0];
  if (!att) return null;
  return att.thumbnails?.[size]?.url || att.url || null;
}

// ── Preview links ──────────────────────────────────────────────────────────
// Airtable signs attachment links for 2-4 hours only, while records live in
// the disk cache and through incremental syncs much longer. So a Preview is
// never shown as a broken image: an expired link shows the placeholder and the
// record is fetched again in the background (batched, 50 per request), and a
// link that fails to load anyway does the same. Each record is retried at most
// every 5 minutes, so a really missing image cannot loop.

const PREVIEW_RETRY_MS = 5 * 60 * 1000;
const PREVIEW_BATCH = 50;
const previewRefreshQueue = new Map(); // table -> Set of record ids
const previewRefreshTried = new Map(); // record id -> when it was last asked for
let previewRefreshTimer = null;

// An <img> for the task's Preview, or the placeholder that `placeholder(pending)`
// builds (pending = a fresh link is on its way).
function previewElement(rec, size, placeholder, { lazy = true } = {}) {
  const url = previewUrl(rec, size);
  if (!url) return placeholder(false);
  if (previewNeedsRefresh(rec, Date.now())) {
    requestPreviewRefresh(rec);
    return placeholder(true);
  }
  const img = document.createElement('img');
  if (lazy) img.loading = 'lazy';
  img.alt = '';
  img.src = url;
  img.addEventListener('error', () => {
    img.replaceWith(placeholder(requestPreviewRefresh(rec)));
  }, { once: true });
  return img;
}

// Queues a record of the active table for a fresh copy. Returns whether it was
// queued (false while it was tried recently).
function requestPreviewRefresh(rec, { force = false } = {}) {
  const table = state.activeTable;
  if (!table || !state.tables[table] || !state.baseId) return false;
  const last = previewRefreshTried.get(rec.id);
  if (!force && last && Date.now() - last < PREVIEW_RETRY_MS) return false;
  previewRefreshTried.set(rec.id, Date.now());
  if (!previewRefreshQueue.has(table)) previewRefreshQueue.set(table, new Set());
  previewRefreshQueue.get(table).add(rec.id);
  clearTimeout(previewRefreshTimer);
  previewRefreshTimer = setTimeout(flushPreviewRefresh, 300);
  return true;
}

async function flushPreviewRefresh() {
  const jobs = [...previewRefreshQueue.entries()];
  previewRefreshQueue.clear();
  let fresh = 0;
  for (const [table, idSet] of jobs) {
    const ids = [...idSet];
    const list = recordsCache[table] || (table === state.activeTable ? state.records : null);
    if (!list) continue;
    for (let i = 0; i < ids.length; i += PREVIEW_BATCH) {
      try {
        const got = await window.airtable.getRecordsById(state.baseId, state.tables[table].id, ids.slice(i, i + PREVIEW_BATCH));
        // Only records already in the list: a deleted one is not brought back here.
        const known = new Set(list.map(r => r.id));
        mergeChangedRecords(list, got.filter(r => known.has(r.id)));
        fresh += got.length;
      } catch (err) {
        log(`flushPreviewRefresh: ${table} FAILED — ${err.message}`);
      }
    }
  }
  if (!fresh) return;
  log(`flushPreviewRefresh: fresh Preview links for ${fresh} record(s)`);
  render();
}

// Table or board, remembered on this computer.
const VIEW_KEY = 'higgtable_view';
state.view = (() => { try { return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'table'; } catch { return 'table'; } })();

// Packs the user folded away (by packKey), for this session.
const collapsedPacks = new Set();

// A pack's header row: fold toggle, what the pack is (concept, parent,
// languages, day, size) and, with the working directory indexed, how many of
// its tasks are ready. Clicking it selects the whole pack (Cmd/Ctrl-click adds
// it to the selection), so Finish or Autofill can run on the pack at once.
function renderPackHeader(tbody, members, colCount) {
  const key = packKey(members[0]);
  const collapsed = collapsedPacks.has(key);
  const ids = members.map(r => r.id);
  const allSelected = ids.every(id => state.selectedIds.has(id));
  const tr = tbody.insertRow();
  tr.className = `pack-header${collapsed ? ' collapsed' : ''}${allSelected ? ' selected-pack' : ''}`;
  const td = tr.insertCell();
  td.colSpan = colCount;

  const toggle = document.createElement('button');
  toggle.className = 'pack-toggle';
  toggle.title = collapsed ? 'Show the tasks in this pack' : 'Fold this pack';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.innerHTML = iconSvg('down');
  toggle.onclick = e => {
    e.stopPropagation();
    collapsed ? collapsedPacks.delete(key) : collapsedPacks.add(key);
    render();
  };

  const s = packSummary(members);
  const label = document.createElement('span');
  label.className = 'pack-label';
  const strong = document.createElement('strong');
  strong.textContent = s.concept || 'Pack';
  label.append(strong);
  const bits = [
    s.parent && `from ${s.parent}`,
    s.languages.length && s.languages.join(' '),
    s.date && `${s.date.slice(8, 10)}.${s.date.slice(5, 7)}`,
    `${s.count} tasks`,
  ].filter(Boolean);
  const meta = document.createElement('span');
  meta.className = 'pack-meta';
  meta.textContent = bits.join(' · ');
  label.append(meta);

  td.append(toggle, label);
  if (taskFileIndex) {
    const ready = members.filter(r => readinessFor(r)?.ready).length;
    const chip = document.createElement('span');
    chip.className = `pack-ready${ready === members.length ? ' ok' : ''}`;
    chip.textContent = `ready ${ready}/${members.length}`;
    td.append(chip);
  }
  const hint = document.createElement('span');
  hint.className = 'pack-select-hint';
  hint.textContent = allSelected ? 'Selected' : 'Click to select the pack';
  td.append(hint);

  tr.onclick = e => selectPack(members, e);
}

// ── Bulk actions ─────────────────────────────────────────────────────────

function updateBulkActionsBar() {
  const bar = document.getElementById('bulk-actions-bar');
  const count = state.selectedIds.size;
  bar.classList.toggle('inactive', count === 0);
  renderStepButtons(); // also writes the "N selected" count
}

// ── Readiness: files on disk + fields, for the step bar, Ready column, panel ──
// One walk of the working directory, refreshed on focus (at most every 30 s),
// after Resize/Compress/Autofill and when the folder changes.

let taskFileIndex = null;
let taskFileIndexAt = 0;
let taskFileIndexBusy = false;

async function refreshTaskFileIndex(force = false) {
  if (!state.workingDirectory || taskFileIndexBusy) return;
  if (!force && Date.now() - taskFileIndexAt < 30000) return;
  taskFileIndexBusy = true;
  try {
    taskFileIndex = buildFileIndex(await window.app.indexTaskFiles(state.workingDirectory));
    taskFileIndexAt = Date.now();
    render();
    renderTaskPanel();
  } catch (err) {
    log(`refreshTaskFileIndex: FAILED — ${err.message}`);
  } finally {
    taskFileIndexBusy = false;
  }
}

function readinessFieldNames() {
  const names = (state.tables[state.activeTable]?.fields || []).map(f => f.name);
  return {
    creativeLink: resolveFieldName(names, CREATIVE_LINK_FIELD) || CREATIVE_LINK_FIELD,
    figmaLink: resolveFieldName(names, FIGMA_LINK_FIELD) || FIGMA_LINK_FIELD,
  };
}

function readinessFor(rec, fieldNames = readinessFieldNames()) {
  if (!taskFileIndex || !rec.fields['Name']) return null;
  return taskReadiness(rec, taskFiles(stripAspectRatio(rec.fields['Name']), taskFileIndex), fieldNames);
}

const STEP_LABELS = { resize: 'Resize', compress: 'Compress', autofill: 'Autofill', accept: 'To Accept' };

// Each step button shows its name and, for the selection, what is left there.
// The first step with work left is outlined. Buttons busy with their own
// "Searching..." text are left alone until they finish.
function renderStepButtons() {
  const selected = state.records.filter(r => state.selectedIds.has(r.id));
  const fieldNames = readinessFieldNames();
  const list = selected.map(r => readinessFor(r, fieldNames)).filter(Boolean);
  const sum = list.length ? stepSummary(list) : null;
  const countEl = document.getElementById('bulk-actions-count');
  countEl.textContent = `${state.selectedIds.size} selected${sum && sum.warnings ? ` · ⚠ ${sum.warnings}` : ''}`;
  countEl.title = sum && sum.warnings
    ? `${sum.warnings} task${sum.warnings === 1 ? ' has' : 's have'} a newer After Effects render (_9x16_1.mp4) next to the master. Open the task to use it as the master.` : '';
  const statusText = {
    resize: sum && (sum.resize ? `${sum.resize} need sizes` : 'sizes ✓'),
    compress: sum && (sum.compress ? `${sum.compress} over 32 MB` : 'under 32 MB ✓'),
    autofill: sum && (sum.autofill
      ? `missing ${sum.autofillFields.slice(0, 2).join(', ')}${sum.autofillFields.length > 2 ? '…' : ''}`
      : 'filled ✓'),
    accept: sum && (sum.accept ? `${sum.accept} to hand in` : 'handed in ✓'),
  };
  document.querySelectorAll('#bulk-actions-bar .step-btn').forEach(btn => {
    if (btn.disabled) return;
    const step = btn.dataset.step;
    const name = document.createElement('span');
    name.className = 'step-name';
    name.textContent = STEP_LABELS[step];
    const status = document.createElement('span');
    status.className = 'step-status';
    status.textContent = statusText[step] || '';
    btn.replaceChildren(name, status);
    btn.classList.toggle('next', !!sum && sum.next === step);
    btn.classList.toggle('primary', step === 'accept' && !!sum && sum.next === 'accept');
  });
}

// ── Repeat renders (_9x16_1) ───────────────────────────────────────────────
// After Effects writes "<base>_9x16_1.mp4" when the master already exists, so a
// fresh render can sit next to a stale master. readiness-data.js finds them;
// here they are shown, and a newer one can replace the master (one rename).

async function promoteRepeat(repeat) {
  try {
    await window.app.promoteRepeatRender(repeat.path);
    log(`promoteRepeat: ${repeat.path} is now the master`);
    toast(`_9x16_${repeat.n}.mp4 is now the 9x16 master (the old master was replaced)`);
    await refreshTaskFileIndex(true);
    return true;
  } catch (err) {
    log(`promoteRepeat: FAILED — ${err.message}`);
    toastError(`Could not replace the master: ${err.message}`);
    return false;
  }
}

// A warning line for a readiness result with a repeat render, with a button to
// make the newer render the master. `after` runs once the master is replaced.
function repeatWarningEl(r, after) {
  const row = document.createElement('div');
  row.className = `repeat-warning${r.promote ? '' : ' mild'}`;
  row.innerHTML = iconSvg('warning');
  const text = document.createElement('span');
  text.textContent = r.promote
    ? `${r.warning}.mp4: the 9x16 master may be the old render`
    : `${r.warning}`;
  row.append(text);
  if (r.promote) {
    const btn = document.createElement('button');
    btn.textContent = `Use _9x16_${r.promote.n} as master`;
    btn.title = `Rename ${r.promote.name} over the 9x16 master, replacing it (no backup)`;
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      btn.disabled = true;
      if (await promoteRepeat(r.promote) && after) await after();
      btn.disabled = false;
    });
    row.append(btn);
  }
  return row;
}

// ── Side panel ───────────────────────────────────────────────────────────
// One click on a task shows its brief, files and fields here; the rename drop
// zone lives at its bottom. Double-click still opens the full field editor.

function renderTaskPanel() {
  const panel = document.getElementById('task-panel');
  const rec = state.selectedTask;
  // Several selected (Shift / Cmd-click): the panel lists the whole selection
  // with what each still needs, instead of only the first task.
  const multi = state.selectedIds.size > 1;
  panel.classList.toggle('hidden', !rec && !multi);
  document.getElementById('task-panel-multi').classList.toggle('hidden', !multi);
  document.getElementById('task-panel-body').classList.toggle('hidden', multi);
  document.getElementById('rename-panel').classList.toggle('hidden', multi || !rec);
  ['task-panel-folder-btn', 'task-panel-details-btn']
    .forEach(id => document.getElementById(id).classList.toggle('hidden', multi));
  if (multi) { renderTaskPanelSelection(); return; }
  if (!rec) return;
  const name = rec.fields['Name'] || '';
  document.getElementById('task-panel-title').textContent = name;
  document.getElementById('task-panel-title').title = name;
  const description = rec.fields['Description'];
  const briefEl = document.getElementById('task-panel-brief');
  // Same markdown rendering as the task window (renderMarkdownLite escapes HTML).
  briefEl.innerHTML = description ? renderMarkdownLite(String(description)) : 'No brief';
  briefEl.classList.toggle('muted', !description);
  renderTaskPanelCard(rec);
  renderTaskPanelLinks(rec);

  const line = (label, value, cls) => {
    const row = document.createElement('div');
    row.className = 'task-panel-line';
    const a = document.createElement('span');
    a.textContent = label;
    const b = document.createElement('span');
    b.textContent = value;
    if (cls) b.className = cls;
    row.append(a, b);
    return row;
  };
  const filesEl = document.getElementById('task-panel-files');
  const fieldsEl = document.getElementById('task-panel-fields');
  filesEl.replaceChildren();
  fieldsEl.replaceChildren();
  if (!taskFileIndex) {
    filesEl.append(line(state.workingDirectory ? 'Scanning…' : 'No working directory set', ''));
  } else if (!isStatTask(rec)) {
    const files = taskFiles(stripAspectRatio(name), taskFileIndex);
    files.videos.forEach(v => {
      if (v.bytes == null) filesEl.append(line(`${v.label}.mp4`, 'missing', 'bad'));
      else filesEl.append(line(`${v.label}.mp4`, formatMB(v.bytes), v.bytes > READY_LIMIT_BYTES ? 'warn' : 'ok'));
    });
    filesEl.append(line('1x1 preview image', files.preview ? 'found' : 'missing', files.preview ? 'ok' : 'bad'));
  } else {
    filesEl.append(line('Stat task', 'no videos needed'));
  }
  const r = readinessFor(rec);
  if (r && r.warning) filesEl.prepend(repeatWarningEl(r));
  (r ? r.items.filter(i => i.step === 'autofill') : []).forEach(i => {
    fieldsEl.append(line(i.label, i.done ? 'set' : 'empty', i.done ? 'ok' : 'warn'));
  });
  if (r && r.handedIn) fieldsEl.append(line('Status', rec.fields['Status'], 'ok'));
}

// Top of the panel as a task card: the large Preview (click opens it full size
// in the browser), then priority, status, the deadline as a countdown, Type and
// Format.
function renderTaskPanelCard(rec) {
  const previewEl = document.getElementById('task-panel-preview');
  previewEl.replaceChildren();
  const placeholder = pending => {
    previewEl.classList.add('empty');
    const frag = document.createElement('span');
    frag.className = `task-panel-preview-ph${pending ? ' pending' : ''}`;
    frag.innerHTML = `${iconSvg(FORMAT_ICONS[rec.fields['Format']] || 'image')}<span>${pending ? 'Loading preview…' : 'No preview yet'}</span>`;
    return frag;
  };
  previewEl.classList.remove('empty');
  const el = previewElement(rec, 'large', placeholder, { lazy: false });
  if (el.tagName === 'IMG') {
    el.alt = 'Preview';
    el.title = 'Open full size';
    el.onclick = () => window.app.openExternal(previewUrl(rec, 'full') || previewUrl(rec, 'large'));
  }
  previewEl.append(el);

  const meta = document.getElementById('task-panel-meta');
  meta.replaceChildren();
  ['Priority', 'Status'].forEach(field => {
    const val = rec.fields[field];
    if (!val) return;
    const pill = document.createElement('span');
    pill.className = 'select-pill';
    pill.textContent = val;
    const swatch = singleSelectSwatch(state.activeTable, field, val);
    if (swatch) { pill.style.background = swatch.bg; pill.style.color = swatch.text; }
    meta.append(pill);
  });
  const deadline = rec.fields['Deadline'];
  if (deadline && !COMPLETED_STATUSES.includes(rec.fields['Status'] || '')) {
    const today = toISO(new Date());
    const days = daysUntilDeadline(deadline, today);
    const chip = document.createElement('span');
    chip.className = `deadline-chip ${days < 0 ? 'overdue' : days <= 1 ? 'soon' : ''}`;
    chip.innerHTML = iconSvg('clock');
    chip.append(deadlineAlertLabel(deadline, today));
    chip.title = deadline;
    meta.append(chip);
  }
  [rec.fields['Type'], rec.fields['Format']].filter(Boolean).forEach(v => {
    const tag = document.createElement('span');
    tag.className = 'meta-tag';
    tag.textContent = v;
    meta.append(tag);
  });
}

// Buttons for the task's links: Drive (Creative Link), Figma (Figma/Canvas
// link) and REF, each shown only when the field has a link. Field names are
// resolved against the live schema; LB spells its Figma column "Figmа Link"
// with a Cyrillic "а", which the loose match cannot see, so any "Fig… link"
// column is the fallback.
function renderTaskPanelLinks(rec) {
  const names = (state.tables[state.activeTable]?.fields || []).map(f => f.name);
  const figmaField = resolveFieldName(names, FIGMA_LINK_FIELD)
    || names.find(n => /^fig/i.test(n) && /link/i.test(n));
  const links = [
    ['Drive', resolveFieldName(names, CREATIVE_LINK_FIELD)],
    ['Figma', figmaField],
    ['REF', resolveFieldName(names, 'REF')],
  ];
  const el = document.getElementById('task-panel-links');
  el.replaceChildren();
  links.forEach(([label, field]) => {
    const url = field && String(rec.fields[field] || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) return;
    const btn = document.createElement('button');
    btn.innerHTML = iconSvg('external');
    btn.append(label);
    btn.title = url;
    btn.addEventListener('click', () => window.app.openExternal(rewriteDriveLink(url, state.driveAccountIndex)));
    el.append(btn);
  });
}

function renderTaskPanelSelection() {
  const selected = state.records
    .filter(r => state.selectedIds.has(r.id))
    .sort((a, b) => compareTaskNames(a.fields['Name'] || '', b.fields['Name'] || ''));
  document.getElementById('task-panel-title').textContent = `${selected.length} tasks selected`;
  document.getElementById('task-panel-title').title = '';
  const listEl = document.getElementById('task-panel-multi');
  listEl.replaceChildren();
  const fieldNames = readinessFieldNames();
  selected.forEach(r => {
    const row = document.createElement('button');
    row.className = 'task-panel-pick';
    row.title = 'Show only this task';
    const name = document.createElement('span');
    name.className = 'task-panel-pick-name';
    name.textContent = r.fields['Name'] || r.id;
    const status = document.createElement('span');
    const ready = readinessFor(r, fieldNames);
    if (ready) {
      status.textContent = ready.promote ? `⚠ ${ready.warning}` : readinessLabel(ready);
      status.className = ready.handedIn ? 'muted' : ready.ready && !ready.promote ? 'ok' : 'warn';
      status.title = ready.handedIn ? '' : [ready.warning, ...ready.missing.map(i => i.label)].filter(Boolean).join('\n');
    }
    row.append(name, status);
    row.addEventListener('click', () => selectSingleTask(r));
    listEl.appendChild(row);
  });
}

// Selects exactly one task, as a plain click on its row does.
function selectSingleTask(rec) {
  state.selectedIds.clear();
  state.selectionAnchorId = rec.id;
  state.selectionCursorId = rec.id;
  state.selectedTask = rec;
  state.selectedIds.add(rec.id);
  openRenamePanel(rec);
  render();
  scrollRecordIntoView(rec.id);
}

function scrollRecordIntoView(id) {
  const i = (state.visibleRecords || []).findIndex(r => r.id === id);
  const row = document.querySelectorAll('#records-container tbody tr')[i];
  if (row) row.scrollIntoView({ block: 'nearest' });
}

// ↑/↓ move to the previous/next task in the table; Shift+↑/↓ extend the
// selection from the anchor, like Shift-click.
function moveTaskCursor(step, extend) {
  const list = state.visibleRecords || [];
  if (!list.length) return;
  const curId = state.selectionCursorId || (state.selectedTask && state.selectedTask.id);
  let i = list.findIndex(r => r.id === curId);
  i = i === -1 ? (step > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + step));
  const next = list[i];
  if (!extend || !state.selectedTask) { selectSingleTask(next); return; }
  let a = list.findIndex(r => r.id === state.selectionAnchorId);
  if (a === -1) a = i;
  const [start, end] = a < i ? [a, i] : [i, a];
  state.selectedIds = new Set(list.slice(start, end + 1).map(r => r.id));
  state.selectionCursorId = next.id;
  render();
  scrollRecordIntoView(next.id);
}

async function copyPanelBrief() {
  const rec = state.selectedTask;
  const brief = rec && briefFromDescription(rec.fields['Description']);
  const btn = document.getElementById('task-panel-copy-brief-btn');
  if (!brief) return;
  await window.app.copyToClipboard(brief);
  flashCopied(btn, 1, 'Copied');
}

// Both bulk status actions differ only in the target status, the button they
// drive, and whether a completion date is stamped — so they share one
// implementation.
//
// Neither action touches "Date Done": that is stamped by Autofill, which is the
// step that actually finishes a creative. A status change alone says nothing
// about when the work was completed. An existing Date Done is left alone rather
// than cleared, which is safe because the dashboard filters on Status first (see
// buildDashboardData) so a task back in progress is excluded either way.
async function markSelectedAs(status, { btnId, keepSelection = false }) {
  if (!state.selectedIds.size) return;
  const tableInfo = state.tables[state.activeTable];
  if (!tableInfo) return;

  const ids = [...state.selectedIds];
  const before = ids.map(id => ({ id, status: state.records.find(r => r.id === id)?.fields['Status'] || null }));
  const btn = document.getElementById(btnId);
  // An icon-only button keeps its icon while busy (dimmed by :disabled); a text
  // button says so. Either way its markup is put back exactly as it was.
  const original = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    if (!btn.classList.contains('icon-btn')) btn.textContent = 'Updating...';
  }
  try {
    const updates = ids.map(id => ({ id, fields: { Status: status } }));
    const results = await window.airtable.updateRecords(state.baseId, tableInfo.id, updates);
    const byId = new Map(results.map(r => [r.id, r]));
    state.records.forEach(rec => {
      const updated = byId.get(rec.id);
      if (updated) rec.fields = updated.fields;
    });
    log(`markSelectedAs: updated ${results.length} record(s) to ${status}`);
    toast(`${results.length} task${results.length === 1 ? '' : 's'} → ${status}`, {
      action: { label: 'Undo', run: () => restoreStatuses(before) },
    });
    pruneCompletedDeadlineAlerts();
    // Back to In work is usually a correction followed by more work on the same
    // tasks, so the selection stays; handing in (To accept) clears it.
    if (!keepSelection) {
      state.selectedIds.clear();
      clearTaskSelection();
    }
    render();
    maybeRefreshDashboard();
  } catch (err) {
    toastError(`Failed to update some records: ${err.message}`);
    log(`markSelectedAs(${status}): FAILED — ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
    updateBulkActionsBar();
  }
}

// Puts tasks back to the statuses they had (the Undo of a status change).
async function restoreStatuses(before) {
  const tableInfo = state.tables[state.activeTable];
  if (!tableInfo || !before.length) return;
  try {
    const results = await window.airtable.updateRecords(state.baseId, tableInfo.id,
      before.map(b => ({ id: b.id, fields: { Status: b.status } })));
    const byId = new Map(results.map(r => [r.id, r]));
    state.records.forEach(rec => {
      const updated = byId.get(rec.id);
      if (updated) rec.fields = updated.fields;
    });
    log(`restoreStatuses: put ${results.length} record(s) back`);
    toast(`Undone: ${results.length} task${results.length === 1 ? '' : 's'} back`);
    render();
    maybeRefreshDashboard();
  } catch (err) {
    toastError(`Could not undo: ${err.message}`);
  }
}

async function markSelectedAsToAccept() {
  return markSelectedAs('To accept', { btnId: 'bulk-mark-accept-btn' });
}

async function markSelectedAsInWork() {
  return markSelectedAs('In work', { btnId: 'bulk-mark-inwork-btn', keepSelection: true });
}

// ── UI Components ────────────────────────────────────────────────────────

function renderStatusChips() {
  const container = document.getElementById('status-filters');
  container.innerHTML = '';
  (state.statusOptions.length ? state.statusOptions : DEFAULT_STATUSES).forEach(name => {
    const chip = document.createElement('span');
    chip.className = 'status-chip' + (state.activeStatuses.has(name) ? ' on' : '');
    chip.textContent = name;
    chip.onclick = () => {
      state.activeStatuses[state.activeStatuses.has(name) ? 'delete' : 'add'](name);
      chip.classList.toggle('on');
      render();
    };
    container.appendChild(chip);
  });
}

function renderDESPicker() {
  const sel = document.getElementById('des-select');
  const current = state.selectedDES;
  sel.innerHTML = '<option value="">All</option>';
  state.allDES.forEach(des => {
    const opt = document.createElement('option');
    opt.value = des; opt.textContent = des;
    sel.appendChild(opt);
  });
  sel.value = current || '';
}

// ── Dashboard ──────────────────────────────────────────────────────────────
// Aggregates "Done" tasks across all 4 tables from whatever is already in
// recordsCache (no extra network calls) — grouped by designer, broken down
// by task Type.

function showDashboard() {
  clearTaskSelection();
  state.selectedIds.clear();
  updateBulkActionsBar();
  document.getElementById('records-container').classList.add('hidden');
  document.getElementById('status-filters').classList.add('hidden');
  document.getElementById('des-control').classList.add('hidden');
  document.getElementById('refresh-btn').classList.add('hidden');
  document.getElementById('workload-container').classList.add('hidden');
  document.getElementById('view-toggle').classList.add('hidden');
  document.getElementById('columns-btn').classList.add('hidden');
  document.getElementById('bulk-actions-bar').classList.add('hidden');
  document.getElementById('dashboard-container').classList.remove('hidden');
  setStatus('Dashboard: completed tasks by designer');
  syncDashboardControls();
  renderDashboard();
}

// Called whenever a background fetch (preload/poll) updates recordsCache, so
// the dashboard's totals catch up live instead of only on next tab re-entry.
function maybeRefreshDashboard() {
  if (!document.getElementById('dashboard-container').classList.contains('hidden')) {
    renderDashboard();
  }
  if (!document.getElementById('workload-container').classList.contains('hidden')) {
    renderWorkload();
  }
}

// Back to the table view. Also closes the Workload view, which shares this
// "everything but the table" layout with the dashboard.
function hideDashboard() {
  document.getElementById('dashboard-container').classList.add('hidden');
  document.getElementById('workload-container').classList.add('hidden');
  document.getElementById('bulk-actions-bar').classList.remove('hidden');
  document.getElementById('view-toggle').classList.remove('hidden');
  document.getElementById('columns-btn').classList.remove('hidden');
  document.getElementById('records-container').classList.remove('hidden');
  document.getElementById('status-filters').classList.remove('hidden');
  document.getElementById('des-control').classList.remove('hidden');
  document.getElementById('refresh-btn').classList.remove('hidden');
}

function syncDashboardControls() {
  document.querySelectorAll('.dash-preset').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === state.dashboardPreset);
  });
  document.getElementById('dashboard-custom-range').classList.toggle('hidden', state.dashboardPreset !== 'custom');
  document.getElementById('dashboard-from').value = state.dashboardCustomFrom;
  document.getElementById('dashboard-to').value = state.dashboardCustomTo;
}

function computeDashboardStats() {
  const { from, to } = getDashboardRange();
  const notLoaded = TARGET_TABLES.filter(name => !recordsCache[name]);
  const byDES = {};
  const allTypes = new Set();
  const hoursEntries = [];

  TARGET_TABLES.forEach(name => {
    (recordsCache[name] || []).forEach(r => {
      const status = r.fields['Status'] || '';
      if (status !== 'Done' && status !== 'To accept') return;
      const dateDone = r.fields['Date Done'];
      if (from || to) {
        if (!dateDone) return; // no date to place it in a specific range
        if (from && dateDone < from) return;
        if (to && dateDone > to) return;
      }
      const des = r.fields['DES'] || '(unassigned)';
      const type = r.fields['Type'] || '(unspecified)';
      allTypes.add(type);
      if (!byDES[des]) byDES[des] = { total: 0, types: {} };
      byDES[des].total++;
      byDES[des].types[type] = (byDES[des].types[type] || 0) + 1;
      hoursEntries.push({ des, hours: r.fields['Hours'] });
    });
  });

  const rows = Object.entries(byDES)
    .map(([des, data]) => ({ des, total: data.total, types: data.types }))
    .sort((a, b) => b.total - a.total);

  const { rows: hoursRows, totalHours, avgHours } = computeHoursByDesigner(hoursEntries);

  return { rows, allTypes: [...allTypes].sort(), notLoaded, from, to, hoursRows, totalHours, avgHours };
}

// Two views of the same period: Compact (as before: tasks by designer and Type,
// then hours per designer) and Detailed (the same first table, then headline
// numbers, the load chart, per-designer stats, hours by Type and six months).
function renderDashboard() {
  const { rows, allTypes, notLoaded, from, to, hoursRows, totalHours, avgHours } = computeDashboardStats();
  const rangeLabel = document.getElementById('dashboard-range-label');
  rangeLabel.textContent = (from || to) ? `${from || '…'} → ${to || '…'}` : 'All time';
  document.querySelectorAll('#dashboard-view-toggle button')
    .forEach(b => b.classList.toggle('active', b.dataset.dashView === state.dashboardView));

  const area = document.getElementById('dashboard-table-area');
  area.innerHTML = '';

  if (notLoaded.length) {
    const note = document.createElement('p');
    note.className = 'dash-note warn';
    note.textContent = `Still loading: ${notLoaded.join(', ')} — totals will update once ready (try again shortly).`;
    area.appendChild(note);
  }

  if (rows.length) {
    renderDashboardTypeTable(area, rows, allTypes);
  } else {
    const empty = document.createElement('p');
    empty.className = 'dash-note';
    empty.textContent = 'No "Done" or "To accept" tasks found for this period.';
    area.appendChild(empty);
  }

  if (state.dashboardView !== 'detailed') {
    if (rows.length) renderDashboardHoursTable(area, hoursRows, totalHours, avgHours);
    return;
  }
  const perf = collectPerformance(TARGET_TABLES.map(name => recordsCache[name]), parseHoursValue);
  const range = { from, to };
  renderPerformanceKpis(area, perf, range);
  renderLoadChart(area, perf, range);
  renderPerformanceTables(area, perf, range);
}

// Done + To accept per designer, broken down by Type.
function renderDashboardTypeTable(area, rows, allTypes) {
  const maxTotal = rows[0].total;
  const table = document.createElement('table');
  table.className = 'dash-table';

  const caption = document.createElement('caption');
  caption.textContent = `Done + To accept tasks by designer, across ${TARGET_TABLES.map(t => t.replace(' Creatives', '')).join(' / ')}`;
  table.appendChild(caption);

  const hr = table.createTHead().insertRow();
  ['#', 'Designer', 'Total', ...allTypes].forEach((label, i) => {
    const th = document.createElement('th');
    th.textContent = label;
    if (i >= 3) th.className = 'dash-type-header';
    hr.appendChild(th);
  });

  const tbody = table.createTBody();
  rows.forEach((row, i) => {
    const tr = tbody.insertRow();
    const tdRank = tr.insertCell(); tdRank.textContent = i + 1; tdRank.className = 'dash-rank';
    const tdName = tr.insertCell(); tdName.textContent = row.des; tdName.className = 'dash-name';

    const tdBar = tr.insertCell(); tdBar.className = 'dash-bar-cell';
    const track = document.createElement('div'); track.className = 'dash-bar-track';
    const fill = document.createElement('div'); fill.className = 'dash-bar-fill';
    fill.style.width = `${Math.max(4, (row.total / maxTotal) * 100)}%`;
    const label = document.createElement('span'); label.className = 'dash-bar-label'; label.textContent = row.total;
    track.appendChild(fill); track.appendChild(label);
    tdBar.appendChild(track);

    allTypes.forEach(type => {
      const td = tr.insertCell();
      const count = row.types[type] || 0;
      td.className = count ? 'dash-type-count' : 'dash-type-count zero';
      td.textContent = count || '–';
    });
  });

  const totalRow = tbody.insertRow();
  totalRow.className = 'total-row';
  totalRow.insertCell().textContent = '';
  totalRow.insertCell().textContent = 'Total';
  totalRow.insertCell().textContent = rows.reduce((s, r) => s + r.total, 0);
  allTypes.forEach(type => {
    const td = totalRow.insertCell();
    const count = rows.reduce((s, r) => s + (r.types[type] || 0), 0);
    td.className = count ? 'dash-type-count' : 'dash-type-count zero';
    td.textContent = count || '–';
  });

  area.appendChild(table);
}

// Hours per designer (Compact view).
function renderDashboardHoursTable(area, hoursRows, totalHours, avgHours) {
  const hoursTable = document.createElement('table');
  hoursTable.className = 'dash-table';

  const hoursCaption = document.createElement('caption');
  hoursCaption.textContent = 'Time spent per designer (same filter as above)';
  hoursTable.appendChild(hoursCaption);

  const hoursHr = hoursTable.createTHead().insertRow();
  ['#', 'Designer', 'Total Hours', 'Avg Hours / Creative'].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    hoursHr.appendChild(th);
  });

  const hoursTbody = hoursTable.createTBody();
  const maxHours = hoursRows.length ? hoursRows[0].totalHours : 0;
  hoursRows.forEach((row, i) => {
    const tr = hoursTbody.insertRow();
    const tdRank = tr.insertCell(); tdRank.textContent = i + 1; tdRank.className = 'dash-rank';
    const tdName = tr.insertCell(); tdName.textContent = row.des; tdName.className = 'dash-name';

    const tdBar = tr.insertCell(); tdBar.className = 'dash-bar-cell';
    const track = document.createElement('div'); track.className = 'dash-bar-track';
    const fill = document.createElement('div'); fill.className = 'dash-bar-fill';
    fill.style.width = `${maxHours ? Math.max(4, (row.totalHours / maxHours) * 100) : 4}%`;
    const label = document.createElement('span'); label.className = 'dash-bar-label'; label.textContent = row.totalHours.toFixed(1);
    track.appendChild(fill); track.appendChild(label);
    tdBar.appendChild(track);

    const tdAvg = tr.insertCell();
    tdAvg.textContent = row.avgHours === null ? '–' : row.avgHours.toFixed(1);
  });

  const hoursTotalRow = hoursTbody.insertRow();
  hoursTotalRow.className = 'total-row';
  hoursTotalRow.insertCell().textContent = '';
  hoursTotalRow.insertCell().textContent = 'Total';
  hoursTotalRow.insertCell().textContent = totalHours.toFixed(1);
  hoursTotalRow.insertCell().textContent = avgHours === null ? '–' : avgHours.toFixed(1);

  area.appendChild(hoursTable);
}


// ── Dashboard: load and performance ───────────────────────────────────────
// Numbers come from performance-data.js; this part only draws them.

const fmtHours = h => (h == null ? '–' : h.toFixed(1));
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDay = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const monthLabel = ym => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;

// "▲ 12%" / "▼ 8%" / "= 0%" against the period before, as text (never colour
// alone); the class only tints it.
function changeEl(pct, { suffix = '' } = {}) {
  const el = document.createElement('span');
  if (pct == null) { el.className = 'dash-change none'; el.textContent = '—'; return el; }
  const rounded = Math.round(pct);
  el.className = `dash-change ${rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat'}`;
  el.textContent = `${rounded > 0 ? '▲' : rounded < 0 ? '▼' : '='} ${Math.abs(rounded)}%${suffix}`;
  return el;
}

function dashSection(area, title, note) {
  const sec = document.createElement('section');
  sec.className = 'dash-section';
  const h = document.createElement('h3');
  h.textContent = title;
  sec.append(h);
  if (note) {
    const p = document.createElement('p');
    p.className = 'dash-section-note';
    p.textContent = note;
    sec.append(p);
  }
  area.append(sec);
  return sec;
}

function renderPerformanceKpis(area, perf, range) {
  const k = performanceKpis(perf.tasks, range, perf.reworkByDes);
  const row = document.createElement('div');
  row.className = 'dash-kpis';
  const tile = (label, value, sub) => {
    const t = document.createElement('div');
    t.className = 'dash-kpi';
    const l = document.createElement('div');
    l.className = 'dash-kpi-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'dash-kpi-value';
    v.textContent = value;
    const foot = document.createElement('div');
    foot.className = 'dash-kpi-foot';
    foot.textContent = sub || '';
    t.append(l, v, foot);
    row.append(t);
  };
  tile('Handed in', String(k.tasks), 'Done + To accept');
  tile('Hours logged', fmtHours(k.hours));
  tile('Avg hours / task', fmtHours(k.avgHours), 'tasks with Hours set');
  tile('Designers active', String(k.designers));
  tile('In Rework now', String(k.rework), k.reworkShare == null ? '' : `${Math.round(k.reworkShare)}% of Rework + handed in`);
  area.append(row);
}

// Tasks handed in and hours per day / week / month: two small bar charts on
// the same buckets (never one chart with two scales). Hover shows the numbers.
function renderLoadChart(area, perf, range) {
  const designers = [...new Set(perf.tasks.map(t => t.des))].sort();
  if (state.dashboardDes && !designers.includes(state.dashboardDes)) state.dashboardDes = '';
  const series = loadSeries(perf.tasks, range, { des: state.dashboardDes, today: toISO(new Date()) });
  const unit = { day: 'day', week: 'week', month: 'month' }[series.granularity];
  const sec = dashSection(area, 'Load', null);
  const head = sec.querySelector('h3');
  const select = document.createElement('select');
  select.id = 'dashboard-des-select';
  [['', 'All designers'], ...designers.map(d => [d, d])].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.append(opt);
  });
  select.value = state.dashboardDes;
  select.onchange = () => { state.dashboardDes = select.value; renderDashboard(); };
  head.append(select);
  if (!series.buckets.length) {
    const p = document.createElement('p');
    p.className = 'dash-section-note';
    p.textContent = 'Nothing handed in for this period.';
    sec.append(p);
    return;
  }
  const label = b => (series.granularity === 'month' ? monthLabel(b.start)
    : series.granularity === 'week' ? `${shortDay(b.start)}–${shortDay(b.end)}` : shortDay(b.start));
  const axisLabel = b => (series.granularity === 'month' ? monthLabel(b.start) : shortDay(b.start));
  const grid = document.createElement('div');
  grid.className = 'dash-charts';
  grid.append(
    barChart(series.buckets, b => b.tasks, {
      title: `Tasks handed in per ${unit}`, label, axisLabel,
      tip: b => `${label(b)}: ${b.tasks} task${b.tasks === 1 ? '' : 's'} · ${fmtHours(b.hours)} h`,
      format: v => String(Math.round(v)), minMax: 2,
    }),
    barChart(series.buckets, b => b.hours, {
      title: `Hours logged per ${unit}`, label, axisLabel,
      tip: b => `${label(b)}: ${fmtHours(b.hours)} h · ${b.tasks} task${b.tasks === 1 ? '' : 's'}`,
      format: v => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
      valueLabel: v => (v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '')),
    }),
  );
  sec.append(grid);
}

// One single-series bar chart as inline SVG: rounded data ends on a zero
// baseline, three recessive grid lines, thinned axis labels, a hover tooltip.
function barChart(buckets, value, { title, axisLabel, tip, format, minMax, valueLabel = format }) {
  const W = 560, H = 170, padL = 34, padR = 8, padT = 10, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(...buckets.map(value), 0);
  const niceMax = niceCeil(Math.max(max, minMax || 1));
  const n = buckets.length;
  const slot = plotW / n;
  const barW = Math.max(2, Math.min(28, slot - 2));
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const e = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  };
  const wrap = document.createElement('figure');
  wrap.className = 'dash-chart';
  const cap = document.createElement('figcaption');
  cap.textContent = title;
  wrap.append(cap);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title });
  [0, 0.5, 1].forEach(f => {
    const y = padT + plotH - f * plotH;
    svg.append(el('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: f === 0 ? 'axis' : 'grid' }));
    const t = el('text', { x: padL - 6, y: y + 3, class: 'tick', 'text-anchor': 'end' });
    t.textContent = format(niceMax * f);
    svg.append(t);
  });
  const every = Math.max(1, Math.ceil(n / 10));
  const tipEl = document.createElement('div');
  tipEl.className = 'dash-chart-tip hidden';
  buckets.forEach((b, i) => {
    const v = value(b);
    const x = padL + i * slot + (slot - barW) / 2;
    const h = (v / niceMax) * plotH;
    const y0 = padT + plotH;
    if (h > 0) {
      const r = Math.min(4, barW / 2, h);
      svg.append(el('path', {
        class: 'bar',
        d: `M${x},${y0} V${y0 - h + r} Q${x},${y0 - h} ${x + r},${y0 - h} H${x + barW - r} Q${x + barW},${y0 - h} ${x + barW},${y0 - h + r} V${y0} Z`,
      }));
      // The value inside the top of the bar; above it when the bar is too short.
      const text = valueLabel(v);
      const inside = h >= 16 && barW >= text.length * 6 + 2; // ~6 px a digit at 10 px
      const label = el('text', {
        x: x + barW / 2, y: inside ? y0 - h + 12 : y0 - h - 4,
        class: inside ? 'bar-value' : 'bar-value outside', 'text-anchor': 'middle',
      });
      label.textContent = text;
      svg.append(label);
    }
    if (i % every === 0) {
      const t = el('text', { x: padL + i * slot + slot / 2, y: H - 6, class: 'tick', 'text-anchor': 'middle' });
      t.textContent = axisLabel(b);
      svg.append(t);
    }
    const hit = el('rect', { x: padL + i * slot, y: padT, width: slot, height: plotH, class: 'hit' });
    hit.addEventListener('mouseenter', () => {
      tipEl.textContent = tip(b);
      tipEl.classList.remove('hidden');
      hit.classList.add('on');
      const left = ((padL + i * slot + slot / 2) / W) * 100;
      tipEl.style.left = `${Math.min(80, Math.max(10, left))}%`;
    });
    hit.addEventListener('mouseleave', () => { tipEl.classList.add('hidden'); hit.classList.remove('on'); });
    svg.append(hit);
  });
  wrap.append(svg, tipEl);
  return wrap;
}

// 1, 2, 4, 6 or 8 × 10^k at or above v (halves stay whole), so the grid lines land on round numbers.
function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 4, 6, 8, 10].map(m => m * p).find(c => c >= v);
}

function renderPerformanceTables(area, perf, range) {
  // Six months first: the comparison that says whether someone is growing.
  renderMonthlyTrend(area, perf);

  // Designers in this period (tasks, hours, Rework now).
  const rows = designerStats(perf.tasks, range, perf.reworkByDes);
  const sec = dashSection(area, 'Designers in this period', 'Rework is what is in Rework now.');
  const t = document.createElement('table');
  t.className = 'dash-table';
  const hr = t.createTHead().insertRow();
  ['#', 'Designer', 'Tasks', 'Hours', 'Avg h / task', 'In Rework', 'Rework share'].forEach((label, i) => {
    const th = document.createElement('th');
    th.textContent = label;
    if (i >= 2) th.className = 'num';
    hr.append(th);
  });
  const body = t.createTBody();
  rows.forEach((r, i) => {
    const tr = body.insertRow();
    const cell = (text, cls) => { const td = tr.insertCell(); td.textContent = text; if (cls) td.className = cls; return td; };
    cell(i + 1, 'dash-rank');
    cell(r.des, 'dash-name');
    cell(r.tasks || '–', `num${r.tasks ? '' : ' muted'}`);
    cell(fmtHours(r.hours), 'num');
    cell(fmtHours(r.avgHours), 'num');
    cell(r.rework || '–', `num${r.rework ? ' warn' : ' muted'}`);
    cell(r.reworkShare == null ? '–' : `${Math.round(r.reworkShare)}%`, 'num');
  });
  sec.append(t);

  // Hours per task by Type.
  const h = hoursByType(perf.tasks, range);
  if (h.types.length) {
    const sec2 = dashSection(area, 'Hours per task by type', 'Average Hours of the tasks handed in that have Hours set (how many, in brackets).');
    const t2 = document.createElement('table');
    t2.className = 'dash-table';
    const hr2 = t2.createTHead().insertRow();
    ['Designer', 'All', ...h.types].forEach((label, i) => {
      const th = document.createElement('th');
      th.textContent = label;
      if (i) th.className = 'num';
      hr2.append(th);
    });
    const avgCell = (tr, c) => {
      const td = tr.insertCell();
      td.className = 'num';
      if (!c) { td.textContent = '–'; td.classList.add('muted'); return; }
      td.textContent = c.avg.toFixed(1);
      const small = document.createElement('small');
      small.textContent = ` (${c.n})`;
      td.append(small);
    };
    const body2 = t2.createTBody();
    h.rows.forEach(r => {
      const tr = body2.insertRow();
      const td = tr.insertCell(); td.textContent = r.des; td.className = 'dash-name';
      avgCell(tr, r.all);
      h.types.forEach(type => avgCell(tr, r.cells[type]));
    });
    const tot = body2.insertRow();
    tot.className = 'total-row';
    tot.insertCell().textContent = 'Team';
    avgCell(tot, h.all);
    h.types.forEach(type => avgCell(tot, h.total[type]));
    sec2.append(t2);
  }
}

// Six full months per designer, the current month apart, a sparkline and the
// trend in words. Independent of the period above.
function renderMonthlyTrend(area, perf) {
  const m = monthlyTrend(perf.tasks, toISO(new Date()));
  if (!m.rows.length) return;
  const sec = dashSection(area, 'Last 6 months',
    'Tasks handed in per month. "3 months" compares the last three full months with the three before; the trend is fitted over all six. The current month is not over yet and is shown apart.');
  const t = document.createElement('table');
  t.className = 'dash-table';
  const hr = t.createTHead().insertRow();
  ['Designer', ...m.months.map(monthLabel), `${monthLabel(m.current)} so far`, '', '3 months', 'Trend'].forEach((label, i) => {
    const th = document.createElement('th');
    th.textContent = label;
    if (i) th.className = 'num';
    hr.append(th);
  });
  const body = t.createTBody();
  const addRow = (name, counts, hours, current, trend, three, cls) => {
    const tr = body.insertRow();
    if (cls) tr.className = cls;
    const td = tr.insertCell(); td.textContent = name; td.className = 'dash-name';
    counts.forEach((c, i) => {
      const cell = tr.insertCell();
      cell.className = `num${c ? '' : ' muted'}`;
      cell.textContent = c || '–';
      if (hours) cell.title = `${fmtHours(hours[i])} h`;
    });
    const cur = tr.insertCell(); cur.className = 'num muted'; cur.textContent = current || '–';
    tr.insertCell().append(sparkline(counts));
    const t3 = tr.insertCell();
    t3.className = 'num';
    t3.append(changeEl(three.change3));
    t3.title = `${monthLabel(m.months[3])} – ${monthLabel(m.months[5])}: ${three.last3} · ${monthLabel(m.months[0])} – ${monthLabel(m.months[2])}: ${three.prev3}`;
    const tc = tr.insertCell();
    tc.className = 'num';
    const words = { up: 'growing', down: 'falling', flat: 'steady', none: '—' }[trend.direction];
    if (trend.pct == null || trend.direction === 'flat') {
      tc.textContent = trend.direction === 'flat' ? `= ${words}` : words;
    } else {
      tc.append(changeEl(trend.pct, { suffix: '/mo' }));
      tc.append(document.createTextNode(` ${words}`));
    }
    if (trend.pct != null) tc.title = `${trend.pct > 0 ? '+' : ''}${trend.pct.toFixed(1)}% a month (least-squares fit over the six full months; within ±5% counts as steady)`;
  };
  m.rows.forEach(r => addRow(r.des, r.counts, r.hours, r.current, r.trend, r));
  addRow('Team', m.team.counts, null, m.team.current, m.team.trend, m.team, 'total-row');
  sec.append(t);
}

function sparkline(values) {
  const W = 80, H = 20;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1 || 1)) * (W - 4) + 2},${H - 2 - (v / max) * (H - 4)}`);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'dash-spark');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', pts.join(' '));
  svg.append(line);
  const last = pts[pts.length - 1].split(',');
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('cx', last[0]); dot.setAttribute('cy', last[1]); dot.setAttribute('r', 2.5);
  svg.append(dot);
  return svg;
}

// ── Workload (manager view) ────────────────────────────────────────────────
// Open tasks (Ready for Design + In work) per designer, and how many of them are
// High priority, from recordsCache like the dashboard. Filters: one table and/or
// one product (the Project field). Counting lives in workload-data.js.

function showWorkload() {
  clearTaskSelection();
  state.selectedIds.clear();
  updateBulkActionsBar();
  document.getElementById('records-container').classList.add('hidden');
  document.getElementById('status-filters').classList.add('hidden');
  document.getElementById('des-control').classList.add('hidden');
  document.getElementById('refresh-btn').classList.add('hidden');
  document.getElementById('dashboard-container').classList.add('hidden');
  document.getElementById('view-toggle').classList.add('hidden');
  document.getElementById('columns-btn').classList.add('hidden');
  document.getElementById('bulk-actions-bar').classList.add('hidden');
  document.getElementById('workload-container').classList.remove('hidden');
  setStatus('Workload: open tasks per designer');
  renderWorkload();
}

function workloadSources() {
  return TARGET_TABLES.map(name => ({ tableName: name, records: recordsCache[name] || [] }));
}

function renderWorkload() {
  const sources = workloadSources();
  const table = state.workloadTable || null;

  document.querySelectorAll('.workload-scope').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.table === state.workloadTable);
  });
  // Products offered are the ones present in the chosen table; a product that
  // isn't there falls back to "All products" rather than showing an empty list.
  const products = listWorkloadProducts(sources, table);
  if (state.workloadProduct && !products.includes(state.workloadProduct)) state.workloadProduct = '';
  const select = document.getElementById('workload-product');
  select.innerHTML = '';
  [['', 'All products'], ...products.map(p => [p, p])].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  });
  select.value = state.workloadProduct;

  const { rows, totals } = computeWorkload(sources, { table, product: state.workloadProduct });
  const area = document.getElementById('workload-table-area');
  area.innerHTML = '';

  const notLoaded = TARGET_TABLES.filter(name => !recordsCache[name] && (!table || name === table));
  if (notLoaded.length) {
    const note = document.createElement('p');
    note.className = 'dash-note warn';
    note.textContent = `Still loading: ${notLoaded.join(', ')} — counts will update once ready.`;
    area.appendChild(note);
  }

  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'dash-note';
    empty.textContent = `No ${WORKLOAD_STATUSES.join(' / ')} tasks for this filter.`;
    area.appendChild(empty);
    return;
  }

  const tableEl = document.createElement('table');
  tableEl.className = 'dash-table';
  const caption = document.createElement('caption');
  const scope = [table ? table.replace(' Creatives', '') : 'All tables', state.workloadProduct || 'all products'].join(' · ');
  caption.textContent = `Open tasks (${WORKLOAD_STATUSES.join(' + ')}) by designer — ${scope}`;
  tableEl.appendChild(caption);

  const hr = tableEl.createTHead().insertRow();
  ['#', 'Designer', 'Open', ...WORKLOAD_STATUSES, 'High priority'].forEach((label, i) => {
    const th = document.createElement('th');
    th.textContent = label;
    if (i >= 3) th.className = 'dash-type-header';
    hr.appendChild(th);
  });

  const maxOpen = Math.max(...rows.map(r => r.open));
  const countCell = (tr, count, extra = '') => {
    const td = tr.insertCell();
    td.className = `dash-type-count${count ? extra : ' zero'}`;
    td.textContent = count || '–';
  };
  const tbody = tableEl.createTBody();
  rows.forEach((row, i) => {
    const tr = tbody.insertRow();
    const tdRank = tr.insertCell(); tdRank.textContent = i + 1; tdRank.className = 'dash-rank';
    const tdName = tr.insertCell(); tdName.textContent = row.des; tdName.className = 'dash-name';

    const tdBar = tr.insertCell(); tdBar.className = 'dash-bar-cell';
    const track = document.createElement('div'); track.className = 'dash-bar-track';
    const fill = document.createElement('div'); fill.className = 'dash-bar-fill';
    fill.style.width = `${Math.max(4, (row.open / maxOpen) * 100)}%`;
    const label = document.createElement('span'); label.className = 'dash-bar-label'; label.textContent = row.open;
    track.appendChild(fill); track.appendChild(label);
    tdBar.appendChild(track);

    WORKLOAD_STATUSES.forEach(st => countCell(tr, row.statuses[st]));
    countCell(tr, row.high, ' high');
  });

  const totalRow = tbody.insertRow();
  totalRow.className = 'total-row';
  totalRow.insertCell().textContent = '';
  totalRow.insertCell().textContent = 'Total';
  totalRow.insertCell().textContent = totals.open;
  WORKLOAD_STATUSES.forEach(st => countCell(totalRow, totals.statuses[st]));
  countCell(totalRow, totals.high, ' high');

  area.appendChild(tableEl);
}

// ── Record detail modal ─────────────────────────────────────────────────
// Double-click a row to open a field-by-field editor, similar to Airtable's
// own expanded record view: each field renders with the right widget for
// its type (select dropdown, checkboxes, date picker, etc.) and saves back
// to Airtable immediately on change — there's no separate "Save" step,
// matching Airtable's own inline-edit behavior.

const READONLY_FIELD_TYPES = new Set([
  'formula', 'rollup', 'count', 'autoNumber', 'createdTime', 'lastModifiedTime',
  'createdBy', 'lastModifiedBy', 'button', 'multipleLookupValues', 'aiText',
]);

function openRecordModal(rec, tableName) {
  currentDetailRecord = rec;
  currentDetailTable = tableName;
  renderRecordModal(rec, tableName);
  document.getElementById('record-modal').classList.remove('hidden');
}

async function openCurrentTaskFolder(rec = currentDetailRecord) {
  const name = rec && rec.fields['Name'];
  if (!name) return;
  if (!state.workingDirectory) { toastNeedsWorkingDirectory(); return; }
  const opened = await window.app.openTaskFolder(state.workingDirectory, name, stripAspectRatio(name));
  if (!opened) toast(`No folder named "${name}" and no ${stripAspectRatio(name)}_9x16.mp4 in the working directory.`);
}

function closeRecordModal() {
  document.getElementById('record-modal').classList.add('hidden');
  currentDetailRecord = null;
  currentDetailTable = null;
}

// Lets a user hide fields they don't care about (e.g. the long list of
// per-network status columns) from the task detail view. Per-table, saved
// to this computer only (localStorage) — doesn't affect Airtable itself.
function openFieldSettings(tableName, { columnsOnly = false } = {}) {
  if (!tableName) return;
  document.getElementById('field-settings-table-name').textContent = tableName;
  document.getElementById('field-settings-desc').textContent = columnsOnly
    ? "Uncheck columns you don't need in the table view. Saved on this computer only."
    : "Uncheck fields you don't want to see when opening a task. Saved on this computer only.";
  const list = document.getElementById('field-settings-list');
  list.innerHTML = '';
  const hidden = new Set(state.hiddenFields[tableName] || []);
  const allFields = state.tables[tableName]?.fields || [];
  const tableFieldNames = allFields.map(f => f.name);
  const fields = columnsOnly
    ? COLUMNS.filter(name => tableFieldNames.includes(name)).map(name => allFields.find(f => f.name === name))
    : allFields;
  fields.forEach(field => {
    const lbl = document.createElement('label');
    lbl.className = 'field-settings-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !hidden.has(field.name);
    cb.onchange = () => {
      const set = new Set(state.hiddenFields[tableName] || []);
      cb.checked ? set.delete(field.name) : set.add(field.name);
      state.hiddenFields[tableName] = [...set];
      localStorage.setItem('higgtable_hidden_fields', JSON.stringify(state.hiddenFields));
      if (currentDetailRecord && currentDetailTable === tableName) renderRecordModal(currentDetailRecord, tableName);
      if (state.activeTable === tableName) render();
    };
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + field.name));
    list.appendChild(lbl);
  });
  document.getElementById('field-settings-modal').classList.remove('hidden');
}

function closeFieldSettings() {
  document.getElementById('field-settings-modal').classList.add('hidden');
}

// These are what a designer actually fills in when wrapping up a task —
// pinned to the top of the modal, in a compact card, so they don't have to
// scroll past Description/REF/Date/Format/Priority/Status to find them.
// The short ones sit in a grid; links/attachments need the full width.
const PINNED_GRID_FIELDS = ['Hours', 'Date Done', 'Timing'];
const PINNED_STACK_FIELDS = ['Preview', 'Creative Link', 'Figma/Canvas link'];

// ── Description → referenced task links ──────────────────────────────────

// Every cached record across all tables, flattened for reference matching: a
// Description in one table routinely points at a task in another.
function allCachedRecordsForRefs() {
  const out = [];
  const seen = new Set();
  const add = (r, table) => {
    if (!r || seen.has(r.id)) return;
    seen.add(r.id);
    out.push({ id: r.id, name: r.fields['Name'] || '', format: r.fields['Format'] || '', rec: r, table });
  };
  // The active table's rows live in state.records while it is still loading —
  // recordsCache is only filled in once a load finishes, and a full load takes
  // minutes, so relying on the cache alone misses the table in front of you.
  (state.records || []).forEach(r => add(r, state.activeTable));
  TARGET_TABLES.forEach(table => (recordsCache[table] || []).forEach(r => add(r, table)));
  return out;
}

// Adds one button per referenced task found in a Description. A shorthand like
// "PL_6940" can match several variants, so every match gets its own button
// labelled with the full name — the alternative, opening the "best" match,
// silently sends the user to the wrong creative.
function appendTaskRefLinks(container, text, currentRecordId) {
  const refs = extractTaskRefs(text);
  if (!refs.length) return;

  const pool = allCachedRecordsForRefs();
  const buttons = [];
  const usedIds = new Set();

  const unmatched = [];
  refs.forEach(ref => {
    const hits = matchRefToRecords(ref, pool).filter(m => m.id !== currentRecordId);
    if (!hits.length) { unmatched.push(ref); return; }
    hits.forEach(match => {
      if (usedIds.has(match.id)) return;
      usedIds.add(match.id);
      buttons.push({ ref, match });
    });
  });
  if (!buttons.length && !unmatched.length) return;

  const wrap = document.createElement('div');
  wrap.className = 'task-ref-links';

  buttons.forEach(({ match }) => {
    const fieldName = resolveFieldName(
      (state.tables[match.table]?.fields || []).map(f => f.name),
      linkFieldForRecord(match),
    );
    const url = fieldName ? String(match.rec.fields[fieldName] || '').trim() : '';
    const kind = linkFieldForRecord(match) === FIGMA_LINK_FIELD ? 'Figma' : 'Drive';

    const btn = document.createElement('button');
    btn.className = 'task-ref-link';
    btn.innerHTML = iconSvg('external');
    btn.append(`${kind} ${match.name}`);
    if (url) {
      btn.title = `Open ${fieldName} for ${match.name}`;
      btn.onclick = () => window.app.openExternal(rewriteDriveLink(url, state.driveAccountIndex));
    } else {
      // Shown but inert: knowing the referenced task has no link yet is more
      // useful than the button silently not appearing.
      btn.disabled = true;
      btn.title = fieldName
        ? `${match.name} has no ${fieldName} yet`
        : `${match.table} has no ${linkFieldForRecord(match)} field`;
    }
    wrap.appendChild(btn);
  });

  // A reference that matches nothing still gets a chip. Rendering nothing at all
  // is indistinguishable from the feature being broken — this says whether the
  // task is simply not loaded yet, which is common while a table is still
  // fetching, or genuinely absent.
  unmatched.forEach(ref => {
    const chip = document.createElement('button');
    chip.className = 'task-ref-link';
    chip.textContent = `? ${ref}`;
    chip.disabled = true;
    chip.title = `No task named "${ref}" among the ${pool.length} records loaded so far — it may still be loading, or live in a table that is not open.`;
    wrap.appendChild(chip);
  });

  // Placed ABOVE the field, not after it: a Description box is often several
  // hundred pixels tall, so buttons appended below it sit off-screen and read as
  // missing. Here they land right beside the "Description" label.
  container.insertBefore(wrap, container.firstChild);
}

function renderRecordModal(rec, tableName) {
  document.getElementById('record-modal-title').textContent = rec.fields['Name'] || 'Task details';
  const body = document.getElementById('record-modal-body');
  body.innerHTML = '';

  const hidden = new Set(state.hiddenFields[tableName] || []);
  const fields = (state.tables[tableName]?.fields || []).filter(f => !hidden.has(f.name));

  const byName = new Map(fields.map(f => [f.name, f]));
  const gridFields = PINNED_GRID_FIELDS.map(name => byName.get(name)).filter(Boolean);
  const stackFields = PINNED_STACK_FIELDS.map(name => byName.get(name)).filter(Boolean);
  const pinnedNames = new Set([...gridFields, ...stackFields].map(f => f.name));
  const rest = fields.filter(f => !pinnedNames.has(f.name));

  const appendFieldRow = (field, container = body) => {
    const row = document.createElement('div');
    row.className = 'record-field-row';

    const label = document.createElement('div');
    label.className = 'record-field-label';
    label.textContent = field.name;
    row.appendChild(label);

    const valueEl = document.createElement('div');
    valueEl.className = 'record-field-value';
    valueEl.appendChild(buildFieldInput(rec, tableName, field, rec.fields[field.name]));
    row.appendChild(valueEl);
    if (/description/i.test(field.name)) {
      appendTaskRefLinks(valueEl, rec.fields[field.name], rec.id);
    }
    container.appendChild(row);
  };

  if (gridFields.length || stackFields.length) {
    const card = document.createElement('div');
    card.className = 'record-wrapup-card';

    const header = document.createElement('div');
    header.className = 'record-field-section-header';
    header.textContent = 'Wrap up task';
    card.appendChild(header);

    if (gridFields.length) {
      const grid = document.createElement('div');
      grid.className = 'record-wrapup-grid';
      gridFields.forEach(field => {
        const cell = document.createElement('div');
        cell.className = 'record-wrapup-cell';
        const label = document.createElement('label');
        label.textContent = field.name;
        cell.appendChild(label);
        const valueEl = document.createElement('div');
        valueEl.className = 'record-field-value';
        valueEl.appendChild(buildFieldInput(rec, tableName, field, rec.fields[field.name]));
        cell.appendChild(valueEl);
        grid.appendChild(cell);
      });
      card.appendChild(grid);
    }

    stackFields.forEach(field => appendFieldRow(field, card));
    body.appendChild(card);
  }

  rest.forEach(field => appendFieldRow(field));
}

function buildFieldInput(rec, tableName, field, val) {
  const type = field.type;

  if (READONLY_FIELD_TYPES.has(type)) {
    const span = document.createElement('span');
    span.className = 'record-readonly';
    span.textContent = formatReadonlyValue(val);
    return span;
  }

  if (type === 'multipleAttachments') return buildAttachmentField(rec, tableName, field, val);

  if (type === 'multipleRecordLinks') {
    const span = document.createElement('span');
    span.className = 'record-readonly';
    span.textContent = Array.isArray(val) ? `${val.length} linked record(s)` : '';
    span.title = "Linked records aren't editable here — use Airtable directly.";
    return span;
  }

  if (type === 'singleSelect') {
    const sel = document.createElement('select');
    sel.appendChild(new Option('—', ''));
    (field.options?.choices || []).forEach(choice => sel.appendChild(new Option(choice.name, choice.name)));
    sel.value = val || '';
    sel.onchange = () => updateRecordField(rec, tableName, field, sel.value || null, sel);
    return sel;
  }

  if (type === 'multipleSelects') return buildMultiSelectField(rec, tableName, field, val);

  if (type === 'checkbox') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!val;
    cb.onchange = () => updateRecordField(rec, tableName, field, cb.checked, cb);
    return cb;
  }

  if (type === 'date' || type === 'dateTime') {
    const inp = document.createElement('input');
    inp.type = 'date';
    inp.value = val ? String(val).slice(0, 10) : '';
    inp.onchange = () => updateRecordField(rec, tableName, field, inp.value || null, inp);
    return inp;
  }

  if (type === 'number' || type === 'currency' || type === 'percent' || type === 'duration') {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.value = val == null ? '' : val;
    inp.onchange = () => updateRecordField(rec, tableName, field, inp.value === '' ? null : Number(inp.value), inp);
    return inp;
  }

  if (type === 'multilineText' || type === 'richText') return buildMarkdownField(rec, tableName, field, val);

  // Fallback for singleLineText, url, email, phoneNumber, and anything else
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = val == null ? '' : String(val);
  inp.onblur = () => updateRecordField(rec, tableName, field, inp.value || null, inp);

  if (typeof val !== 'string' || !/^https?:\/\//i.test(val)) return inp;

  const wrap = document.createElement('div');
  wrap.className = 'record-text-field-with-link';
  wrap.appendChild(inp);

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'field-open-link-btn';
  openBtn.title = 'Open link';
  openBtn.innerHTML = `<svg class="icon-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/>
    <path d="M9.5 2.5h4v4"/>
    <path d="M13 3l-6 6"/>
  </svg>`;
  openBtn.onclick = () => window.app.openExternal(rewriteDriveLink(inp.value, state.driveAccountIndex));
  wrap.appendChild(openBtn);
  return wrap;
}

// Shows rendered markdown by default; clicking swaps to a plain textarea
// for editing, and blurring re-renders. Tall by default since these are
// often multi-paragraph creative briefs.
function buildMarkdownField(rec, tableName, field, val) {
  const wrap = document.createElement('div');
  wrap.className = 'record-markdown-field';

  const preview = document.createElement('div');
  preview.className = 'record-markdown-preview';

  const ta = document.createElement('textarea');
  ta.className = 'record-markdown-textarea hidden';
  ta.rows = 10;
  ta.value = val == null ? '' : String(val);

  const renderPreview = () => {
    preview.innerHTML = ta.value
      ? renderMarkdownLite(ta.value)
      : '<span class="record-markdown-empty">Click to add...</span>';
  };
  const showEditor = () => {
    preview.classList.add('hidden');
    ta.classList.remove('hidden');
    ta.focus();
  };
  const showPreview = () => {
    renderPreview();
    ta.classList.add('hidden');
    preview.classList.remove('hidden');
  };

  preview.onclick = (e) => {
    const link = e.target.closest('a.record-markdown-link');
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      window.app.openExternal(rewriteDriveLink(link.href, state.driveAccountIndex));
      return;
    }
    showEditor();
  };
  ta.onblur = () => {
    updateRecordField(rec, tableName, field, ta.value || null, ta);
    showPreview();
  };

  renderPreview();
  wrap.appendChild(preview);
  wrap.appendChild(ta);
  return wrap;
}

function formatReadonlyValue(val) {
  if (val == null) return '';
  if (Array.isArray(val)) return val.map(v => (v && typeof v === 'object') ? (v.name || v.id || JSON.stringify(v)) : v).join(', ');
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// Multi-select fields can have dozens of options (e.g. Tags) — a checkbox
// per choice becomes an unreadable wall, so instead show only the selected
// values as removable chips, with a compact dropdown to add more.
function buildMultiSelectField(rec, tableName, field, val) {
  const wrap = document.createElement('div');
  wrap.className = 'record-multiselect';
  const current = new Set(Array.isArray(val) ? val : []);
  const choices = field.options?.choices || [];

  const chipsRow = document.createElement('div');
  chipsRow.className = 'record-chips';

  const addSelect = document.createElement('select');
  addSelect.className = 'record-chip-add';

  function renderChips() {
    chipsRow.innerHTML = '';
    [...current].forEach(name => {
      const chip = document.createElement('span');
      chip.className = 'record-chip';
      chip.textContent = name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'record-chip-remove';
      remove.innerHTML = iconSvg('close');
      remove.onclick = () => {
        current.delete(name);
        renderChips();
        renderAddOptions();
        updateRecordField(rec, tableName, field, [...current], wrap);
      };
      chip.appendChild(remove);
      chipsRow.appendChild(chip);
    });
  }

  function renderAddOptions() {
    addSelect.innerHTML = '';
    addSelect.appendChild(new Option(choices.length ? '+ Add...' : '(no options)', ''));
    choices.filter(c => !current.has(c.name)).forEach(c => addSelect.appendChild(new Option(c.name, c.name)));
  }

  addSelect.onchange = () => {
    if (!addSelect.value) return;
    current.add(addSelect.value);
    renderChips();
    renderAddOptions();
    updateRecordField(rec, tableName, field, [...current], wrap);
  };

  renderChips();
  renderAddOptions();
  wrap.appendChild(chipsRow);
  wrap.appendChild(addSelect);
  return wrap;
}

function buildAttachmentField(rec, tableName, field, val) {
  const wrap = document.createElement('div');
  wrap.className = 'record-attachment-field';

  const gallery = document.createElement('div');
  gallery.className = 'record-attachment-gallery';
  (val || []).forEach(att => {
    const img = document.createElement('img');
    img.className = 'record-attachment-thumb';
    img.src = (att.thumbnails?.large?.url) || att.url;
    img.title = att.filename || '';
    img.loading = 'lazy';
    gallery.appendChild(img);
  });
  wrap.appendChild(gallery);

  const uploadRow = document.createElement('div');
  uploadRow.className = 'record-upload-section';
  const btn = document.createElement('button');
  btn.textContent = 'Upload photo';
  const status = document.createElement('span');
  status.className = 'record-upload-status';
  btn.onclick = () => uploadAttachmentToField(rec, tableName, field, status);
  uploadRow.appendChild(btn);
  uploadRow.appendChild(status);
  wrap.appendChild(uploadRow);

  return wrap;
}

async function uploadAttachmentToField(rec, tableName, field, statusEl) {
  const paths = await window.app.openFileDialog();
  if (!paths.length) return;
  statusEl.className = 'record-upload-status';
  statusEl.textContent = 'Uploading...';
  try {
    const result = await window.airtable.uploadAttachment(state.baseId, rec.id, field.name, paths[0]);
    rec.fields[field.name] = uploadedAttachments(result, field.name);
    log(`uploadAttachmentToField: uploaded ${paths[0]} to ${field.name} on record ${rec.id}`);
    if (currentDetailRecord && currentDetailRecord.id === rec.id) {
      renderRecordModal(rec, tableName);
      document.querySelector('.record-upload-status').textContent = 'Uploaded!';
    }
  } catch (err) {
    statusEl.className = 'record-upload-status error';
    statusEl.textContent = `Error: ${err.message}`;
    log(`uploadAttachmentToField: FAILED — ${err.message}`);
  }
}

async function updateRecordField(rec, tableName, field, newValue, inputEl) {
  const tableInfo = state.tables[tableName];
  try {
    const result = await window.airtable.updateRecord(state.baseId, tableInfo.id, rec.id, { [field.name]: newValue });
    rec.fields[field.name] = result.fields[field.name];
    flashFieldStatus(inputEl, 'saved');
    log(`updateRecordField: ${field.name} on record ${rec.id} -> ${JSON.stringify(newValue)}`);
    if (field.name === 'Name') {
      document.getElementById('record-modal-title').textContent = rec.fields['Name'] || 'Task details';
    }
    // Edits to fields like Status/DES can change what's visible in the main
    // table or the dashboard totals — keep both in sync immediately.
    if (state.activeTable === tableName) render();
    maybeRefreshDashboard();
  } catch (err) {
    flashFieldStatus(inputEl, 'error', err.message);
    log(`updateRecordField: FAILED for ${field.name} — ${err.message}`);
  }
}

function flashFieldStatus(el, kind, errMsg) {
  if (!el) return;
  el.classList.remove('field-saved', 'field-error');
  el.title = '';
  if (kind === 'saved') {
    el.classList.add('field-saved');
    setTimeout(() => el.classList.remove('field-saved'), 1000);
  } else if (kind === 'error') {
    el.classList.add('field-error');
    el.title = errMsg || 'Update failed';
    toastError(`Failed to save: ${errMsg}`);
  }
}

// ── Task search ──────────────────────────────────────────────────────────

// Searches every loaded table, so a task can be found without knowing which tab
// it lives in. Reuses goToRecord, which already switches tab, re-enables the
// task's Status chip (otherwise the current filter would hide the row it just
// jumped to) and highlights the row.
function renderTaskSearchResults() {
  const input = document.getElementById('task-search');
  const box = document.getElementById('task-search-results');
  const hits = searchTasks(input.value, allCachedRecordsForRefs(), { limit: 25 });

  box.innerHTML = '';
  if (!input.value.trim()) { box.classList.add('hidden'); return; }

  if (!hits.length) {
    const empty = document.createElement('div');
    empty.className = 'task-search-empty';
    empty.textContent = normalizeForSearch(input.value).length < MIN_QUERY_LENGTH
      ? `Type at least ${MIN_QUERY_LENGTH} characters`
      : 'No task found in the loaded tables';
    box.appendChild(empty);
    box.classList.remove('hidden');
    return;
  }

  hits.forEach(hit => {
    const row = document.createElement('div');
    row.className = 'task-search-row';

    const open = document.createElement('button');
    open.className = 'task-search-open';
    open.textContent = hit.name;
    open.title = `Open ${hit.name} in ${hit.table}`;
    open.onclick = () => {
      closeTaskSearch();
      goToRecord(hit.rec, hit.table);
      openRecordModal(hit.rec, hit.table);
    };
    row.appendChild(open);

    const tableTag = document.createElement('span');
    tableTag.className = 'task-search-table';
    tableTag.textContent = hit.table.replace(/ Creatives$/, '');
    row.appendChild(tableTag);

    const lineage = document.createElement('button');
    lineage.className = 'task-search-lineage';
    lineage.innerHTML = iconSvg('lineage');
    lineage.title = `Open this task's lineage in Canvas`;
    lineage.onclick = () => {
      closeTaskSearch();
      // Canvas builds lineages from the ACTIVE table's records, so the tab has
      // to change first or the lineage would be looked up in the wrong table.
      if (state.activeTable !== hit.table) goToRecord(hit.rec, hit.table);
      openLineageFor(hit.rec);
    };
    row.appendChild(lineage);

    box.appendChild(row);
  });
  box.classList.remove('hidden');
}

function closeTaskSearch({ clear = false } = {}) {
  const box = document.getElementById('task-search-results');
  box.classList.add('hidden');
  if (clear) document.getElementById('task-search').value = '';
}

// ── Command palette (⌘K / Ctrl+K) ──────────────────────────────────────────
// One box for actions and tasks: type a few letters of a command ("autofill",
// "copy brief", "drive") or of a task name, arrow to it, Enter. Actions mostly
// click the app's own buttons, so they behave exactly like the mouse.
const clickById = id => () => document.getElementById(id)?.click();
const hasSelection = () => state.selectedIds.size > 0;
const hasTask = () => !!state.selectedTask;
const openPanelLink = label => () => {
  [...document.querySelectorAll('#task-panel-links button')].find(b => b.textContent.trim() === label)?.click();
};
const panelLinkExists = label => () =>
  hasTask() && [...document.querySelectorAll('#task-panel-links button')].some(b => b.textContent.trim() === label);
const PALETTE_COMMANDS = [
  { label: 'Finish selected tasks', icon: 'play', when: hasSelection, run: clickById('bulk-finish-btn') },
  { label: 'Resize', icon: 'expand', when: hasSelection, run: clickById('bulk-resize-btn') },
  { label: 'Compress', icon: 'down', when: hasSelection, run: clickById('bulk-compress-btn') },
  { label: 'Autofill', icon: 'check', when: hasSelection, run: clickById('bulk-autofill-btn') },
  { label: 'Mark as To Accept', icon: 'check', when: hasSelection, run: clickById('bulk-mark-accept-btn') },
  { label: 'Mark as In Work', icon: 'undo', when: hasSelection, run: clickById('bulk-mark-inwork-btn') },
  { label: 'Copy name', hint: '⌘C', icon: 'copy', when: hasSelection, run: () => copySelectedTasks('name') },
  { label: 'Copy name + brief', hint: '⌘⇧C', icon: 'brief', when: hasSelection, run: () => copySelectedTasks('brief') },
  { label: 'Copy name + brief + REF', icon: 'link', when: hasSelection, run: () => copySelectedTasks('ref') },
  { label: 'Open Drive link', icon: 'external', when: panelLinkExists('Drive'), run: openPanelLink('Drive') },
  { label: 'Open GD folder (Google Drive)', icon: 'folder', when: hasSelection, run: () => openDriveFoldersFor(
    state.records.filter(r => state.selectedIds.has(r.id) && r.fields['Name'])) },
  { label: 'Open Figma link', icon: 'external', when: panelLinkExists('Figma'), run: openPanelLink('Figma') },
  { label: 'Open REF link', icon: 'external', when: panelLinkExists('REF'), run: openPanelLink('REF') },
  { label: 'Open task folder', icon: 'folder', when: hasTask, run: clickById('task-panel-folder-btn') },
  { label: 'Open all fields', icon: 'expand', when: hasTask, run: () => openRecordModal(state.selectedTask, state.activeTable) },
  { label: 'Clear selection', icon: 'close', when: hasSelection, run: clickById('bulk-clear-btn') },
  { label: 'Table view', icon: 'table', run: () => document.querySelector('#view-toggle [data-view="table"]').click() },
  { label: 'Board view', icon: 'board', run: () => document.querySelector('#view-toggle [data-view="board"]').click() },
  ...TARGET_TABLES.map(t => ({ label: `Go to ${t.replace(' Creatives', '')}`, icon: 'table', run: () => document.querySelector(`.tab[data-table="${t}"]`)?.click() })),
  { label: 'Dashboard', icon: 'dashboard', run: clickById('dashboard-btn') },
  { label: 'Workload', icon: 'workload', run: clickById('workload-btn') },
  { label: 'Canvas', icon: 'lineage', run: clickById('canvas-btn') },
  { label: 'Refresh this table', icon: 'refresh', run: clickById('refresh-btn') },
  { label: 'Reload previews', icon: 'image', run: () => {
    const recs = (state.visibleRecords || []).filter(r => (r.fields['Preview'] || []).length);
    recs.forEach(r => requestPreviewRefresh(r, { force: true }));
    toast(`Reloading ${recs.length} preview${recs.length === 1 ? '' : 's'}…`);
  } },
  { label: 'Settings', icon: 'settings', run: clickById('settings-btn') },
];
// Commands built from what is loaded: every status (set it on the selection,
// or filter by it), every designer, the dashboard periods and workload tables.
// They come after the fixed list, so they show when typing, not on an empty
// palette.
const ALL_STATUSES = ['Backlog', 'Rework', 'Ready for Design', 'In work', 'To accept', 'Done'];

function showTableView() {
  if (!document.getElementById('records-container').classList.contains('hidden')) return;
  document.querySelector(`.tab[data-table="${state.activeTable}"]`)?.click();
}

function dynamicPaletteCommands() {
  const statuses = state.statusOptions.length ? state.statusOptions : ALL_STATUSES;
  const setFilter = list => () => {
    showTableView();
    state.activeStatuses = new Set(list);
    renderStatusChips();
    render();
  };
  const setDesigner = des => () => {
    showTableView();
    const sel = document.getElementById('des-select');
    sel.value = des;
    sel.dispatchEvent(new Event('change'));
  };
  const presets = [...document.querySelectorAll('#dashboard-controls .dash-preset')]
    .filter(b => b.dataset.preset !== 'custom');
  const scopes = [...document.querySelectorAll('#workload-controls .workload-scope')];
  return [
    ...statuses.map(st => ({
      label: `Set status: ${st}`, icon: 'check', when: hasSelection,
      run: () => moveToStatus([...state.selectedIds], st),
    })),
    ...statuses.map(st => ({ label: `Filter status: ${st}`, icon: 'search', run: setFilter([st]) })),
    { label: 'Filter status: all', icon: 'search', run: setFilter([]) },
    { label: 'Designer: All', icon: 'workload', run: setDesigner('') },
    ...state.allDES.map(d => ({ label: `Designer: ${d}`, icon: 'workload', run: setDesigner(d) })),
    { label: 'Choose columns', icon: 'table', run: () => { showTableView(); document.getElementById('columns-btn')?.click(); } },
    { label: 'Dashboard: Compact view', icon: 'dashboard', run: () => { document.getElementById('dashboard-btn').click(); document.querySelector('[data-dash-view="compact"]').click(); } },
    { label: 'Dashboard: Detailed view', icon: 'dashboard', run: () => { document.getElementById('dashboard-btn').click(); document.querySelector('[data-dash-view="detailed"]').click(); } },
    ...presets.map(b => ({
      label: `Dashboard: ${b.textContent.trim()}`, icon: 'dashboard',
      run: () => { document.getElementById('dashboard-btn').click(); b.click(); },
    })),
    ...scopes.map(b => ({
      label: `Workload: ${b.textContent.trim()}`, icon: 'workload',
      run: () => { document.getElementById('workload-btn').click(); b.click(); },
    })),
  ];
}

// A search hit's own link: Creative Link for a Video, Figma/Canvas for a Stat
// (LB spells its Figma field with a Cyrillic "а", hence the fallback).
function taskHitLink(hit) {
  const names = (state.tables[hit.table]?.fields || []).map(f => f.name);
  const wanted = linkFieldForRecord(hit);
  let field = resolveFieldName(names, wanted);
  if (!field && wanted === FIGMA_LINK_FIELD) field = names.find(n => /^fig/i.test(n) && /link/i.test(n));
  const url = field ? String(hit.rec.fields[field] || '').trim() : '';
  return { kind: wanted === FIGMA_LINK_FIELD ? 'Figma' : 'Drive', url: /^https?:\/\//i.test(url) ? url : '' };
}

async function copyPaletteText(text, what) {
  try {
    await window.app.copyToClipboard(text);
    toast(`Copied ${what}`);
  } catch (err) {
    toastError(`Could not copy: ${err.message}`);
  }
}

// What a task hit can do besides going to it (⌘↵ / ⇧↵ / ⌥↵).
function taskHitActions(hit) {
  const rec = hit.rec;
  const name = rec.fields['Name'] || hit.name;
  const link = taskHitLink(hit);
  return {
    link: link.url ? { label: `Open ${link.kind}`, run: () => window.app.openExternal(rewriteDriveLink(link.url, state.driveAccountIndex)) } : null,
    linkKind: link.kind,
    copyName: () => copyPaletteText(name, 'the name'),
    copyBrief: () => copyPaletteText(formatNameAndBriefs([{ name, description: rec.fields['Description'], ref: rec.fields['REF'] }]), 'name + brief'),
  };
}

let paletteItems = [];
let paletteIndex = 0;

function openPalette() {
  const input = document.getElementById('palette-input');
  input.value = '';
  document.getElementById('palette').classList.remove('hidden');
  renderPalette();
  input.focus();
}

function closePalette() {
  document.getElementById('palette').classList.add('hidden');
}

function renderPalette() {
  const q = document.getElementById('palette-input').value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const commands = [...PALETTE_COMMANDS, ...dynamicPaletteCommands()]
    .filter(c => !c.when || c.when())
    .filter(c => words.every(w => c.label.toLowerCase().includes(w)))
    .map(c => ({ kind: 'command', ...c }));
  const tasks = q.length >= MIN_QUERY_LENGTH
    ? searchTasks(q, allCachedRecordsForRefs(), { limit: 8 }).map(hit => ({
      kind: 'task', label: hit.name, hint: hit.table.replace(' Creatives', ''),
      icon: FORMAT_ICONS[hit.format] || 'image',
      run: () => goToRecord(hit.rec, hit.table),
      actions: taskHitActions(hit),
    }))
    : [];
  paletteItems = [...commands.slice(0, q ? 10 : 12), ...tasks];
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
  if (!q) paletteIndex = 0;

  const list = document.getElementById('palette-list');
  list.replaceChildren();
  if (!paletteItems.length) {
    const empty = document.createElement('div');
    empty.className = 'palette-empty';
    empty.textContent = 'Nothing matches';
    list.append(empty);
    return;
  }
  let lastKind = null;
  paletteItems.forEach((item, i) => {
    if (item.kind !== lastKind) {
      const group = document.createElement('div');
      group.className = 'palette-group';
      group.textContent = item.kind === 'task' ? 'Tasks · ↵ go to · ⌘↵ open link · ⇧↵ copy name · ⌥↵ name + brief' : 'Actions';
      list.append(group);
      lastKind = item.kind;
    }
    const row = document.createElement('div');
    row.className = `palette-item${i === paletteIndex ? ' active' : ''}${item.kind === 'task' ? ' task' : ''}`;
    row.setAttribute('role', 'option');
    row.innerHTML = iconSvg(item.icon);
    const label = document.createElement('span');
    label.className = 'palette-label';
    label.textContent = item.label;
    row.append(label);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'palette-hint';
      hint.textContent = item.hint;
      row.append(hint);
    }
    if (item.actions) {
      const act = (icon, title, fn, disabled) => {
        const b = document.createElement('button');
        b.className = 'palette-act';
        b.innerHTML = iconSvg(icon);
        b.title = title;
        b.disabled = !!disabled;
        b.onclick = e => { e.stopPropagation(); closePalette(); fn(); };
        row.append(b);
      };
      const a = item.actions;
      act('external', a.link ? `${a.link.label} (⌘↵)` : `No ${a.linkKind} link yet`, () => a.link && a.link.run(), !a.link);
      act('copy', 'Copy name (⇧↵)', a.copyName);
      act('brief', 'Copy name + brief (⌥↵)', a.copyBrief);
    }
    row.onmousemove = () => { if (paletteIndex !== i) { paletteIndex = i; highlightPalette(); } };
    row.onclick = () => runPaletteItem(i);
    list.append(row);
  });
}

function highlightPalette() {
  document.querySelectorAll('#palette-list .palette-item').forEach((el, i) => el.classList.toggle('active', i === paletteIndex));
  document.querySelector('#palette-list .palette-item.active')?.scrollIntoView({ block: 'nearest' });
}

// `mod` picks a task hit's other action: 'link' (⌘↵), 'name' (⇧↵), 'brief' (⌥↵).
function runPaletteItem(i, mod = null) {
  const item = paletteItems[i];
  if (!item) return;
  if (mod && item.actions) {
    const a = item.actions;
    if (mod === 'link' && !a.link) { toast(`${item.label} has no ${a.linkKind} link yet`); return; }
    closePalette();
    log(`palette: task "${item.label}" ${mod}`);
    if (mod === 'link') a.link.run();
    else if (mod === 'name') a.copyName();
    else a.copyBrief();
    return;
  }
  closePalette();
  log(`palette: ${item.kind} "${item.label}"`);
  item.run();
}

// ── Toasts ──────────────────────────────────────────────────────────────
// Short notices in the bottom-right corner instead of blocking alert() boxes.
// Info fades after a few seconds; an error stays until it is closed. An
// optional action button (e.g. Undo) runs once and closes the toast.
function toast(message, { type = 'info', action = null, duration } = {}) {
  const stack = document.getElementById('toast-stack');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = iconSvg(type === 'error' ? 'warning' : 'check');
  const text = document.createElement('div');
  text.className = 'toast-text';
  text.textContent = String(message);
  el.append(text);
  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.onclick = () => { close(); action.run(); };
    el.append(btn);
  }
  const x = document.createElement('button');
  x.className = 'toast-close';
  x.title = 'Close';
  x.setAttribute('aria-label', 'Close');
  x.innerHTML = iconSvg('close');
  x.onclick = close;
  el.append(x);
  stack.append(el);
  const ms = duration ?? (type === 'error' ? 0 : action ? 8000 : 4000);
  if (ms) setTimeout(close, ms);
  log(`toast(${type}): ${String(message).split('\n')[0]}`);
  return el;
}

function toastError(message) {
  return toast(message, { type: 'error' });
}

function toastNeedsWorkingDirectory() {
  toast('Set a working directory first.', { action: { label: 'Open Settings', run: () => showSettingsModal() } });
}

// Shows a check (with the count, or a short message) on a button for a moment:
// a clipboard write is otherwise invisible. The button's own markup, icon
// included, is put back afterwards.
function flashCopied(btn, count, message) {
  if (!btn) return;
  if (btn._flashOriginal == null) btn._flashOriginal = btn.innerHTML;
  btn.innerHTML = message ? '' : iconSvg('check');
  const extra = message || (count > 1 ? String(count) : '');
  if (extra) btn.append(extra);
  btn.classList.add('flashed');
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => {
    btn.innerHTML = btn._flashOriginal;
    btn._flashOriginal = null;
    btn.classList.remove('flashed');
  }, 1200);
}

// The side panel's width follows a drag on its left edge and is remembered on
// this computer; a double-click puts it back to the default.
const PANEL_WIDTH_KEY = 'higgtable_panel_width';
const PANEL_MIN_WIDTH = 280;
function initTaskPanelResizer() {
  const panel = document.getElementById('task-panel');
  const handle = document.getElementById('task-panel-resizer');
  const clamp = w => Math.round(Math.min(Math.max(w, PANEL_MIN_WIDTH), window.innerWidth * 0.6));
  const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
  if (saved) panel.style.width = `${clamp(saved)}px`;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    const right = panel.getBoundingClientRect().right;
    document.body.classList.add('resizing-panel');
    const move = ev => { panel.style.width = `${clamp(right - ev.clientX)}px`; };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-panel');
      localStorage.setItem(PANEL_WIDTH_KEY, String(parseInt(panel.style.width, 10)));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  handle.addEventListener('dblclick', () => {
    panel.style.width = '';
    localStorage.removeItem(PANEL_WIDTH_KEY);
  });
}

// Puts each [data-icon] element's icon in front of its label (once). An
// icon-only button gets its tooltip as its accessible name.
function applyIcons(root) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    if (el.querySelector(':scope > .icon-svg')) return;
    if (!el.textContent.trim() && el.title && !el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.title);
    el.insertAdjacentHTML('afterbegin', iconSvg(el.dataset.icon));
  });
}

// Copies the selected tasks, sorted by name so a multi-row copy lands in the
// same order everything else in this app uses:
//   'name'  names, one per line (pastes straight into a list)
//   'brief' name + brief per task, tasks separated by a blank line
//   'ref'   the same plus a "REF: <link>" line
const COPY_BUTTONS = { name: 'bulk-copy-name-btn', brief: 'bulk-copy-brief-btn', ref: 'bulk-copy-ref-btn' };
async function copySelectedTasks(kind) {
  const recs = state.records
    .filter(r => state.selectedIds.has(r.id) && r.fields['Name'])
    .sort((a, b) => compareTaskNames(a.fields['Name'], b.fields['Name']));
  if (!recs.length) return;
  const text = kind === 'name'
    ? recs.map(r => r.fields['Name']).join('\n')
    : formatNameAndBriefs(
      recs.map(r => ({ name: r.fields['Name'], description: r.fields['Description'], ref: r.fields['REF'] })),
      { withRef: kind === 'ref' },
    );
  try {
    await window.app.copyToClipboard(text);
    flashCopied(document.getElementById(COPY_BUTTONS[kind]), recs.length);
    log(`copySelectedTasks(${kind}): copied ${recs.length} task(s)`);
  } catch (err) {
    toastError(`Could not copy: ${err.message}`);
    log(`copySelectedTasks(${kind}): FAILED — ${err.message}`);
  }
}

// Task details modal: copies the open task's brief alone.
async function copyOpenTaskBrief() {
  if (!currentDetailRecord) return;
  const btn = document.getElementById('copy-brief-btn');
  const brief = briefFromDescription(currentDetailRecord.fields['Description']);
  if (!brief) {
    flashCopied(btn, 0, 'No brief');
    return;
  }
  try {
    await window.app.copyToClipboard(brief);
    flashCopied(btn, 1, 'Copied');
    log(`copyOpenTaskBrief: copied the brief of ${currentDetailRecord.fields['Name'] || currentDetailRecord.id}`);
  } catch (err) {
    toastError(`Could not copy: ${err.message}`);
    log(`copyOpenTaskBrief: FAILED — ${err.message}`);
  }
}

// ── Task selection & rename panel ────────────────────────────────────────

// Finder-style multi-select: plain click still picks a single task for
// renaming (unchanged); Shift-click extends a contiguous range for bulk
// actions, Cmd/Ctrl-click toggles one row in or out of that selection.
function onRowClick(rec, tr, e, index, filteredList) {
  if (e && e.shiftKey) {
    e.preventDefault();
    let anchorIndex = filteredList.findIndex(r => r.id === state.selectionAnchorId);
    if (anchorIndex === -1) anchorIndex = index;
    const [start, end] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
    for (let i = start; i <= end; i++) state.selectedIds.add(filteredList[i].id);
    state.selectionCursorId = rec.id;
    render();
    return;
  }
  if (e && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    state.selectedIds.has(rec.id) ? state.selectedIds.delete(rec.id) : state.selectedIds.add(rec.id);
    state.selectionAnchorId = rec.id;
    state.selectionCursorId = rec.id;
    render();
    return;
  }

  state.selectedIds.clear();
  state.selectionAnchorId = rec.id;
  state.selectionCursorId = rec.id;
  if (state.selectedTask && state.selectedTask.id === rec.id) {
    clearTaskSelection();
    render();
    return;
  }
  state.selectedTask = rec;
  // Select it as well, so the action bar appears for ONE task exactly as it does
  // for several. The bar's Autofill replaces the panel's own button, which only
  // existed because a single click used to leave nothing selected.
  state.selectedIds.add(rec.id);
  openRenamePanel(rec);
  render();
}

function openRenamePanel(rec) {
  const name = rec.fields['Name'] || '';
  document.getElementById('rename-task-name').textContent = name;
  document.getElementById('rename-panel').classList.remove('hidden');
  state.pendingFiles = [];
  renderFileList();
  renderTaskPanel();
}

function clearTaskSelection() {
  if (state.selectedTask) state.selectedIds.delete(state.selectedTask.id);
  state.selectedTask = null;
  document.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
  document.getElementById('rename-panel').classList.add('hidden');
  state.pendingFiles = [];
  renderTaskPanel();
}

function stripAspectRatio(name) {
  return name.replace(/_(9x16|16x9|1x1|4x5|1\.91x1|4x3|2x3)$/, '');
}

function ratioFromDimensions(w, h) {
  const r = w / h;
  if (r >= 1.85) return '1.91x1';
  if (r >= 1.6)  return '16x9';
  if (r >= 1.2)  return '4x3';
  if (r >= 0.9)  return '1x1';
  if (r >= 0.72) return '4x5';
  if (r >= 0.6)  return '2x3';
  return '9x16';
}

// Corrects one pending file in place — crop to the exact ratio, then scale to
// the delivery size — and re-measures it, so the list reflects the file on disk
// rather than what we intended to write.
async function applyRatioCrop(file, { silent = false } = {}) {
  if (!file || !file.fixPlan) return false;
  const plan = file.fixPlan;
  try {
    const { after } = await window.app.normalizeImage(file.path, {
      crop: plan.crop && { x: plan.crop.x, y: plan.crop.y, width: plan.crop.width, height: plan.crop.height },
      resize: plan.resize,
    });
    file.width = after.width;
    file.height = after.height;
    file.ratio = ratioFromDimensions(after.width, after.height);
    file.fixPlan = planRatioFix(after.width, after.height, file.ratio);
    log(`applyRatioCrop: ${file.name} -> ${after.width}x${after.height}`
      + `${plan.crop ? ` (cropped ${plan.crop.pixels}px of ${plan.crop.axis})` : ''}${plan.resize ? ' (scaled)' : ''}`);
    if (!silent) renderFileList();
    return true;
  } catch (err) {
    file.error = `Fix failed: ${err.message}`;
    log(`applyRatioCrop: FAILED for ${file.name} — ${err.message}`);
    if (!silent) renderFileList();
    return false;
  }
}

async function applyAllRatioCrops() {
  const pending = state.pendingFiles.filter(f => f.fixPlan);
  if (!pending.length) return;
  const btn = document.getElementById('fix-ratios-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Cropping...'; }
  let done = 0;
  for (const f of pending) if (await applyRatioCrop(f, { silent: true })) done += 1;
  if (btn) { btn.disabled = false; btn.textContent = 'Fix ratios'; }
  renderFileList();
  log(`applyAllRatioCrops: cropped ${done}/${pending.length} file(s)`);
}

// ── File handling ────────────────────────────────────────────────────────

async function addFiles(paths) {
  setStatus('Detecting dimensions...');
  for (const p of paths) {
    if (state.pendingFiles.find(f => f.path === p)) continue;
    const name = p.split('/').pop();
    try {
      const dims = await window.app.getFileDimensions(p);
      const ratio = ratioFromDimensions(dims.width, dims.height);
      const entry = { path: p, name, width: dims.width, height: dims.height, ratio };
      // Higgsfield nodes emit sizes that are a fraction of a percent off their
      // nominal ratio (1520x2688, 1536x2752, 2752x1536). Flag it here so it is
      // caught before the file is renamed and delivered.
      entry.fixPlan = planRatioFix(dims.width, dims.height, ratio);
      state.pendingFiles.push(entry);
      if (entry.fixPlan && state.autoFixRatio) await applyRatioCrop(entry, { silent: true });
    } catch (err) {
      state.pendingFiles.push({ path: p, name, error: err.message });
    }
  }
  renderFileList();
  setStatus(`${state.pendingFiles.length} file(s) ready`);
}

function renderFileList() {
  const list = document.getElementById('file-list');
  const footer = document.getElementById('rename-footer');
  list.innerHTML = '';

  if (!state.pendingFiles.length) {
    footer.classList.add('hidden');
    return;
  }

  const fullTaskName = state.selectedTask ? (state.selectedTask.fields['Name'] || '') : '';
  const taskName = stripAspectRatio(fullTaskName);

  state.pendingFiles.forEach(f => {
    const row = document.createElement('div');
    row.className = 'file-row';
    const makeSpan = (cls, text, title) => {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      if (title) s.title = title;
      return s;
    };
    if (f.error) {
      row.appendChild(makeSpan('fname', f.name, f.path));
      row.appendChild(makeSpan('ferror', f.error));
    } else {
      const ext = f.name.includes('.') ? f.name.split('.').pop() : '';
      const newName = taskName ? `${fullTaskName}/${taskName}_${f.ratio}.${ext}` : '(select a task first)';
      row.appendChild(makeSpan('fname', f.name, f.path));
      row.appendChild(makeSpan('fdims', `${f.width}×${f.height}`));
      row.appendChild(makeSpan('ftype ratio', f.ratio));
      row.appendChild(makeSpan('farrow', '→'));
      row.appendChild(makeSpan('fnew', newName, newName));
      if (f.fixPlan) {
        row.classList.add('off-ratio');
        // Lead with the ratio error when there is one; otherwise the file is the
        // right shape but not the delivery size.
        const warnText = f.fixPlan.crop
          ? `⚠ ${(f.fixPlan.crop.deviation * 100).toFixed(2)}%`
          : (f.fixPlan.upscale ? `⚠ small ×${f.fixPlan.scale.toFixed(2)}` : '⚠ size');
        row.appendChild(makeSpan('fratio-warn', warnText, describeRatioFix(f.fixPlan, f.ratio)));
        const fix = document.createElement('button');
        fix.className = 'fratio-fix';
        fix.textContent = `Fix → ${f.fixPlan.finalWidth}×${f.fixPlan.finalHeight}`;
        fix.title = describeRatioFix(f.fixPlan, f.ratio);
        fix.onclick = () => applyRatioCrop(f);
        row.appendChild(fix);
      }
    }
    list.appendChild(row);
  });

  // Check for duplicate ratios
  const ratios = state.pendingFiles.filter(f => !f.error).map(f => f.ratio);
  const dupes = ratios.filter((r, i) => ratios.indexOf(r) !== i);
  const warn = document.getElementById('rename-warning');
  if (dupes.length) {
    warn.innerHTML = iconSvg('warning');
    warn.append(`Duplicate ratio: ${[...new Set(dupes)].join(', ')}`);
  } else {
    warn.textContent = '';
  }

  const offRatio = state.pendingFiles.filter(f => f.fixPlan);
  const fixRow = document.getElementById('fix-ratios-row');
  // With auto-fix on, files are fixed as they arrive and nothing is ever left
  // to fix — the row must still show, or its checkbox could never be unticked.
  fixRow.classList.toggle('hidden', offRatio.length === 0 && !state.autoFixRatio);
  document.getElementById('fix-ratios-btn').classList.toggle('hidden', offRatio.length === 0);
  if (offRatio.length) {
    document.getElementById('fix-ratios-note').textContent =
      `${offRatio.length} file(s) need fixing — exact ratio, then 1080×1920 / 1920×1080 / 1080×1080. `
      + `Cropping loses at most ${Math.max(0, ...offRatio.map(f => (f.fixPlan.crop ? f.fixPlan.crop.pixels : 0)))}px.`;
  } else {
    document.getElementById('fix-ratios-note').textContent =
      'Sizes are fixed automatically as files are added.';
  }
  document.getElementById('auto-fix-ratio-input').checked = Boolean(state.autoFixRatio);

  footer.classList.remove('hidden');
}

const PREVIEW_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);


async function performRename() {
  const fullTaskName = state.selectedTask ? (state.selectedTask.fields['Name'] || '') : '';
  const taskName = stripAspectRatio(fullTaskName);
  if (!taskName) { toast('No task selected.'); return; }

  const toRename = state.pendingFiles.filter(f => !f.error);
  if (!toRename.length) { toast('No valid files to rename.'); return; }

  const errors = [];
  let renamed = 0;
  const previewCandidates = [];
  for (const f of toRename) {
    const ext = f.name.includes('.') ? f.name.split('.').pop() : '';
    const dir = f.path.substring(0, f.path.lastIndexOf('/'));
    const newName = `${taskName}_${f.ratio}.${ext}`;
    const newPath = `${dir}/${fullTaskName}/${newName}`;
    try {
      await window.app.renameFile(f.path, newPath);
      // Update in-place so a retry doesn't attempt the old (now-gone) path
      f.path = newPath;
      f.name = newName;
      renamed++;
      if (f.ratio === '1x1' && PREVIEW_IMAGE_EXTS.has(ext.toLowerCase())) previewCandidates.push(newPath);
    } catch (err) {
      errors.push(`${f.name}: ${err.message}`);
    }
  }

  // A 1x1 image is typically the ad's peekshot/thumbnail — auto-upload it as
  // the task's Preview so nobody has to do that step by hand in Airtable.
  let previewNote = '';
  if (previewCandidates.length && state.selectedTask) {
    for (const filePath of previewCandidates) {
      try {
        const result = await window.airtable.uploadAttachment(state.baseId, state.selectedTask.id, 'Preview', filePath);
        state.selectedTask.fields['Preview'] = uploadedAttachments(result, 'Preview');
        log(`performRename: auto-uploaded 1x1 preview ${filePath} to task ${state.selectedTask.id}`);
        previewNote = '\n\n1x1 image uploaded to the task’s Preview in Airtable.';
      } catch (err) {
        previewNote = `\n\nCouldn't auto-upload the 1x1 preview to Airtable: ${err.message}`;
        log(`performRename: preview upload FAILED — ${err.message}`);
      }
    }
    maybeRefreshDashboard();
  }

  if (errors.length) {
    toastError(`Renamed ${renamed} file(s).\n\nErrors:\n${errors.join('\n')}${previewNote}`);
  } else {
    toast(`Done! Renamed ${renamed} file(s).${previewNote}`);
    clearTaskSelection();
  }
}

// A task's "Name" field includes its own aspect-ratio suffix (e.g. "..._9x16"),
// so its assets live at "<name minus suffix>_1x1.png" (Preview image) and
// "<name minus suffix>_9x16.mp4" (used to derive Timing from duration)
// somewhere under the working directory (searched recursively) — mirrors the
// auto-upload-on-rename convention in performRename() above, but runs over
// whichever tasks the user Shift/Cmd-click-selected, with a review step
// before anything is actually written to Airtable.

// Airtable's "Timing" options mix ranges ("15-30s") with exact markers
// ("30s") for creatives authored to a standard length — a ±0.5s window
// around the round numbers absorbs normal encoder rounding.
const TIMING_BUCKETS = [
  { test: s => s < 10,                re: /^<\s*10\s*s?$/i },
  { test: s => s >= 10 && s < 15,     re: /^10\s*-\s*15\s*s?$/i },
  { test: s => s >= 15 && s < 29.5,   re: /^15\s*-\s*30\s*s?$/i },
  { test: s => s >= 29.5 && s < 30.5, re: /^30\s*s?$/i },
  { test: s => s >= 30.5 && s < 44.5, re: /^30\s*-\s*45\s*s?$/i },
  { test: s => s >= 44.5 && s < 45.5, re: /^45\s*s?$/i },
  { test: s => s >= 45.5 && s < 59.5, re: /^45\s*-\s*60\s*s?$/i },
  { test: s => s >= 59.5 && s < 60.5, re: /^60\s*s?$/i },
  { test: s => s >= 60.5,             re: /^>\s*(1m|60\s*s?)$/i },
];
function mapDurationToTimingChoice(seconds, choices) {
  const bucket = TIMING_BUCKETS.find(b => b.test(seconds));
  if (!bucket) return null;
  return choices.find(name => bucket.re.test(name.trim())) || null;
}

let pendingAutofillCandidates = [];

async function openAutofillModal() {
  if (!state.workingDirectory) {
    toastNeedsWorkingDirectory();
    return;
  }
  // Runs over the selection, which a plain click now populates with the one
  // clicked task. The selectedTask fallback remains for any path that opens the
  // rename panel without going through a row click.
  // Sorted by name up front so EVERYTHING downstream shares one order: the
  // approval list, the link pairing, and the writes. The list arrives in
  // selection order (newest first), and showing it in a different order from the
  // pairing makes the pairing impossible to check by eye. Numeric-aware, so
  // CMC_999 precedes CMC_1000. filter() already returned a fresh array, so this
  // does not reorder state.records.
  const records = (state.selectedIds.size
    ? state.records.filter(r => state.selectedIds.has(r.id) && r.fields['Name'])
    : [state.selectedTask].filter(r => r && r.fields['Name'])
  ).sort((a, b) => compareTaskNames(a.fields['Name'], b.fields['Name']));
  if (!records.length) return;

  const timingChoices = (state.tables[state.activeTable]?.fields || [])
    .find(f => f.name === 'Timing')?.options?.choices?.map(c => c.name) || [];

  // Either trigger may have started this: the bulk bar or the rename panel.
  const btns = ['bulk-autofill-btn']
    .map(id => document.getElementById(id)).filter(Boolean);
  btns.forEach(b => { b.disabled = true; b.textContent = 'Searching...'; });
  const btn = { set disabled(v) { btns.forEach(b => { b.disabled = v; }); },
                set textContent(v) { btns.forEach(b => { b.textContent = v; }); } };
  try {
    // Search every ratio in one walk. Demanding exactly _1x1.png / _9x16.mp4
    // meant a variation rendered in a single ratio matched nothing at all.
    const wanted = buildWantedFilenames(
      records.map(r => stripAspectRatio(r.fields['Name'])),
      RATIOS
    );
    log(`openAutofillModal: searching ${state.workingDirectory} for ${wanted.length} file(s)`);
    const found = await window.app.findAssetFiles(state.workingDirectory, wanted);

    btn.textContent = 'Checking video lengths...';
    pendingAutofillCandidates = await Promise.all(records.map(async rec => {
      const base = stripAspectRatio(rec.fields['Name']);
      // Prefer the conventional ratio, fall back to whatever was rendered.
      const previewHit = pickByRatioPreference(base, found, PREVIEW_RATIO_ORDER, PREVIEW_EXTS);
      const videoHit = pickByRatioPreference(base, found, VIDEO_RATIO_ORDER, VIDEO_EXTS);
      const previewFilename = previewHit ? previewHit.filename : null;
      const videoFilename = videoHit ? videoHit.filename : null;
      const previewPath = previewHit ? previewHit.path : null;
      const videoPath = videoHit ? videoHit.path : null;

      const preview = previewPath ? { filename: previewFilename, path: previewPath, include: true } : null;

      let timing = null;
      if (videoPath && timingChoices.length) {
        const seconds = await window.app.getVideoDuration(videoPath).catch(err => {
          log(`openAutofillModal: duration read FAILED for ${videoFilename} — ${err.message}`);
          return null;
        });
        const choice = seconds != null ? mapDurationToTimingChoice(seconds, timingChoices) : null;
        if (seconds != null && !choice) {
          log(`openAutofillModal: no Timing choice matched ${seconds.toFixed(2)}s for ${videoFilename} (choices: ${timingChoices.join(', ')})`);
        }
        if (choice) timing = { filename: videoFilename, path: videoPath, seconds, choice, include: true };
      }

      return { rec, preview, timing };
    }));

    if (!pendingAutofillCandidates.some(c => c.preview || c.timing)) {
      toast('No preview image or video found for the selected tasks.\n\nSearched every aspect ratio (1x1, 9x16, 4x5, 16x9, ...) as .png/.jpg/.jpeg, and .mp4 video, under the working directory.');
      return;
    }

    await renderAutofillApprovalList();
    document.getElementById('autofill-approval-modal').classList.remove('hidden');
  } catch (err) {
    toastError(`Autofill failed: ${err.message}`);
    log(`openAutofillModal: FAILED — ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Autofill';
    updateBulkActionsBar();
  }
}

// Pairing state for the pasted Creative Links, rebuilt on every keystroke in the
// textarea and read back by confirmAutofill.
let pendingLinkPairs = [];
// Links in the order they will be applied. Rebuilt from the textarea on every
// keystroke, then mutated by the ↑/↓ controls — Drive's copy order is not fully
// predictable, so manual correction has to be possible.
let pendingLinkOrder = null;

function creativeLinkFieldName() {
  return resolveFieldName(
    (state.tables[state.activeTable]?.fields || []).map(f => f.name),
    CREATIVE_LINK_FIELD,
  );
}

// Creative Links from Google Drive: each task's own folder, matched by name, so
// no order can go wrong. Pasted links (the box above) take over when present.
let autofillDriveResult = null;
let autofillDriveSeq = 0;

// The lookup in flight (Open GD Folder waits for it instead of starting its own).
let autofillDrivePromise = null;

async function findAutofillLinksOnDrive() {
  const status = document.getElementById('autofill-drive-status');
  const btn = document.getElementById('autofill-find-drive-btn');
  if (!driveConfigured()) { toastError('Set the Google Drive root folder in Settings → Google Drive (rclone) first.'); return; }
  const seq = ++autofillDriveSeq;
  const records = pendingAutofillCandidates.map(c => c.rec);
  const started = Date.now();
  btn.disabled = true;
  status.className = 'drive-status';
  const tick = () => {
    const secs = Math.round((Date.now() - started) / 1000);
    status.textContent = `Looking for the task folders on Google Drive… ${secs} s`
      + (secs >= 10 ? ' (the first time takes a minute or two)' : '');
  };
  tick();
  const timer = setInterval(() => { if (seq === autofillDriveSeq) tick(); }, 1000);
  autofillDrivePromise = findDriveFolders(records);
  try {
    const result = await autofillDrivePromise;
    if (seq !== autofillDriveSeq || document.getElementById('autofill-approval-modal').classList.contains('hidden')) return;
    autofillDriveResult = result;
    const found = records.filter(r => (result.matches[r.fields['Name']] || []).length).length;
    status.className = `drive-status ${found === records.length ? 'ok' : 'warn'}`;
    status.textContent = `Google Drive: ${found} of ${records.length} task folders found`
      + (result.unknownCodes.length ? ` · no app folder holds ${result.unknownCodes.join(', ')}` : '');
    renderLinkPairs();
  } catch (err) {
    if (seq !== autofillDriveSeq) return;
    status.className = 'drive-status bad';
    status.textContent = `Google Drive: ${err.message}`;
    log(`findAutofillLinksOnDrive: FAILED — ${err.message}`);
  } finally {
    clearInterval(timer);
    if (seq === autofillDriveSeq) { btn.disabled = false; autofillDrivePromise = null; }
  }
}

function renderDriveLinkPairs() {
  const listEl = document.getElementById('autofill-links-pairs');
  const warning = document.getElementById('autofill-links-warning');
  const field = creativeLinkFieldName();
  listEl.innerHTML = '';
  pendingLinkPairs = [];
  if (!field) {
    warning.textContent = `This table has no "${CREATIVE_LINK_FIELD}" field — links cannot be saved.`;
    warning.className = 'links-bad';
    return;
  }
  const rows = pendingAutofillCandidates
    .map(c => ({ c, name: c.rec.fields['Name'] || '' }))
    .sort((a, b) => compareTaskNames(a.name, b.name));
  rows.forEach(({ c, name }) => {
    const hits = autofillDriveResult.matches[name] || [];
    const existing = String(c.rec.fields[field] || '').trim();
    const hit = hits[0];
    const link = hit ? driveFolderLink(hit.id) : '';
    const same = existing && link && existing.includes(hit.id);
    const row = document.createElement('label');
    row.className = 'link-pair-row' + (hit ? '' : ' link-pair-missing') + (existing ? ' has-existing' : '');
    if (hit) {
      // A second folder with the same name, or a link already set, is left
      // for the designer to tick.
      const pair = {
        task: { id: c.rec.id, name, existingLink: existing, candidate: c },
        link, hasExisting: !!existing, existingLink: existing,
        include: !existing && hits.length === 1,
      };
      pendingLinkPairs.push(pair);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = pair.include;
      cb.onchange = () => { pair.include = cb.checked; };
      row.append(cb);
    } else {
      const gap = document.createElement('span');
      gap.className = 'link-pair-nobox';
      row.append(gap);
    }
    const nameEl = document.createElement('span');
    nameEl.className = 'link-pair-task';
    nameEl.textContent = name;
    row.append(nameEl);
    if (hit) {
      const open = document.createElement('button');
      open.className = 'link-pair-url-btn';
      open.type = 'button';
      const parts = hit.path.split('/');
      open.textContent = `${parts[0].replace(/_creatives$/, '')} · ${parts[2]}`;
      open.title = `Open the folder on Drive: ${hit.path}`;
      open.onclick = e => { e.preventDefault(); window.app.openExternal(rewriteDriveLink(link, state.driveAccountIndex)); };
      row.append(open);
    }
    const flag = document.createElement('span');
    flag.className = 'link-pair-flag';
    if (!hit) {
      flag.textContent = 'not found on Drive';
      flag.title = `Looked in ${autofillDriveResult.months.map(m => m.path).join(', ') || 'no month folder'}`;
    }
    else if (same) flag.textContent = 'link already set';
    else if (hits.length > 1) { flag.textContent = `${hits.length} folders with this name, newest picked`; flag.title = hits.map(h => h.path).join('\n'); }
    else if (existing) { flag.textContent = 'already has another link'; flag.title = existing; }
    if (flag.textContent) row.append(flag);
    listEl.append(row);
  });
  const ticked = pendingLinkPairs.filter(p => p.include).length;
  warning.textContent = `${ticked} Creative Link${ticked === 1 ? '' : 's'} from Google Drive will be written. Paste links above to use those instead.`;
  warning.className = 'links-ok';
}

// Renders the task ↔ link pairing for review. Every pair is shown with a
// checkbox, and a task that already holds a link keeps its position in the
// order — dropping it would shift every later link onto the wrong task — but
// arrives unticked with its current link visible.
function renderLinkPairs() {
  const textarea = document.getElementById('autofill-links');
  const warning = document.getElementById('autofill-links-warning');
  const listEl = document.getElementById('autofill-links-pairs');
  const field = creativeLinkFieldName();

  listEl.innerHTML = '';
  warning.textContent = '';
  pendingLinkPairs = [];

  const raw = textarea.value.trim();
  if (!raw) {
    // Nothing pasted: the folders found on Drive are the pairing.
    if (autofillDriveResult) renderDriveLinkPairs();
    return;
  }

  if (!field) {
    warning.textContent = `This table has no "${CREATIVE_LINK_FIELD}" field — links cannot be saved.`;
    warning.className = 'links-bad';
    return;
  }

  const parsed = parseLinkList(textarea.value);
  // Rebuild the order from the paste unless the user has nudged rows for THIS
  // exact set of links; then their arrangement wins.
  const driveOrder = document.getElementById('autofill-drive-order-input').checked;
  const fromPaste = driveOrder ? reorderFromDriveSelection(parsed.links) : parsed.links;
  if (!pendingLinkOrder || pendingLinkOrder.length !== fromPaste.length
      || !fromPaste.every(l => pendingLinkOrder.includes(l))) {
    pendingLinkOrder = fromPaste;
  }
  const tasks = pendingAutofillCandidates.map(c => ({
    id: c.rec.id,
    name: c.rec.fields['Name'] || '',
    existingLink: c.rec.fields[field] || '',
    candidate: c,
  }));
  const paired = pairLinksToTasks(tasks, pendingLinkOrder);

  const note = describeMismatch(paired, parsed);
  warning.textContent = note || `${paired.pairs.length} link(s) paired — counts match.`;
  warning.className = note ? 'links-warn' : 'links-ok';

  paired.pairs.forEach((pair, i) => {
    const state_ = { ...pair, include: !pair.hasExisting };
    pendingLinkPairs.push(state_);

    const row = document.createElement('label');
    row.className = 'link-pair-row' + (pair.hasExisting ? ' has-existing' : '');

    // The position is the whole point of the pairing, so show it.
    const idx = document.createElement('span');
    idx.className = 'link-pair-index';
    idx.textContent = `${i + 1}.`;
    row.appendChild(idx);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state_.include;
    cb.onchange = () => { state_.include = cb.checked; };
    row.appendChild(cb);

    const name = document.createElement('span');
    name.className = 'link-pair-task';
    name.textContent = pair.task.name;
    row.appendChild(name);

    // A Drive URL is an opaque id, so the only way to check a pairing is to open
    // the folder. Without this the review list cannot actually be reviewed.
    const link = document.createElement('button');
    link.className = 'link-pair-url-btn';
    link.type = 'button';
    link.textContent = pair.link;
    link.title = `Open this folder to check it is ${pair.task.name}`;
    link.onclick = (e) => {
      e.preventDefault();
      window.app.openExternal(rewriteDriveLink(pair.link, state.driveAccountIndex));
    };
    row.appendChild(link);

    // Drive's copy order is an observation, not a guarantee — these let a wrong
    // pairing be corrected without re-pasting the whole list.
    const move = (from, to) => {
      const arr = [...pendingLinkOrder];
      const [item] = arr.splice(from, 1);
      arr.splice(to, 0, item);
      pendingLinkOrder = arr;
      renderLinkPairs();
    };
    const up = document.createElement('button');
    up.className = 'link-pair-move';
    up.type = 'button';
    up.innerHTML = iconSvg('up');
    up.title = 'Move this link one task earlier';
    up.disabled = i === 0;
    up.onclick = (e) => { e.preventDefault(); move(i, i - 1); };
    row.appendChild(up);

    const down = document.createElement('button');
    down.className = 'link-pair-move';
    down.type = 'button';
    down.innerHTML = iconSvg('down');
    down.title = 'Move this link one task later';
    down.disabled = i === paired.pairs.length - 1;
    down.onclick = (e) => { e.preventDefault(); move(i, i + 1); };
    row.appendChild(down);

    if (pair.hasExisting) {
      const flag = document.createElement('span');
      flag.className = 'link-pair-flag';
      flag.textContent = 'already has a link';
      flag.title = pair.existingLink;
      row.appendChild(flag);
    }
    listEl.appendChild(row);
  });

  paired.tasksWithoutLink.forEach(task => {
    const row = document.createElement('div');
    row.className = 'link-pair-row link-pair-missing';
    row.textContent = `${task.name} — no link`;
    listEl.appendChild(row);
  });

  paired.unusedLinks.forEach(link => {
    const row = document.createElement('div');
    row.className = 'link-pair-row link-pair-missing';
    row.textContent = `unused link — ${link}`;
    row.title = link;
    listEl.appendChild(row);
  });

  parsed.invalid.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'link-pair-row link-pair-missing';
    row.textContent = `not a URL — ${entry}`;
    listEl.appendChild(row);
  });
}

async function renderAutofillApprovalList() {
  const list = document.getElementById('autofill-approval-list');
  list.innerHTML = '';

  // The shared Figma/Canvas link only makes sense for "Stat" creatives, which
  // are delivered as a board rather than a Drive folder. It is offered whenever
  // the batch contains any, and written only to those — writing a Figma board
  // onto a Video task would be wrong data, and the note below makes the scope
  // explicit before anything is applied.
  // A fresh batch starts with an empty paste box: carrying links over from a
  // previous run would pair them against different tasks.
  document.getElementById('autofill-links').value = '';
  pendingLinkOrder = null;
  autofillDriveResult = null;
  renderLinkPairs();
  document.getElementById('autofill-drive-status').textContent = '';
  autofillDriveSeq++; // a lookup still running from an earlier opening is ignored
  autofillDrivePromise = null;
  document.getElementById('autofill-find-drive-btn').disabled = false;
  document.getElementById('autofill-find-drive-btn').classList.toggle('hidden', !driveConfigured());
  if (driveConfigured() && pendingAutofillCandidates.some(c => !isStatCandidate(c))) findAutofillLinksOnDrive();

  const statCount = pendingAutofillCandidates.filter(isStatCandidate).length;
  const figmaRow = document.getElementById('autofill-figma-row');
  const figmaInput = document.getElementById('autofill-figma-link');
  figmaRow.classList.toggle('hidden', statCount === 0);
  if (statCount === 0) {
    figmaInput.value = '';
  } else {
    document.getElementById('autofill-figma-note').textContent =
      `optional — applied to ${statCount} Stat task${statCount === 1 ? '' : 's'}`;
  }

  // Time spent → "Hours". In every Creatives table it is a single select of
  // "HH:MM" choices (00:15 … 06:00), so the table's own choices are offered,
  // once for all tasks and per task. Nothing is set by default.
  const hoursChoices = autofillHoursChoices();
  const hoursRow = document.getElementById('autofill-hours-row');
  const hoursAll = document.getElementById('autofill-hours-all');
  hoursRow.classList.toggle('hidden', !hoursChoices);
  const fillHoursSelect = (sel, emptyLabel) => {
    sel.innerHTML = '';
    [['', emptyLabel], ...(hoursChoices || []).map(h => [h, h])].forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    });
  };
  fillHoursSelect(hoursAll, '— don\'t set —');
  pendingAutofillCandidates.forEach(c => { c.hours = ''; });

  const thumbs = await Promise.all(pendingAutofillCandidates.map(c =>
    c.preview ? window.app.readImageDataUrl(c.preview.path).catch(() => null) : Promise.resolve(null)
  ));

  pendingAutofillCandidates.forEach((c, i) => {
    const hasMatch = c.preview || c.timing;
    const row = document.createElement('div');
    row.className = 'autofill-approval-row' + (hasMatch ? '' : ' no-match');

    const img = document.createElement('img');
    img.className = 'autofill-approval-thumb';
    if (thumbs[i]) img.src = thumbs[i];
    row.appendChild(img);

    const info = document.createElement('div');
    info.className = 'autofill-approval-info';
    const task = document.createElement('div');
    task.className = 'autofill-approval-task';
    task.textContent = c.rec.fields['Name'];
    info.appendChild(task);

    const buildLine = (checked, tag, text, onToggle) => {
      const line = document.createElement('label');
      line.className = 'autofill-approval-line';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.addEventListener('change', () => onToggle(cb.checked));
      line.appendChild(cb);
      const tagEl = document.createElement('span');
      tagEl.className = 'autofill-approval-line-tag';
      tagEl.textContent = tag;
      line.appendChild(tagEl);
      const textEl = document.createElement('span');
      textEl.className = 'autofill-approval-line-text';
      textEl.textContent = text;
      line.appendChild(textEl);
      return line;
    };

    if (c.preview) {
      info.appendChild(buildLine(c.preview.include, 'Preview', c.preview.filename, v => { c.preview.include = v; }));
    }

    if (c.timing) {
      info.appendChild(buildLine(c.timing.include, 'Timing', `${c.timing.choice} (${c.timing.seconds.toFixed(1)}s)`, v => { c.timing.include = v; }));
    }

    if (!hasMatch) {
      const line = document.createElement('div');
      line.className = 'autofill-approval-line autofill-approval-line-empty';
      line.textContent = 'No match found';
      info.appendChild(line);
    }

    // Timing comes from the 9x16 master; a newer repeat render means it may be
    // the old cut. Warn only here: replacing it mid-review would change the list.
    const ready = readinessFor(c.rec);
    if (ready && ready.promote) {
      const line = repeatWarningEl({ warning: ready.warning, promote: null });
      line.classList.remove('mild');
      line.title = 'Close Autofill and use the newer render as the master first (side panel or Resize).';
      info.appendChild(line);
    }

    if (hoursChoices) {
      const line = document.createElement('div');
      line.className = 'autofill-approval-line autofill-hours-line';
      const tagEl = document.createElement('span');
      tagEl.className = 'autofill-approval-line-tag';
      tagEl.textContent = 'Hours';
      line.appendChild(tagEl);
      const sel = document.createElement('select');
      sel.className = 'autofill-hours-select';
      sel.dataset.idx = String(i);
      const current = c.rec.fields['Hours'];
      fillHoursSelect(sel, current ? `keep ${current}` : '— not set —');
      sel.addEventListener('change', () => { c.hours = sel.value; });
      line.appendChild(sel);
      info.appendChild(line);
    }

    row.appendChild(info);
    list.appendChild(row);
  });
}

// The active table's "Hours" choices, or null when the field is missing or not
// a single select (then the time-spent controls stay hidden).
function autofillHoursChoices() {
  const field = (state.tables[state.activeTable]?.fields || []).find(f => f.name === 'Hours');
  if (!field || field.type !== 'singleSelect') {
    log(`autofillHoursChoices: ${state.activeTable} has no single-select Hours field (${field ? field.type : 'missing'}), time spent hidden`);
    return null;
  }
  const choices = (field.options?.choices || []).map(c => c.name);
  return choices.length ? choices : null;
}

// "Set for all" overwrites every task's choice; a task can then be changed alone.
function applyAutofillHoursToAll(value) {
  pendingAutofillCandidates.forEach(c => { c.hours = value; });
  document.querySelectorAll('#autofill-approval-list .autofill-hours-select').forEach(sel => { sel.value = value; });
}

function closeAutofillModal() {
  document.getElementById('autofill-approval-modal').classList.add('hidden');
  pendingAutofillCandidates = [];
}

// True when a task's deliverable is a Figma/Canvas board rather than a Drive
// folder. Format is authoritative, with the name as a fallback — same rule the
// Description link buttons use.
function isStatCandidate(c) {
  return linkFieldForRecord({ format: c.rec.fields['Format'], name: c.rec.fields['Name'] }) === FIGMA_LINK_FIELD;
}

async function confirmAutofill() {
  const toUpload = pendingAutofillCandidates.filter(c => c.preview?.include && c.preview.path);
  const toSetTiming = pendingAutofillCandidates.filter(c => c.timing?.include && c.timing.choice);
  const toSetHours = pendingAutofillCandidates.filter(c => c.hours);

  const figmaLink = (document.getElementById('autofill-figma-link').value || '').trim();
  const statCandidates = figmaLink ? pendingAutofillCandidates.filter(isStatCandidate) : [];

  // Resolve the field against the table's real schema rather than assuming the
  // name, so a differently-spelled column fails loudly instead of silently
  // dropping the link.
  const tableInfo = state.tables[state.activeTable];
  const figmaField = figmaLink
    ? resolveFieldName((tableInfo?.fields || []).map(f => f.name), FIGMA_LINK_FIELD)
    : null;
  if (figmaLink && !figmaField) {
    toastError(`This table has no "${FIGMA_LINK_FIELD}" field, so the link cannot be saved.\n\nNothing was written.`);
    return;
  }

  const linkPairs = pendingLinkPairs.filter(p => p.include && p.link);
  const creativeField = linkPairs.length ? creativeLinkFieldName() : null;
  if (linkPairs.length && !creativeField) {
    toastError(`This table has no "${CREATIVE_LINK_FIELD}" field, so the pasted links cannot be saved.\n\nNothing was written.`);
    return;
  }

  if (!toUpload.length && !toSetTiming.length && !statCandidates.length && !linkPairs.length && !toSetHours.length) {
    closeAutofillModal();
    return;
  }

  const btn = document.getElementById('autofill-approval-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Applying...';
  let uploaded = 0, uploadFailed = 0, timed = 0, linked = 0, dated = 0, creativeLinked = 0, hoursSet = 0;
  try {
    // Attachments go one at a time — the upload endpoint takes a single file.
    const uploadedOk = [];
    for (const c of toUpload) {
      try {
        const result = await window.airtable.uploadAttachment(state.baseId, c.rec.id, 'Preview', c.preview.path);
        c.rec.fields['Preview'] = uploadedAttachments(result, 'Preview');
        uploaded++;
        uploadedOk.push(c);
        log(`confirmAutofill: uploaded ${c.preview.path} to ${c.rec.fields['Name']}`);
      } catch (err) {
        uploadFailed++;
        log(`confirmAutofill: preview upload FAILED for ${c.rec.fields['Name']} — ${err.message}`);
      }
    }

    // Everything else lands in ONE batched update per record: Timing, the shared
    // Figma/Canvas link, and "Date Done". Date Done is stamped on every record
    // this run actually writes to — a failed preview upload does not count, so a
    // task is never dated as finished when nothing was delivered.
    const today = toISO(new Date());
    const pending = new Map();
    const addFields = (c, fields) => {
      const entry = pending.get(c.rec.id) || { c, fields: {} };
      Object.assign(entry.fields, fields);
      pending.set(c.rec.id, entry);
    };
    toSetTiming.forEach(c => addFields(c, { Timing: c.timing.choice }));
    toSetHours.forEach(c => addFields(c, { Hours: c.hours }));
    statCandidates.forEach(c => addFields(c, { [figmaField]: figmaLink }));
    linkPairs.forEach(p => addFields(p.task.candidate, { [creativeField]: p.link }));
    [...uploadedOk, ...toSetTiming, ...toSetHours, ...statCandidates, ...linkPairs.map(p => p.task.candidate)]
      .forEach(c => addFields(c, { 'Date Done': today }));

    let writtenIds = [];
    if (pending.size && tableInfo) {
      const entries = [...pending.values()];
      try {
        const results = await window.airtable.updateRecords(
          state.baseId, tableInfo.id,
          entries.map(e => ({ id: e.c.rec.id, fields: e.fields })),
        );
        const byId = new Map(results.map(r => [r.id, r]));
        entries.forEach(e => {
          const updated = byId.get(e.c.rec.id);
          if (updated) e.c.rec.fields = updated.fields;
        });
        timed = toSetTiming.length;
        linked = statCandidates.length;
        creativeLinked = linkPairs.length;
        hoursSet = toSetHours.length;
        dated = entries.length;
        writtenIds = entries.map(e => e.c.rec.id);
        log(`confirmAutofill: updated ${results.length} record(s) — Timing ${timed}, Hours ${hoursSet}, ${FIGMA_LINK_FIELD} ${linked}, ${CREATIVE_LINK_FIELD} ${creativeLinked}, Date Done ${dated}`);
      } catch (err) {
        log(`confirmAutofill: batched update FAILED — ${err.message}`);
        toastError(`Previews uploaded, but the Timing / Hours / link / Date Done update failed:\n\n${err.message}`);
      }
    }

    render();
    maybeRefreshDashboard();
    const lines = [
      `Previews uploaded: ${uploaded}`,
      uploadFailed ? `Preview upload failed: ${uploadFailed}` : null,
      `Timing set: ${timed}`,
      hoursSet ? `Hours set: ${hoursSet}` : null,
      linked ? `${FIGMA_LINK_FIELD} set: ${linked}` : null,
      creativeLinked ? `${CREATIVE_LINK_FIELD} set: ${creativeLinked}` : null,
      `Date Done set: ${dated}`,
    ].filter(Boolean);
    showAutofillDone(lines, writtenIds);
    renderTaskPanel();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply Selected';
    closeAutofillModal();
  }
}

// The usual next step after Autofill is handing the work in, so the result
// dialog offers it directly for the records Autofill actually wrote.
let autofillDoneIds = [];

function showAutofillDone(lines, writtenIds) {
  autofillDoneIds = writtenIds.filter(id => state.records.some(r => r.id === id && r.fields['Status'] !== 'To accept'));
  document.getElementById('autofill-done-summary').textContent = lines.join('\n');
  const btn = document.getElementById('autofill-done-accept-btn');
  btn.textContent = `Mark ${autofillDoneIds.length} as To Accept`;
  btn.classList.toggle('hidden', !autofillDoneIds.length);
  document.getElementById('autofill-done-modal').classList.remove('hidden');
}

async function markAutofilledAsToAccept() {
  document.getElementById('autofill-done-modal').classList.add('hidden');
  if (!autofillDoneIds.length) return;
  state.selectedIds = new Set(autofillDoneIds);
  autofillDoneIds = [];
  await markSelectedAsToAccept();
}

// ── Video resizer ─────────────────────────────────────────────────────────
// Makes the 1x1 / 4x5 / 16x9 (and custom) versions of each selected task's
// <base>_9x16.mp4, next to it, with the bundled ffmpeg. Only files are written:
// Autofill on the same selection then fills Preview and Timing as usual. The
// look, naming and encoding live in resize-plan.js; ffmpeg runs in main.js.
//
// The same dialog, in "compress" mode, backs the Compress button: it shrinks
// every video of the selected tasks that is over the 32 MB delivery limit, in
// place. Resize itself encodes under the limit and compresses the master after.

const resizeState = {
  mode: 'resize',       // 'resize' | 'compress'
  tasks: [],            // { id, name, base, source, sourceNote, info, existing, over, videoCount,
                        //   state, label, fraction, seconds, error, compressed }
  selected: new Set(),  // ticked size keys
  custom: [],           // remembered custom keys, most recent first
  previews: true,
  sides: 'blur',        // 16x9 background: 'blur' | 'duplicate'
  fitLimit: true,       // keep every video under 32 MB
  running: false,
  cancelling: false,
  lastRun: null,        // counts after a run, until the sizes change
  inspectSeq: 0,
};

async function openResizeModal(mode = 'resize', { chain = false } = {}) {
  if (resizeState.running) {
    document.getElementById('resize-modal').classList.remove('hidden');
    return;
  }
  if (!state.workingDirectory) {
    toastNeedsWorkingDirectory();
    return;
  }
  // Name order, like Autofill, so the two dialogs list a selection the same way.
  const records = state.records
    .filter(r => state.selectedIds.has(r.id) && r.fields['Name'])
    .sort((a, b) => compareTaskNames(a.fields['Name'], b.fields['Name']));
  if (!records.length) return;

  const btn = document.getElementById(mode === 'compress' ? 'bulk-compress-btn' : 'bulk-resize-btn');
  const btnLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Searching...';
  try {
    const sourceName = rec => `${stripAspectRatio(rec.fields['Name'])}_9x16.mp4`;
    log(`openResizeModal: searching ${state.workingDirectory} for ${records.length} 9x16 source(s)`);
    const [found, settings] = await Promise.all([
      window.app.findAllFiles(state.workingDirectory, records.map(sourceName)),
      window.app.getSettings(),
      refreshTaskFileIndex(true), // fresh, for the _9x16_1 repeat-render warning
    ]);
    resizeState.custom = (settings.resizeCustomSizes || []).filter(k => targetFromKey(k));
    // Last run's choices, so a designer who always adds 1.91x1 (or never wants
    // previews) does not re-tick it every time. Unknown keys are dropped.
    const last = settings.resizeOptions || {};
    const lastKeys = (last.keys || []).filter(k => targetFromKey(k));
    resizeState.selected = new Set(lastKeys.length ? lastKeys : DEFAULT_RESIZE_KEYS);
    resizeState.previews = last.previews !== false;
    resizeState.sides = last.sides === 'duplicate' ? 'duplicate' : 'blur';
    resizeState.fitLimit = last.fitLimit !== false;
    resizeState.lastRun = null;
    resizeState.mode = mode;
    resizeState.finishChain = chain;
    resizeState.tasks = records.map(rec => {
      const name = rec.fields['Name'];
      const pick = pickResizeSource(name, found[sourceName(rec)]);
      let sourceNote = null;
      if (pick.error === 'missing') sourceNote = 'no _9x16.mp4';
      if (pick.error === 'ambiguous') {
        sourceNote = `found in ${pick.paths.length} places`;
        log(`openResizeModal: ${name} skipped, ${sourceName(rec)} found in ${pick.paths.length} places: ${pick.paths.join(' | ')}`);
      }
      return {
        id: rec.id, rec, name, base: stripAspectRatio(name), source: pick.path || null, sourceNote,
        info: null, existing: [], over: null, videoCount: 0,
        state: null, label: null, fraction: 0, seconds: null, error: null, compressed: null,
      };
    });
    renderResizeModal();
    document.getElementById('resize-modal').classList.remove('hidden');
    await inspectResizeTasks();
  } catch (err) {
    toastError(`${mode === 'compress' ? 'Compress' : 'Resize'} failed: ${err.message}`);
    log(`openResizeModal(${mode}): FAILED — ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = btnLabel;
    updateBulkActionsBar();
  }
}

function inspectResizeTasks() {
  return resizeState.mode === 'compress' ? inspectCompressTasks() : inspectResizeSources();
}

// Lists each task's videos (the 9x16 master and its resizes) and which are over
// the 32 MB limit.
async function inspectCompressTasks() {
  const withSource = resizeState.tasks.filter(t => t.source);
  if (!withSource.length) { renderResizeModal(); return; }
  try {
    const results = await window.app.compressInspect(
      withSource.map(t => ({ id: t.id, base: t.base, source: t.source })));
    results.forEach(r => {
      const task = resizeState.tasks.find(t => t.id === r.id);
      if (!task) return;
      task.videoCount = r.count;
      task.over = r.over;
    });
  } catch (err) {
    log(`inspectCompressTasks: FAILED — ${err.message}`);
  }
  renderResizeModal();
}

// Probes the sources (cached in main) and checks which resizes already exist
// for the ticked sizes. Re-run whenever the sizes change; a newer call wins.
async function inspectResizeSources() {
  const withSource = resizeState.tasks.filter(t => t.source);
  if (!withSource.length) { renderResizeModal(); return; }
  const seq = ++resizeState.inspectSeq;
  try {
    const results = await window.app.resizeInspect(
      withSource.map(t => ({ id: t.id, base: t.base, source: t.source })),
      [...resizeState.selected],
    );
    if (seq !== resizeState.inspectSeq) return;
    results.forEach(r => {
      const task = resizeState.tasks.find(t => t.id === r.id);
      if (!task) return;
      task.info = r.error ? null : { width: r.width, height: r.height, duration: r.duration };
      task.sourceNote = r.error || null;
      task.existing = r.existing || [];
    });
  } catch (err) {
    log(`inspectResizeSources: FAILED — ${err.message}`);
  }
  renderResizeModal();
}

function resizeRunnable() {
  if (resizeState.mode === 'compress') {
    return resizeState.tasks.filter(t => t.source && !t.sourceNote && t.over && t.over.length);
  }
  return resizeState.tasks.filter(t => t.source && t.info && !t.sourceNote);
}

// "2 compressed", with the before/after sizes for the tooltip.
function describeCompressed(list) {
  if (!list || !list.length) return { text: '', title: '' };
  return {
    text: ` · ${list.length} compressed`,
    title: list.map(c => `${c.label}: ${formatMB(c.before)} → ${formatMB(c.after)}`).join('\n'),
  };
}

function resizeSelectedKeys() {
  return resolveTargets([...resizeState.selected]).map(t => t.key);
}

function renderResizeModal() {
  const s = resizeState;
  const count = s.tasks.length;
  const compress = s.mode === 'compress';
  document.getElementById('resize-title').textContent =
    `${compress ? 'Compress' : 'Resize'} ${count} task${count === 1 ? '' : 's'}`;
  document.getElementById('resize-sizes-section').classList.toggle('hidden', compress);
  document.getElementById('resize-col-source').textContent = compress ? 'Videos' : '9x16 source';

  // Chips: standard sizes, remembered custom sizes, then PNG previews.
  const chips = document.getElementById('resize-chips');
  chips.innerHTML = '';
  const addChip = (key, label, detail, on, removable = false) => {
    const chip = document.createElement('button');
    chip.className = 'resize-chip' + (on ? ' on' : '') + (removable ? ' removable' : '');
    chip.dataset.key = key;
    chip.disabled = s.running;
    chip.textContent = (on ? '✓ ' : '') + label;
    if (detail) {
      const small = document.createElement('small');
      small.textContent = detail;
      chip.appendChild(small);
    }
    if (removable) {
      const x = document.createElement('span');
      x.className = 'resize-chip-remove';
      x.innerHTML = iconSvg('close');
      x.title = 'Forget this size';
      chip.appendChild(x);
    }
    chips.appendChild(chip);
  };
  STANDARD_RESIZE_ORDER.forEach(key => {
    const { width, height } = STANDARD_RESIZE_SIZES[key];
    addChip(key, key, `${width}×${height}`, s.selected.has(key));
  });
  s.custom.forEach(key => addChip(key, key.replace('x', '×'), 'custom', s.selected.has(key), true));
  addChip('png', 'PNG previews', null, s.previews);
  addChip('dup', '16x9: duplicate sides', 'instead of blur', s.sides === 'duplicate');
  addChip('fit', 'Fit under 32 MB', null, s.fitLimit);
  ['resize-custom-w', 'resize-custom-h', 'resize-custom-add']
    .forEach(id => { document.getElementById(id).disabled = s.running; });

  // Task list.
  const list = document.getElementById('resize-task-list');
  list.innerHTML = '';
  s.tasks.forEach(task => {
    const row = document.createElement('div');
    row.className = 'resize-row';

    const name = document.createElement('span');
    name.className = 'resize-row-name';
    if (task.source) {
      const folder = document.createElement('button');
      folder.className = 'resize-row-folder';
      folder.dataset.path = task.source;
      folder.innerHTML = iconSvg('folder');
      folder.title = 'Show the 9x16 source in its folder';
      name.appendChild(folder);
    }
    name.appendChild(document.createTextNode(task.name));
    name.title = task.source || task.name;

    const src = document.createElement('span');
    src.className = 'resize-row-source';
    if (task.sourceNote) {
      src.classList.add('bad');
      src.textContent = task.sourceNote;
    } else if (compress) {
      if (!task.over) {
        src.textContent = 'checking…';
      } else if (!task.over.length) {
        src.classList.add('ok');
        src.textContent = `all ${task.videoCount} under 32 MB`;
      } else {
        src.classList.add('warn');
        const max = Math.max(...task.over.map(v => v.bytes));
        src.textContent = `${task.over.length} of ${task.videoCount} over · max ${formatMB(max)}`;
        src.title = task.over.map(v => `${v.label}: ${formatMB(v.bytes)}`).join('\n');
      }
    } else if (!task.info) {
      src.textContent = 'checking…';
    } else if (task.existing.length) {
      src.classList.add('warn');
      src.textContent = `found · ${task.existing.join(', ')} exist${task.existing.length === 1 ? 's' : ''}`;
    } else {
      src.classList.add('ok');
      src.textContent = 'found';
    }

    const status = document.createElement('span');
    status.className = 'resize-row-status';
    if (['rendering', 'compressing', 'done', 'waiting'].includes(task.state)) {
      const bar = document.createElement('span');
      bar.className = 'resize-bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.round((task.state === 'done' ? 1 : task.fraction) * 100)}%`;
      bar.appendChild(fill);
      status.appendChild(bar);
    }
    const text = document.createElement('span');
    if (task.state === 'waiting') text.textContent = 'waiting';
    else if (task.state === 'rendering') text.textContent = `${Math.round(task.fraction * 100)}%`;
    else if (task.state === 'compressing') text.textContent = `compressing ${task.label} ${Math.round(task.fraction * 100)}%`;
    else if (task.state === 'done') {
      const c = describeCompressed(task.compressed);
      const kept = task.kept && task.kept.length ? ` · kept ${task.kept.join(', ')}` : '';
      text.textContent = `done ${formatSeconds(task.seconds || 0)}${kept}${c.text}`;
      text.title = c.title;
      text.className = 'ok';
    }
    else if (task.state === 'failed') { text.textContent = `failed: ${task.error}`; text.title = task.error; text.className = 'bad'; }
    else if (task.state === 'cancelled') text.textContent = 'cancelled';
    else if (task.state === 'skipped') text.textContent = 'skipped';
    status.appendChild(text);

    row.append(name, src, status);
    list.appendChild(row);
    // A newer After Effects repeat render (_9x16_1) next to the master: the
    // source may be the stale render. Offer to use the new one before running.
    const ready = !s.running && task.rec ? readinessFor(task.rec) : null;
    if (ready && ready.warning) {
      list.appendChild(repeatWarningEl(ready, async () => {
        if (!task.source && ready.promote) {
          const found = await window.app.findAllFiles(state.workingDirectory, [`${task.base}_9x16.mp4`]);
          const pick = pickResizeSource(task.name, found[`${task.base}_9x16.mp4`]);
          task.source = pick.path || null;
          task.sourceNote = pick.path ? null : task.sourceNote;
        }
        await inspectResizeTasks();
      }));
    }
  });

  // Footer.
  const keys = resizeSelectedKeys();
  const runnable = resizeRunnable();
  const summary = document.getElementById('resize-summary');
  if (s.lastRun && !s.running) {
    const r = s.lastRun;
    summary.textContent = [`Done ${r.done}`, `skipped ${r.skipped}`, `failed ${r.failed}`]
      .concat(r.cancelled ? [`cancelled ${r.cancelled}`] : []).join(' · ');
  } else {
    summary.textContent = compress
      ? compressSummary(runnable.length, runnable.reduce((n, t) => n + t.over.length, 0))
      : resizeSummary(runnable.length, keys.length, s.previews);
  }

  // After a run that made files, the next step is Autofill on the same tasks.
  document.getElementById('resize-autofill-btn')
    .classList.toggle('hidden', s.running || !s.lastRun || !s.lastRun.done);

  const renderBtn = document.getElementById('resize-render-btn');
  if (s.running) {
    const active = s.tasks.filter(t => t.state && t.state !== 'skipped');
    const overall = active.length
      ? active.reduce((sum, t) => sum + (t.state === 'done' ? 1 : t.fraction || 0), 0) / active.length : 0;
    renderBtn.textContent = s.cancelling ? 'Cancelling…' : `Cancel · ${Math.round(overall * 100)}%`;
    renderBtn.style.setProperty('--resize-progress', `${Math.round(overall * 100)}%`);
    renderBtn.classList.add('running');
    renderBtn.disabled = s.cancelling;
  } else {
    renderBtn.textContent = compress ? 'Compress' : 'Render';
    renderBtn.classList.remove('running');
    renderBtn.disabled = !runnable.length || (!compress && !keys.length);
  }
}

function toggleResizeChip(key) {
  if (resizeState.running) return;
  if (key === 'png') resizeState.previews = !resizeState.previews;
  else if (key === 'dup') resizeState.sides = resizeState.sides === 'duplicate' ? 'blur' : 'duplicate';
  else if (key === 'fit') resizeState.fitLimit = !resizeState.fitLimit;
  else if (resizeState.selected.has(key)) resizeState.selected.delete(key);
  else resizeState.selected.add(key);
  resizeState.lastRun = null;
  renderResizeModal();
  if (!['png', 'dup', 'fit'].includes(key)) inspectResizeSources();
}

async function removeResizeCustomSize(key) {
  if (resizeState.running) return;
  resizeState.custom = resizeState.custom.filter(k => k !== key);
  resizeState.selected.delete(key);
  resizeState.lastRun = null;
  renderResizeModal();
  inspectResizeSources();
  await window.app.saveSettings({ resizeCustomSizes: resizeState.custom });
}

async function addResizeCustomSize() {
  const wEl = document.getElementById('resize-custom-w');
  const hEl = document.getElementById('resize-custom-h');
  const note = document.getElementById('resize-custom-note');
  const target = parseCustomSize(wEl.value, hEl.value);
  if (!target) {
    note.textContent = 'Enter a width and height between 64 and 4096 px';
    return;
  }
  // Rounded to even numbers for H.264; say so when that changed the input.
  note.textContent = (Number(wEl.value) !== target.width || Number(hEl.value) !== target.height)
    ? `Rounded to ${target.width}×${target.height} (H.264 needs even sizes)` : '';
  resizeState.custom = rememberCustomSize(resizeState.custom, target.key);
  resizeState.selected.add(target.key);
  resizeState.lastRun = null;
  wEl.value = '';
  hEl.value = '';
  renderResizeModal();
  inspectResizeSources();
  await window.app.saveSettings({ resizeCustomSizes: resizeState.custom });
}

async function startResize() {
  const s = resizeState;
  if (s.running) {
    s.cancelling = true;
    renderResizeModal();
    await window.app.resizeCancel();
    return;
  }
  const compress = s.mode === 'compress';
  const keys = resizeSelectedKeys();
  const runnable = resizeRunnable();
  if (!runnable.length || (!compress && !keys.length)) return;
  if (!compress) {
    window.app.saveSettings({ resizeOptions: { keys, previews: s.previews, sides: s.sides, fitLimit: s.fitLimit } });
  }

  s.tasks.forEach(t => {
    t.state = runnable.includes(t) ? 'waiting' : 'skipped';
    t.fraction = 0;
    t.seconds = null;
    t.error = null;
    t.compressed = null;
    t.kept = null;
  });
  s.running = true;
  s.cancelling = false;
  s.lastRun = null;
  renderResizeModal();
  log(compress
    ? `startResize: compress ${runnable.length} task(s)`
    : `startResize: ${runnable.length} task(s), sizes ${keys.join(', ')}${s.previews ? ' + previews' : ''}`);
  try {
    const tasks = runnable.map(t => ({ id: t.id, base: t.base, source: t.source }));
    const res = compress
      ? await window.app.compressRender({ tasks })
      : await window.app.resizeRender({ tasks, keys, previews: s.previews, sides: s.sides, fitLimit: s.fitLimit });
    if (res.declined) {
      s.tasks.forEach(t => { t.state = null; });
    } else {
      const count = state => s.tasks.filter(t => t.state === state).length;
      s.lastRun = {
        done: count('done'), skipped: count('skipped'), failed: count('failed'), cancelled: count('cancelled'),
      };
      log(`startResize: finished — ${JSON.stringify(s.lastRun)}`);
    }
  } catch (err) {
    toastError(`${compress ? 'Compress' : 'Resize'} failed: ${err.message}`);
    log(`startResize: FAILED — ${err.message}`);
    s.tasks.forEach(t => { if (['waiting', 'rendering', 'compressing'].includes(t.state)) t.state = null; });
  } finally {
    s.running = false;
    s.cancelling = false;
    renderResizeModal();
    // The files changed: refresh the "resizes exist" / "over 32 MB" notes.
    inspectResizeTasks();
    refreshTaskFileIndex(true);
    // Started from Finish: a clean run moves straight on to Autofill.
    if (s.finishChain) {
      s.finishChain = false;
      if (s.lastRun && s.lastRun.done && !s.lastRun.failed && !s.lastRun.cancelled) resizeToAutofill();
    }
  }
}

function applyResizeProgress(p) {
  const task = resizeState.tasks.find(t => t.id === p.id);
  if (!task) return;
  task.state = p.state;
  if (p.fraction != null) task.fraction = p.fraction;
  if (p.seconds != null) task.seconds = p.seconds;
  if (p.error) task.error = p.error;
  if (p.label) task.label = p.label;
  if (p.compressed) task.compressed = p.compressed;
  if (p.kept) task.kept = p.kept;
  renderResizeModal();
}

// Finish: starts at the first step the selection still needs. Resize and
// Compress hand over to Autofill by themselves when their run succeeds, and
// Autofill's result window offers To Accept, so one click walks the chain.
async function finishSelected() {
  if (!state.selectedIds.size) return;
  if (!taskFileIndex) await refreshTaskFileIndex(true);
  const selected = state.records.filter(r => state.selectedIds.has(r.id));
  const fieldNames = readinessFieldNames();
  const list = selected.map(r => readinessFor(r, fieldNames)).filter(Boolean);
  const next = list.length ? stepSummary(list).next : 'autofill';
  log(`finishSelected: ${selected.length} task(s), starting at ${next}`);
  if (next === 'resize' || next === 'compress') {
    await openResizeModal(next, { chain: true });
  } else if (next === 'autofill') {
    await openAutofillModal();
  } else if (next === 'accept') {
    if (confirm(`Everything is filled. Mark ${selected.length} task(s) as To Accept?`)) await markSelectedAsToAccept();
  } else {
    toast('The selected tasks are already handed in.');
  }
}

function resizeToAutofill() {
  if (resizeState.running) return;
  const ids = resizeState.tasks.map(t => t.id);
  document.getElementById('resize-modal').classList.add('hidden');
  state.selectedIds = new Set(ids);
  render();
  openAutofillModal();
}

function closeResizeModal() {
  if (resizeState.running) {
    if (!confirm(`A ${resizeState.mode} is still running. Cancel it and close?`)) return;
    resizeState.cancelling = true;
    window.app.resizeCancel();
  }
  resizeState.finishChain = false;
  document.getElementById('resize-modal').classList.add('hidden');
}

// ── Settings ─────────────────────────────────────────────────────────────

function showSettingsModal(forced = false) {
  document.getElementById('settings-modal').classList.remove('hidden');
  document.getElementById('settings-cancel-btn').style.display = forced ? 'none' : '';
  document.getElementById('api-key-input').value = '';
  document.getElementById('working-dir-input').value = state.workingDirectory || '';
  document.getElementById('drive-account-index-input').value = state.driveAccountIndex || '';
  document.getElementById('drive-root-input').value = state.driveRootFolderId ? driveFolderLink(state.driveRootFolderId) : '';
  document.getElementById('rclone-remote-input').value = state.rcloneRemote || '';
  document.getElementById('drive-check-status').textContent = '';
  refreshDriveConnectStatus();
  refreshClaudeSection();
  document.getElementById('api-key-input').focus();
}

// ── Google Drive through rclone (read only) ─────────────────────────────────
// main.js runs rclone (drive-rclone.js); drive-index.js matches names. Each
// task's Drive folder becomes its Creative Link in Autofill, and "Open GD
// Folder" opens the task's folder (one task) or its month folder.

function driveConfigured() {
  return !!state.driveRootFolderId;
}

// Months to look in for these records: this month, last month, then the months
// of their Date Done.
function driveMonthsFor(records) {
  return monthsToSearch(toISO(new Date()), records.map(r => r.fields['Date Done']).filter(Boolean));
}

async function findDriveFolders(records) {
  const names = records.map(r => r.fields['Name']).filter(Boolean);
  return window.app.driveFindTaskFolders(names, driveMonthsFor(records));
}

// "Open GD Folder": one task found -> its folder; otherwise the month folders
// its tasks were found in (or this month's folder of their app).
async function openDriveFoldersFor(records, { result = null } = {}) {
  if (!driveConfigured()) {
    toastError('Set the Google Drive root folder in Settings → Google Drive (rclone) first.');
    return;
  }
  try {
    const r = result || await findDriveFolders(records);
    const hits = records.map(rec => (r.matches[rec.fields['Name']] || [])[0]).filter(Boolean);
    let ids;
    if (records.length === 1 && hits.length === 1) {
      ids = [hits[0].id];
    } else {
      const monthPaths = new Set(hits.map(h => h.path.split('/').slice(0, 3).join('/')));
      ids = r.months.filter(m => monthPaths.has(m.path)).map(m => m.id);
      if (!ids.length && r.months.length) ids = [r.months[0].id];
    }
    if (!ids.length) {
      toastError(r.unknownCodes && r.unknownCodes.length
        ? `No app folder on Drive holds ${r.unknownCodes.join(', ')} tasks.`
        : 'No folder found on Drive for these tasks.');
      return;
    }
    [...new Set(ids)].slice(0, 3).forEach(id => window.app.openExternal(rewriteDriveLink(driveFolderLink(id), state.driveAccountIndex)));
  } catch (err) {
    toastError(`Google Drive: ${err.message}`);
  }
}

function hideSettingsModal() {
  document.getElementById('settings-modal').classList.add('hidden');
}

async function saveSettings() {
  const key = document.getElementById('api-key-input').value.trim();
  if (!key) { hideSettingsModal(); return; }
  const btn = document.getElementById('settings-save-btn');
  btn.disabled = true;
  try {
    await window.app.saveSettings({ apiKey: key });
    hideSettingsModal();
    Object.keys(recordsCache).forEach(k => delete recordsCache[k]);
    await init();
  } finally {
    btn.disabled = false;
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────

applyIcons(document);
initTaskPanelResizer();
document.addEventListener('keydown', e => {
  if (e.code === 'KeyK' && (e.metaKey || e.ctrlKey) && !e.altKey) {
    e.preventDefault();
    document.getElementById('palette').classList.contains('hidden') ? openPalette() : closePalette();
  }
});
document.getElementById('palette-input').addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
document.getElementById('palette-input').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = paletteItems.length;
    if (n) paletteIndex = (paletteIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    highlightPalette();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runPaletteItem(paletteIndex, e.metaKey || e.ctrlKey ? 'link' : e.shiftKey ? 'name' : e.altKey ? 'brief' : null);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  }
});
document.getElementById('palette').addEventListener('mousedown', e => {
  if (e.target.id === 'palette') closePalette();
});
document.getElementById('view-toggle').addEventListener('click', e => {
  const btn = e.target.closest('button[data-view]');
  if (!btn || btn.dataset.view === state.view) return;
  state.view = btn.dataset.view;
  try { localStorage.setItem(VIEW_KEY, state.view); } catch { /* per-viewer convenience only */ }
  render();
});

document.getElementById('tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  if (btn.id === 'dashboard-btn') {
    hideCanvasTab();
    showDashboard();
  } else if (btn.id === 'workload-btn') {
    hideCanvasTab();
    showWorkload();
  } else if (btn.id === 'canvas-btn') {
    hideDashboard();
    showCanvasTab();
  } else {
    hideDashboard();
    hideCanvasTab();
    loadTable(btn.dataset.table);
  }
});

document.getElementById('des-select').addEventListener('change', e => {
  state.selectedDES = e.target.value;
  state.selectedDES ? localStorage.setItem('higgtable_des', state.selectedDES)
                     : localStorage.removeItem('higgtable_des');
  render();
  checkDeadlineAlerts();
});

document.getElementById('refresh-btn').addEventListener('click', () => {
  if (document.getElementById('refresh-btn').disabled) return;
  log(`refresh-btn: forcing re-fetch of ${state.activeTable}`);
  refreshTableData(state.activeTable);
});

document.getElementById('dashboard-refresh-btn').addEventListener('click', async () => {
  const btn = document.getElementById('dashboard-refresh-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('spinning');
  log('dashboard-refresh-btn: forcing re-fetch of all 4 tables');
  try {
    for (const name of TARGET_TABLES) {
      await refreshTableData(name);
      maybeRefreshDashboard();
    }
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
});

document.getElementById('bulk-mark-accept-btn').addEventListener('click', markSelectedAsToAccept);
document.getElementById('bulk-mark-inwork-btn').addEventListener('click', markSelectedAsInWork);
document.getElementById('bulk-autofill-btn').addEventListener('click', () => {
  if (document.getElementById('bulk-autofill-btn').disabled) return;
  openAutofillModal();
});
document.getElementById('bulk-resize-btn').addEventListener('click', () => {
  if (document.getElementById('bulk-resize-btn').disabled) return;
  openResizeModal('resize');
});
document.getElementById('bulk-compress-btn').addEventListener('click', () => {
  if (document.getElementById('bulk-compress-btn').disabled) return;
  openResizeModal('compress');
});
document.getElementById('resize-chips').addEventListener('click', e => {
  const chip = e.target.closest('.resize-chip');
  if (!chip || chip.disabled) return;
  if (e.target.closest('.resize-chip-remove')) removeResizeCustomSize(chip.dataset.key);
  else toggleResizeChip(chip.dataset.key);
});
document.getElementById('resize-custom-add').addEventListener('click', addResizeCustomSize);
document.getElementById('autofill-done-accept-btn').addEventListener('click', markAutofilledAsToAccept);
document.getElementById('autofill-done-close-btn').addEventListener('click', () => {
  document.getElementById('autofill-done-modal').classList.add('hidden');
});
['resize-custom-w', 'resize-custom-h'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') addResizeCustomSize();
  });
});
document.getElementById('resize-render-btn').addEventListener('click', startResize);
document.getElementById('resize-close-btn').addEventListener('click', closeResizeModal);
document.getElementById('resize-autofill-btn').addEventListener('click', resizeToAutofill);
document.getElementById('open-folder-btn').addEventListener('click', () => openCurrentTaskFolder());
document.getElementById('task-panel-folder-btn').addEventListener('click', () => openCurrentTaskFolder(state.selectedTask));
document.getElementById('task-panel-details-btn').addEventListener('click', () => {
  if (state.selectedTask) openRecordModal(state.selectedTask, state.activeTable);
});
document.getElementById('task-panel-close-btn').addEventListener('click', () => { clearTaskSelection(); render(); });
document.getElementById('task-panel-copy-brief-btn').addEventListener('click', copyPanelBrief);
document.getElementById('bulk-finish-btn').addEventListener('click', finishSelected);
// Shift-click extends the row selection; without this the browser also
// selects the text between the two clicks, painting the table blue.
document.getElementById('records-container').addEventListener('mousedown', e => {
  if (e.shiftKey && e.target.closest('tbody tr, .board-card')) e.preventDefault();
});
// ⌘C / Ctrl+C copies the selected task names, ⌘⇧C / Ctrl+Shift+C names + briefs.
// e.code, not e.key, so it works on any keyboard layout (Ukrainian "с" too).
// Ordinary copy wins whenever there is something else to copy: focus in a
// field, text selected on the page, or a modal open.
document.addEventListener('keydown', e => {
  if (e.code !== 'KeyC' || !(e.metaKey || e.ctrlKey) || e.altKey) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (String(window.getSelection() || '').trim()) return;
  if (document.getElementById('records-container').classList.contains('hidden')) return;
  if ([...document.querySelectorAll('.modal-overlay')].some(m => !m.classList.contains('hidden'))) return;
  if (!state.selectedIds.size) return;
  e.preventDefault();
  copySelectedTasks(e.shiftKey ? 'brief' : 'name');
});
// Links in the panel's brief open in the system browser, like the task window.
document.getElementById('task-panel-brief').addEventListener('click', e => {
  const link = e.target.closest('a[href]');
  if (!link) return;
  e.preventDefault();
  window.app.openExternal(rewriteDriveLink(link.href, state.driveAccountIndex));
});
window.addEventListener('focus', () => refreshTaskFileIndex());
document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (document.getElementById('records-container').classList.contains('hidden')) return;
  const modalOpen = [...document.querySelectorAll('.modal-overlay')].some(m => !m.classList.contains('hidden'));
  if (modalOpen) return;
  e.preventDefault();
  moveTaskCursor(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
});
document.getElementById('resize-task-list').addEventListener('click', e => {
  const btn = e.target.closest('.resize-row-folder');
  if (btn) window.app.revealFile(btn.dataset.path);
});
window.app.onResizeProgress(applyResizeProgress);
const taskSearchInput = document.getElementById('task-search');
taskSearchInput.addEventListener('input', renderTaskSearchResults);
taskSearchInput.addEventListener('focus', renderTaskSearchResults);
taskSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeTaskSearch({ clear: true }); taskSearchInput.blur(); return; }
  if (e.key === 'Enter') {
    const first = document.querySelector('#task-search-results .task-search-open');
    if (first) first.click();
  }
});
// Clicking anywhere else dismisses the results without clearing the query, so
// the search can be reopened by focusing the box again.
document.addEventListener('click', (e) => {
  if (!e.target.closest('#task-search-control')) closeTaskSearch();
});
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f') return;
  // The search box sits in the header, behind any open modal — focusing it from
  // under a dialog would look like the shortcut did nothing.
  const modalOpen = [...document.querySelectorAll('.modal-overlay')]
    .some(m => !m.classList.contains('hidden'));
  if (modalOpen) return;
  e.preventDefault();
  taskSearchInput.focus();
  taskSearchInput.select();
});

document.getElementById('fix-ratios-btn').addEventListener('click', applyAllRatioCrops);

document.getElementById('auto-fix-ratio-input').addEventListener('change', async (e) => {
  state.autoFixRatio = e.target.checked;
  await window.app.saveSettings({ autoFixRatio: state.autoFixRatio });
  log(`auto-fix-ratio: ${state.autoFixRatio ? 'on' : 'off'}`);
  // Switching it on fixes whatever is already waiting, rather than only
  // applying to the next batch.
  if (state.autoFixRatio) applyAllRatioCrops();
});

document.getElementById('bulk-copy-name-btn').addEventListener('click', () => copySelectedTasks('name'));
document.getElementById('bulk-copy-brief-btn').addEventListener('click', () => copySelectedTasks('brief'));
document.getElementById('bulk-copy-ref-btn').addEventListener('click', () => copySelectedTasks('ref'));
document.getElementById('copy-brief-btn').addEventListener('click', copyOpenTaskBrief);

document.getElementById('bulk-clear-btn').addEventListener('click', () => {
  // Also close the rename panel: a single click selects the task AND opens the
  // panel, so clearing only the selection would leave the panel sitting over a
  // task that is no longer selected.
  clearTaskSelection();
  state.selectedIds.clear();
  render();
});

document.getElementById('autofill-links').addEventListener('input', () => {
  pendingLinkOrder = null;   // a new paste replaces any manual arrangement
  renderLinkPairs();
});
document.getElementById('autofill-drive-order-input').addEventListener('change', () => {
  pendingLinkOrder = null;
  renderLinkPairs();
});
document.getElementById('autofill-approval-confirm-btn').addEventListener('click', confirmAutofill);
document.getElementById('autofill-approval-cancel-btn').addEventListener('click', closeAutofillModal);
document.getElementById('autofill-approval-modal').addEventListener('click', e => {
  if (e.target.id === 'autofill-approval-modal') closeAutofillModal();
});

document.getElementById('dashboard-view-toggle').addEventListener('click', e => {
  const btn = e.target.closest('button[data-dash-view]');
  if (!btn || btn.dataset.dashView === state.dashboardView) return;
  state.dashboardView = btn.dataset.dashView;
  try { localStorage.setItem('higgtable_dash_view', state.dashboardView); } catch { /* per-viewer convenience only */ }
  renderDashboard();
});
document.getElementById('dashboard-controls').addEventListener('click', e => {
  const btn = e.target.closest('.dash-preset');
  if (!btn) return;
  state.dashboardPreset = btn.dataset.preset;
  syncDashboardControls();
  renderDashboard();
});
document.getElementById('workload-controls').addEventListener('click', e => {
  const btn = e.target.closest('.workload-scope');
  if (!btn) return;
  state.workloadTable = btn.dataset.table;
  renderWorkload();
});
document.getElementById('workload-product').addEventListener('change', e => {
  state.workloadProduct = e.target.value;
  renderWorkload();
});
document.getElementById('autofill-hours-all').addEventListener('change', e => applyAutofillHoursToAll(e.target.value));
document.getElementById('dashboard-from').addEventListener('change', e => {
  state.dashboardCustomFrom = e.target.value;
  renderDashboard();
});
document.getElementById('dashboard-to').addEventListener('change', e => {
  state.dashboardCustomTo = e.target.value;
  renderDashboard();
});

document.getElementById('settings-btn').addEventListener('click', () => showSettingsModal(false));
document.getElementById('settings-save-btn').addEventListener('click', saveSettings);
document.getElementById('settings-cancel-btn').addEventListener('click', hideSettingsModal);
document.getElementById('api-key-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveSettings(); });
document.getElementById('browse-dir-btn').addEventListener('click', async () => {
  const dir = await window.app.pickDirectory();
  if (!dir) return;
  state.workingDirectory = dir;
  refreshTaskFileIndex(true);
  document.getElementById('working-dir-input').value = dir;
  await window.app.saveSettings({ workingDirectory: dir });
  log(`browse-dir-btn: working directory set to ${dir}`);
});

document.getElementById('autofill-open-drive-btn').addEventListener('click', async () => {
  const btn = document.getElementById('autofill-open-drive-btn');
  btn.disabled = true;
  try {
    // While Autofill's own lookup runs, wait for it rather than start another.
    let result = autofillDriveResult;
    if (!result && autofillDrivePromise) result = await autofillDrivePromise.catch(() => null);
    await openDriveFoldersFor(pendingAutofillCandidates.map(c => c.rec), { result });
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('autofill-find-drive-btn').addEventListener('click', () => findAutofillLinksOnDrive());
document.getElementById('drive-root-input').addEventListener('change', async e => {
  const raw = e.target.value.trim();
  const id = raw ? folderIdFromInput(raw) : '';
  if (raw && !id) {
    toastError('That is not a Drive folder link: open the folder in Drive and copy the address (it contains "/folders/").');
    e.target.value = state.driveRootFolderId ? driveFolderLink(state.driveRootFolderId) : '';
    return;
  }
  state.driveRootFolderId = id;
  e.target.value = id ? driveFolderLink(id) : '';
  await window.app.saveSettings({ driveRootFolderId: id });
  log(`drive-root-input: root folder ${id || '(cleared)'}`);
});
document.getElementById('rclone-remote-input').addEventListener('change', async e => {
  const value = e.target.value.trim();
  if (value && !/^[A-Za-z0-9_.-]+$/.test(value)) { toastError('An rclone remote name has only letters, digits, "_", "." and "-".'); return; }
  state.rcloneRemote = value;
  await window.app.saveSettings({ rcloneRemote: value });
});
// Settings: whether the rclone remote exists, and a button that creates it
// (rclone opens Google's sign-in in the browser and waits for it).
async function refreshDriveConnectStatus() {
  const status = document.getElementById('drive-connect-status');
  const btn = document.getElementById('drive-connect-btn');
  status.className = '';
  status.textContent = 'Checking rclone…';
  try {
    const st = await window.app.driveStatus();
    btn.classList.toggle('hidden', st.connected);
    status.className = st.connected ? 'ok' : '';
    status.textContent = st.connected
      ? `Connected (${st.remote}, ${st.version})`
      : `Not connected yet (${st.version})`;
  } catch (err) {
    btn.classList.remove('hidden');
    status.className = 'bad';
    status.textContent = err.message;
  }
}
document.getElementById('drive-connect-btn').addEventListener('click', async () => {
  const status = document.getElementById('drive-connect-status');
  const btn = document.getElementById('drive-connect-btn');
  btn.disabled = true;
  status.className = '';
  status.textContent = 'Sign in to Google in the browser window that opened, then come back here…';
  try {
    await window.app.driveConnect();
    toast('Google Drive connected');
  } catch (err) {
    toastError(`Google Drive: ${err.message}`);
  } finally {
    btn.disabled = false;
    refreshDriveConnectStatus();
  }
});
document.getElementById('drive-check-btn').addEventListener('click', async () => {
  const status = document.getElementById('drive-check-status');
  const btn = document.getElementById('drive-check-btn');
  btn.disabled = true;
  status.className = '';
  status.textContent = 'Checking…';
  try {
    const { apps } = await window.app.driveCheck();
    status.className = 'ok';
    status.textContent = `Works: ${apps.length} folders, e.g. ${apps.slice(0, 3).join(', ')}`;
  } catch (err) {
    status.className = 'bad';
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
// ── Claude (read-only MCP server) ──────────────────────────────────────────
// Settings → Claude adds HiggTable to Claude Desktop's config (main.js,
// claude-config.js), so Claude reads tasks through mcp-server.js instead of the
// Airtable connector. "I am" is who my_tasks means by "me"; it is kept apart
// from the "You:" picker, which is also a filter people point at others.

const CLAUDE_STATUS_TEXT = {
  connected: ['ok', 'Connected'],
  'not-connected': ['', 'Not connected'],
  outdated: ['bad', 'Connected to an old location (reconnect)'],
  invalid: ['bad', "Claude's config file is not valid JSON; fix or remove it first"],
  unsupported: ['bad', 'Only on macOS and Windows'],
};

function showClaudeStatus(status) {
  const el = document.getElementById('claude-connect-status');
  const [cls, text] = CLAUDE_STATUS_TEXT[status] || ['bad', status];
  el.className = `status-pill ${cls}`.trim();
  el.textContent = text;
  const linked = status === 'connected' || status === 'outdated';
  document.getElementById('claude-disconnect-btn').classList.toggle('hidden', !linked);
  // Not connected yet: Connect is the one thing to do, so it is the primary
  // button. Once connected it becomes a quiet Reconnect.
  const btn = document.getElementById('claude-connect-btn');
  btn.classList.toggle('primary', !linked || status === 'outdated');
  btn.innerHTML = iconSvg(linked ? 'refresh' : 'link');
  btn.append(linked ? 'Reconnect' : 'Connect to Claude Desktop');
}

async function refreshClaudeSection() {
  const select = document.getElementById('claude-designer-select');
  const names = [...new Set(Object.values(recordsCache).flat()
    .map(r => String(r.fields['DES'] || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const settings = await window.app.getSettings().catch(() => ({}));
  const current = settings.selectedDesigner || state.selectedDES || '';
  if (current && !names.includes(current)) names.unshift(current);
  select.replaceChildren(new Option('— choose —', ''), ...names.map(n => new Option(n, n)));
  select.value = current;
  try {
    showClaudeStatus((await window.app.claudeStatus()).status);
  } catch (err) {
    showClaudeStatus(err.message);
  }
}

document.getElementById('claude-designer-select').addEventListener('change', async e => {
  await window.app.saveSettings({ selectedDesigner: e.target.value });
});
document.getElementById('claude-connect-btn').addEventListener('click', async () => {
  const btn = document.getElementById('claude-connect-btn');
  btn.disabled = true;
  try {
    const { status } = await window.app.claudeConnect(document.getElementById('claude-designer-select').value);
    showClaudeStatus(status);
    if (status === 'connected') toast('Connected. Quit and reopen Claude to use it.');
    else toastError(`Claude: ${(CLAUDE_STATUS_TEXT[status] || [, status])[1]}`);
  } catch (err) {
    toastError(`Claude: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('claude-disconnect-btn').addEventListener('click', async () => {
  try {
    showClaudeStatus((await window.app.claudeDisconnect()).status);
  } catch (err) {
    toastError(`Claude: ${err.message}`);
  }
});
document.getElementById('claude-code-copy-btn').addEventListener('click', async e => {
  const btn = e.currentTarget;
  try {
    await window.app.copyToClipboard(await window.app.claudeCodeCommand());
    flashCopied(btn, 1, 'Copied');
  } catch (err) {
    toastError(`Claude: ${err.message}`);
  }
});
// On Windows an update most likely closed the server Claude was running.
window.app.claudeStatus().then(st => {
  if (st.updatedSinceLastRun && st.status === 'connected') {
    toast('HiggTable was updated. Quit and reopen Claude to reconnect.');
  }
}).catch(() => {});

document.getElementById('settings-modal').addEventListener('click', e => {
  const link = e.target.closest('a[data-external]');
  if (!link) return;
  e.preventDefault();
  window.app.openExternal(link.href);
});

document.getElementById('drive-account-index-input').addEventListener('change', async (e) => {
  const value = e.target.value.trim();
  state.driveAccountIndex = value;
  await window.app.saveSettings({ driveAccountIndex: value });
  log(`drive-account-index-input: Drive account index set to "${value}"`);
});

document.getElementById('record-modal-close').addEventListener('click', closeRecordModal);
document.getElementById('record-modal').addEventListener('click', e => {
  if (e.target.id === 'record-modal') closeRecordModal();
});
document.getElementById('record-fields-settings-btn').addEventListener('click', () => openFieldSettings(currentDetailTable));
document.getElementById('columns-btn').addEventListener('click', () => openFieldSettings(state.activeTable, { columnsOnly: true }));
document.getElementById('notify-bell-btn').addEventListener('click', e => {
  e.stopPropagation();
  toggleNotificationDropdown();
});
document.getElementById('notify-mute-btn').addEventListener('click', toggleMute);
document.addEventListener('click', e => {
  if (!notifyDropdownOpen) return;
  if (e.target.closest('#notifications-control')) return;
  toggleNotificationDropdown();
});
document.getElementById('field-settings-done-btn').addEventListener('click', closeFieldSettings);
document.getElementById('field-settings-modal').addEventListener('click', e => {
  if (e.target.id === 'field-settings-modal') closeFieldSettings();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!document.getElementById('resize-modal').classList.contains('hidden')) {
    closeResizeModal();
  } else if (!document.getElementById('field-settings-modal').classList.contains('hidden')) {
    closeFieldSettings();
  } else if (!document.getElementById('record-modal').classList.contains('hidden')) {
    closeRecordModal();
  }
});

document.getElementById('rename-panel-close').addEventListener('click', clearTaskSelection);
document.getElementById('browse-files-btn').addEventListener('click', async () => {
  const paths = await window.app.openFileDialog();
  if (paths.length) await addFiles(paths);
});
document.getElementById('clear-files-btn').addEventListener('click', () => {
  state.pendingFiles = [];
  renderFileList();
});
document.getElementById('rename-btn').addEventListener('click', performRename);

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', async e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const paths = Array.from(e.dataTransfer.files).map(f => f.path).filter(Boolean);
  if (paths.length) await addFiles(paths);
});

// ── Util ────────────────────────────────────────────────────────────────

// Airtable's upload endpoint returns `fields` keyed by field ID, not name, so
// reading result.fields['Preview'] blanked the local copy after every upload.
function uploadedAttachments(result, fieldName) {
  const fields = (result && result.fields) || {};
  return fields[fieldName] || Object.values(fields)[0] || [];
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('statusbar');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
}

function showProgressBar() {
  document.getElementById('progress-bar').classList.add('active');
}

function hideProgressBar() {
  document.getElementById('progress-bar').classList.remove('active');
}

function setRefreshBusy(busy) {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = busy;
  btn.classList.toggle('spinning', busy);
}

if (isNotificationsMuted()) {
  document.getElementById('notify-mute-btn').classList.add('muted');
}

renderNotificationBell();

boot();
