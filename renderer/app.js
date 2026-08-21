const TARGET_BASE = 'UT Marketing Team';
const TARGET_TABLES = ['VCP Creatives', 'PLM Creatives', 'CMC Creatives', 'LB Creatives'];
const DEFAULT_STATUSES = ['In work', 'Ready for Design'];
const COLUMNS = ['Name', 'Priority', 'Deadline', 'Branch', 'Model ID', 'Script ID', 'Size', 'CP', 'DES', 'Format', 'Network', 'Type', 'Language', 'Status'];
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
  dashboardPreset: 'week', // 'week' | 'lastWeek' | 'month' | 'prevMonth' | 'all' | 'custom'
  dashboardCustomFrom: '',
  dashboardCustomTo: '',
  highlightRecordId: null,
  hiddenFields: JSON.parse(localStorage.getItem('higgtable_hidden_fields') || '{}'), // { tableName: [fieldName, ...] }
  selectedIds: new Set(), // multi-selected rows in the active table, for bulk actions
  selectionAnchorId: null, // last row touched by a plain/Cmd click, for Shift-click ranges
  workingDirectory: '', // folder searched by "Set Previews" for "<task>_1x1.png" files
  driveAccountIndex: '', // Google account index (drive.google.com/drive/u/N/...) for rewriting Drive links before opening; '' = no rewriting
  driveAppFolders: {}, // { appCode: driveFolderId } for delivery destinations; missing/blank = uploads abort
  driveAppMirrors: {}, // { baseCode: [mirrorCode] } — mirror apps deliver into their base app's folder
  driveTestMode: false, // redirect uploads to a test folder and skip the Airtable write
  driveTestFolderId: '',
  driveIncludeProjectFiles: false, // ship .aep/.psd sources too; off while testing the automation
};

// App-code -> display name for the Drive delivery folder. Codes are the first
// token of a task Name; folder names end in "_creatives". Mirror apps use
// different leading codes and can be added here.
const DRIVE_APP_LABELS = {
  CMC: 'Call Me Chat_creatives',
  LO: 'Lowins_creatives',
  OL: 'Olive_creatives',
  PL: 'Plamfy_creatives',
  TL: 'TopLive_creatives',
};

let currentDetailRecord = null;
let currentDetailTable = null;

const recordsCache = {};
const seenTaskIds = {};
const tablesInFlight = new Set(); // prevents duplicate concurrent fetches for the same table
const POLL_INTERVAL_MS = 5 * 60 * 1000;
let pollTimer = null;
let requestCounter = 0;

const SEEN_IDS_KEY = 'higgtable_seen_ids_v1';
const NOTIFICATIONS_KEY = 'higgtable_notifications_v1';

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

function startOfWeek(d) {
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1) - day; // shift to Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return monday;
}

function getDashboardRange() {
  const today = new Date();
  switch (state.dashboardPreset) {
    case 'week': {
      const from = startOfWeek(today);
      const to = new Date(from); to.setDate(from.getDate() + 6);
      return { from: toISO(from), to: toISO(to) };
    }
    case 'lastWeek': {
      const from = startOfWeek(today); from.setDate(from.getDate() - 7);
      const to = new Date(from); to.setDate(from.getDate() + 6);
      return { from: toISO(from), to: toISO(to) };
    }
    case 'month': {
      const from = new Date(today.getFullYear(), today.getMonth(), 1);
      const to = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { from: toISO(from), to: toISO(to) };
    }
    case 'prevMonth': {
      const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const to = new Date(today.getFullYear(), today.getMonth(), 0);
      return { from: toISO(from), to: toISO(to) };
    }
    case 'custom':
      return { from: state.dashboardCustomFrom || null, to: state.dashboardCustomTo || null };
    case 'all':
    default:
      return { from: null, to: null };
  }
}

// ── Boot ────────────────────────────────────────────────────────────────

async function boot() {
  log('boot: checking for API key');
  const settings = await window.app.getSettings();
  state.workingDirectory = settings.workingDirectory || '';
  state.driveAccountIndex = settings.driveAccountIndex || '';
  state.driveAppFolders = settings.driveAppFolders || {};
  state.driveAppMirrors = settings.driveAppMirrors || {};
  state.driveTestMode = settings.driveTestMode === true;
  state.driveTestFolderId = settings.driveTestFolderId || '';
  state.driveIncludeProjectFiles = settings.driveIncludeProjectFiles === true;
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
    await loadTable(state.activeTable);
    log(`init: active table ready (${Date.now() - t0}ms elapsed), preloading the rest in background`);
    await preloadOtherTables();
    log(`init: all tables preloaded, total init took ${Date.now() - t0}ms`);
    runColdStartCatchUp();
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
    refreshDES();
    render();
    setStatus(`Loading ${tableName}... ${totalSoFar} records so far (page ${page})`);
  });

  try {
    const records = newestFirst(await window.airtable.getRecords(state.baseId, tableInfo.id, requestId));
    log(`loadTable(${tableName}): fetched ${records.length} records in ${Date.now() - t0}ms`);
    // Guard: user may have switched tabs while this fetch was in flight
    if (state.activeTable !== tableName) {
      recordsCache[tableName] = records;
      log(`loadTable(${tableName}): tab changed mid-fetch, caching only`);
      return;
    }
    recordsCache[tableName] = records;
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
    recordsCache[name] = newestFirst(await window.airtable.getRecords(state.baseId, info.id));
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
      recordsCache[name] = newestFirst(await window.airtable.getRecords(state.baseId, info.id));
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

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollForUpdates, POLL_INTERVAL_MS);
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
    fresh = newestFirst(await window.airtable.getRecords(state.baseId, info.id));
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
  recordsCache[name] = fresh;
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

// Synthesizes a short two-tone chime via the Web Audio API — no bundled
// audio asset to ship or license. No-ops while muted.
function playNotificationSound() {
  if (isNotificationsMuted()) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const now = ctx.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    const start = now + i * 0.09;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.2);
  });
  setTimeout(() => ctx.close(), 500);
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
    const { priority, urgency, isUrgent } = resolveNotificationBadges(n, liveRec, today);
    const btn = document.createElement('button');
    btn.className = `notify-item${n.read ? ' read' : ''}${isUrgent ? ' urgent' : ''}`;
    const shortTable = n.tableName.replace(' Creatives', '');
    const timeSpan = document.createElement('span');
    timeSpan.className = 'notify-item-time';
    timeSpan.textContent = new Date(n.timestamp).toLocaleString();
    btn.appendChild(timeSpan);
    btn.appendChild(document.createTextNode(n.taskName));
    if (priority) {
      const priorityPill = document.createElement('span');
      priorityPill.className = 'select-pill';
      priorityPill.textContent = priority;
      const swatch = singleSelectSwatch(n.tableName, 'Priority', priority);
      if (swatch) { priorityPill.style.background = swatch.bg; priorityPill.style.color = swatch.text; }
      btn.appendChild(priorityPill);
    }
    if (DEADLINE_LABELS[urgency]) {
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

function render() {
  const filtered = state.records.filter(r => {
    const des = r.fields['DES'] || '';
    const status = r.fields['Status'] || '';
    return (!state.selectedDES || des === state.selectedDES)
      && (state.activeStatuses.size === 0 || state.activeStatuses.has(status));
  });

  // Base sort is always Priority, then Deadline — the user's chosen column
  // (Name by default) only breaks ties within that.
  filtered.sort((a, b) => {
    const pa = PRIORITY_RANK[a.fields['Priority']] ?? 3;
    const pb = PRIORITY_RANK[b.fields['Priority']] ?? 3;
    if (pa !== pb) return pa - pb;

    const da = a.fields['Deadline'] || '';
    const db = b.fields['Deadline'] || '';
    if (da !== db) return !da ? 1 : !db ? -1 : (da < db ? -1 : 1);

    const col = state.sortCol || 'Name';
    const dir = state.sortCol ? state.sortDir : 'asc';
    const av = String(a.fields[col] || '');
    const bv = String(b.fields[col] || '');
    const cmp = av.localeCompare(bv);
    return dir === 'asc' ? cmp : -cmp;
  });

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

  ['#', ...cols].forEach(name => {
    const th = document.createElement('th');
    if (name === '#') {
      th.textContent = '#';
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
  filtered.forEach((rec, i) => {
    const tr = tbody.insertRow();
    if (state.selectedTask && state.selectedTask.id === rec.id) tr.classList.add('selected');
    if (state.selectedIds.has(rec.id)) tr.classList.add('bulk-selected');
    if (state.highlightRecordId === rec.id) {
      tr.classList.add('highlight-flash');
      highlightedRow = tr;
    }
    tr.onclick = e => onRowClick(rec, tr, e, i, filtered);
    tr.ondblclick = () => openRecordModal(rec, state.activeTable);

    const tdN = tr.insertCell(); tdN.textContent = i + 1;
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
      if (col === 'Name') td.title = String(val || '');
    });
  });

  container.innerHTML = '';
  container.appendChild(table);
  setStatus(`${filtered.length} of ${state.records.length} records`);
  updateBulkActionsBar();

  if (state.highlightRecordId) {
    if (highlightedRow) highlightedRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    state.highlightRecordId = null; // one-shot — don't replay on the next unrelated render
  }
}

// ── Bulk actions ─────────────────────────────────────────────────────────

function updateBulkActionsBar() {
  const bar = document.getElementById('bulk-actions-bar');
  const count = state.selectedIds.size;
  bar.classList.toggle('hidden', count === 0);
  document.getElementById('bulk-actions-count').textContent = `${count} selected`;
}

async function markSelectedAsToAccept() {
  if (!state.selectedIds.size) return;
  const tableInfo = state.tables[state.activeTable];
  if (!tableInfo) return;

  const ids = [...state.selectedIds];
  const today = toISO(new Date());
  const btn = document.getElementById('bulk-mark-accept-btn');
  btn.disabled = true;
  btn.textContent = 'Updating...';
  try {
    const updates = ids.map(id => ({ id, fields: { Status: 'To accept', 'Date Done': today } }));
    const results = await window.airtable.updateRecords(state.baseId, tableInfo.id, updates);
    const byId = new Map(results.map(r => [r.id, r]));
    state.records.forEach(rec => {
      const updated = byId.get(rec.id);
      if (updated) rec.fields = updated.fields;
    });
    log(`markSelectedAsToAccept: updated ${results.length} record(s) to To accept`);
    state.selectedIds.clear();
    render();
    maybeRefreshDashboard();
  } catch (err) {
    alert(`Failed to update some records: ${err.message}`);
    log(`markSelectedAsToAccept: FAILED — ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Mark as To Accept';
  }
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
}

function hideDashboard() {
  document.getElementById('dashboard-container').classList.add('hidden');
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

function renderDashboard() {
  const { rows, allTypes, notLoaded, from, to, hoursRows, totalHours, avgHours } = computeDashboardStats();
  const rangeLabel = document.getElementById('dashboard-range-label');
  rangeLabel.textContent = (from || to) ? `${from || '…'} → ${to || '…'}` : 'All time';

  const area = document.getElementById('dashboard-table-area');
  area.innerHTML = '';

  if (notLoaded.length) {
    const note = document.createElement('p');
    note.className = 'dash-note warn';
    note.textContent = `Still loading: ${notLoaded.join(', ')} — totals will update once ready (try again shortly).`;
    area.appendChild(note);
  }

  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'dash-note';
    empty.textContent = 'No "Done" or "To accept" tasks found for this period.';
    area.appendChild(empty);
    return;
  }

  const maxTotal = rows[0].total;
  const table = document.createElement('table');
  table.className = 'dash-table';

  const caption = document.createElement('caption');
  caption.textContent = 'Done + To accept tasks by designer, across VCP / PLM / CMC / LB';
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
      remove.textContent = '×';
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
    rec.fields[field.name] = result.fields[field.name];
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
    alert(`Failed to save: ${errMsg}`);
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
    render();
    return;
  }
  if (e && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    state.selectedIds.has(rec.id) ? state.selectedIds.delete(rec.id) : state.selectedIds.add(rec.id);
    state.selectionAnchorId = rec.id;
    render();
    return;
  }

  state.selectedIds.clear();
  state.selectionAnchorId = rec.id;
  if (state.selectedTask && state.selectedTask.id === rec.id) {
    clearTaskSelection();
    render();
    return;
  }
  state.selectedTask = rec;
  openRenamePanel(rec);
  render();
}

function openRenamePanel(rec) {
  const name = rec.fields['Name'] || '';
  document.getElementById('rename-task-name').textContent = name;
  document.getElementById('rename-panel').classList.remove('hidden');
  state.pendingFiles = [];
  renderFileList();
}

function clearTaskSelection() {
  state.selectedTask = null;
  document.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
  document.getElementById('rename-panel').classList.add('hidden');
  state.pendingFiles = [];
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

// ── File handling ────────────────────────────────────────────────────────

async function addFiles(paths) {
  setStatus('Detecting dimensions...');
  for (const p of paths) {
    if (state.pendingFiles.find(f => f.path === p)) continue;
    const name = p.split('/').pop();
    try {
      const dims = await window.app.getFileDimensions(p);
      const ratio = ratioFromDimensions(dims.width, dims.height);
      state.pendingFiles.push({ path: p, name, width: dims.width, height: dims.height, ratio });
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
    }
    list.appendChild(row);
  });

  // Check for duplicate ratios
  const ratios = state.pendingFiles.filter(f => !f.error).map(f => f.ratio);
  const dupes = ratios.filter((r, i) => ratios.indexOf(r) !== i);
  const warn = document.getElementById('rename-warning');
  if (dupes.length) {
    warn.textContent = `⚠ Duplicate ratio: ${[...new Set(dupes)].join(', ')}`;
  } else {
    warn.textContent = '';
  }

  footer.classList.remove('hidden');
}

const PREVIEW_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);


// Uploads the task's local folder to Drive, then writes the Drive folder link
// into Creative Link — but only if every file was verified present. A wrong
// link is worse than none: it would look like a delivery that never happened.

// Bulk delivery: each selected task's local folder is uploaded whole via Drive's
// Folder upload. Tasks run sequentially (the chooser is selectSingle) and each
// commits independently — one failure never discards the others' work.
// Links tasks to folders the user has ALREADY uploaded to Drive by hand. Reads
// Drive, never writes to it. A link reaches Airtable only for an exact,
// unambiguous folder-name match.
async function linkSelectedFromDrive() {
  if (!state.selectedIds.size) return;

  const records = state.records.filter(r => state.selectedIds.has(r.id) && r.fields['Name']);
  if (!records.length) return;

  const folderMap = buildFolderMap(state.driveAppFolders, state.driveAppMirrors);
  // Real delivery folders are <app>/<year>/<month>/<task>, so the year is needed
  // as well as the month to know where to look first.
  const now = new Date();
  const monthName = monthFolderName(toISO(now));
  const monthYear = now.getFullYear();

  const candidates = records.map(rec => {
    const taskName = rec.fields['Name'];
    const code = appCodeFromTaskName(taskName);
    return {
      recordId: rec.id,
      taskName,
      code,
      appFolderId: resolveAppFolderId(code, folderMap),
      existingLink: rec.fields['Creative Link'],
    };
  });

  if (state.driveTestMode && !state.driveTestFolderId) {
    alert('Test mode is on but no test folder is set (Settings \u2192 Drive Delivery Folders).');
    return;
  }

  const { plans, skipped } = planLinkRun({
    candidates,
    testFolderId: state.driveTestFolderId,
    testMode: state.driveTestMode,
  });

  if (!plans.length) {
    alert(`Nothing to link.\n\n${skipped.map(s => `  ${s.taskName} \u2014 ${s.reason}`).join('\n')}`);
    return;
  }

  const lines = [
    ...plans.map(p => `  ${p.taskName}  ->  look up in ${monthName}`),
    ...skipped.map(s => `  ${s.taskName}  ->  SKIP (${s.reason})`),
  ];
  const banner = state.driveTestMode
    ? 'TEST MODE \u2014 reading the test folder and NOT writing Creative Link.\n\n'
    : '';
  if (!confirm(`${banner}Look up ${plans.length} task folder(s) in Drive and fill Creative Link?\n\n${lines.join('\n')}`)) return;

  // One lookup per destination, so a folder is read once no matter how many
  // tasks point at it.
  const byDest = {};
  for (const p of plans) (byDest[p.destFolderId] = byDest[p.destFolderId] || []).push(p);

  const btn = document.getElementById('bulk-drive-link-btn');
  if (btn) btn.disabled = true;
  const results = [...skipped.map(s => ({ task: s.taskName, skipped: s.reason }))];
  const writes = [];

  try {
    const dests = Object.keys(byDest);
    for (let i = 0; i < dests.length; i++) {
      const dest = dests[i];
      const group = byDest[dest];
      if (btn) btn.textContent = `Looking up ${i + 1}/${dests.length}...`;

      const res = await window.app.driveFindFolders({
        appFolderId: dest,
        monthName,
        monthYear,
        taskNames: group.map(p => p.taskName),
      });

      // A failed destination must not sink the others.
      if (!res || res.error) {
        const msg = (res && res.error) || 'unknown error';
        // A signed-out session is the one failure a user can fix immediately, so
        // name the button instead of leaving them to find it.
        const hint = /not signed in/i.test(msg)
          ? `${msg} (Settings \u2192 Google Drive Sign-in)`
          : msg;
        for (const p of group) results.push({ task: p.taskName, error: hint });
        continue;
      }

      const where = res.searched && res.searched.length ? res.searched.join(', ') : 'nothing searchable found';
      // Naming what IS in the destination turns "not found" into something the
      // user can act on — usually a wrong folder configured in Settings.
      const sample = (res.sampleNames && res.sampleNames.length)
        ? `; that folder contains: ${res.sampleNames.join(', ')}`
        : '';
      for (const p of group) {
        const folderId = res.matched[p.taskName];
        if (folderId) {
          writes.push({ recordId: p.recordId, taskName: p.taskName, folderUrl: `https://drive.google.com/drive/folders/${folderId}` });
        } else if ((res.duplicates || []).includes(p.taskName)) {
          results.push({ task: p.taskName, error: `more than one folder named "${p.taskName}" \u2014 resolve it in Drive` });
        } else {
          results.push({ task: p.taskName, error: `no folder named "${p.taskName}" (searched: ${where}${sample})` });
        }
      }
    }

    if (writes.length && !state.driveTestMode) {
      const tableId = state.tables[state.activeTable].id;
      try {
        await window.airtable.updateRecords(state.baseId, tableId,
          writes.map(w => ({ id: w.recordId, fields: { 'Creative Link': w.folderUrl } })));
        for (const w of writes) {
          const rec = state.records.find(r => r.id === w.recordId);
          if (rec) rec.fields['Creative Link'] = w.folderUrl;
          results.push({ task: w.taskName, folderUrl: w.folderUrl });
        }
      } catch (err) {
        for (const w of writes) results.push({ task: w.taskName, error: `found the folder, but Creative Link not written: ${err.message}` });
      }
    } else {
      for (const w of writes) results.push({ task: w.taskName, folderUrl: w.folderUrl });
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Link from Drive'; }
  }

  const s = summarizeBulkRun(results);
  log(`linkSelectedFromDrive: ${s.delivered} linked, ${s.skipped} skipped, ${s.failed} failed`);
  alert(`${state.driveTestMode ? 'TEST MODE \u2014 Creative Link not written.\n\n' : ''}Linked ${s.delivered}, skipped ${s.skipped}, failed ${s.failed}.\n\n${s.lines.join('\n')}`);
  render();
}

async function uploadSelectedToDrive() {
  if (!state.selectedIds.size) return;
  if (!state.workingDirectory) { alert('Set a working directory first (settings).'); return; }

  const records = state.records.filter(r => state.selectedIds.has(r.id) && r.fields['Name']);
  if (!records.length) return;

  const folderMap = buildFolderMap(state.driveAppFolders, state.driveAppMirrors);
  const monthName = monthFolderName(toISO(new Date()));

  // Resolve everything first so the confirm dialog shows the real plan.
  const planned = records.map(rec => {
    const taskName = rec.fields['Name'];
    const code = appCodeFromTaskName(taskName);
    return { rec, taskName, code, appFolderId: resolveAppFolderId(code, folderMap) };
  });

  const lines = planned.map(p => p.appFolderId
    ? `  ${p.taskName}  ->  ${DRIVE_APP_LABELS[p.code] || p.code} / ${monthName}`
    : `  ${p.taskName}  ->  SKIP (no folder configured for "${p.code || '?'}")`);
  const banner = state.driveTestMode
    ? 'TEST MODE — everything goes to the test folder and Creative Link is NOT written.\n\n'
    : '';
  if (!confirm(`${banner}Upload ${planned.length} task folder(s) to Drive?\n\n${lines.join('\n')}\n\nRuns one task at a time and can take a long time.`)) return;

  // Guarded: the button is hidden by default (see renderer/index.html), so this
  // lookup returns null unless someone has uncommented it.
  const btn = document.getElementById('bulk-drive-upload-btn');
  if (btn) btn.disabled = true;
  const results = [];
  // Month folder id per destination, resolved once and reused for the rest of
  // the run. Scoped to this run so deleting folders in Drive between runs can
  // never leave a stale id behind.
  const monthIdByDest = {};
  try {
    for (let i = 0; i < planned.length; i++) {
      const { rec, taskName, code, appFolderId } = planned[i];
      if (btn) btn.textContent = `Uploading ${i + 1}/${planned.length}...`;

      if (!appFolderId) { results.push({ task: taskName, skipped: `no Drive folder configured for "${code || '?'}"` }); continue; }

      const localFolderPath = await window.app.findTaskFolder(state.workingDirectory, taskName);
      if (!localFolderPath) { results.push({ task: taskName, skipped: 'no local folder with that exact name' }); continue; }

      const stripped = await window.app.stripDsStore(localFolderPath, state.workingDirectory);
      if (stripped && stripped.error) { results.push({ task: taskName, error: stripped.error }); continue; }
      if (stripped && stripped.deleted.length) log(`uploadSelectedToDrive: removed ${stripped.deleted.length} .DS_Store from ${taskName}`);

      const destFolderId = state.driveTestMode ? state.driveTestFolderId : appFolderId;
      if (state.driveTestMode && !destFolderId) { results.push({ task: taskName, error: 'test mode on but no test folder set' }); continue; }

      const res = await window.app.driveUploadFolder({
        appFolderId: destFolderId, monthName, taskName, localFolderPath,
        monthFolderId: monthIdByDest[destFolderId],
      });
      if (!res || res.error) { results.push({ task: taskName, error: (res && res.error) || 'unknown error' }); continue; }
      if (res.monthFolderId) monthIdByDest[destFolderId] = res.monthFolderId;

      if (state.driveTestMode) { results.push({ task: taskName, folderUrl: res.folderUrl }); continue; }

      try {
        await window.airtable.updateRecord(state.baseId, state.tables[state.activeTable].id, rec.id, {
          'Creative Link': res.folderUrl,
        });
        rec.fields['Creative Link'] = res.folderUrl;
        results.push({ task: taskName, folderUrl: res.folderUrl });
      } catch (err) {
        results.push({ task: taskName, error: `uploaded, but Creative Link not written: ${err.message}` });
      }
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Upload to Drive'; }
  }

  const s = summarizeBulkRun(results);
  log(`uploadSelectedToDrive: ${s.delivered} delivered, ${s.skipped} skipped, ${s.failed} failed`);
  alert(`${state.driveTestMode ? 'TEST MODE — Creative Link not written.\n\n' : ''}Delivered ${s.delivered}, skipped ${s.skipped}, failed ${s.failed}.\n\n${s.lines.join('\n')}`);
  render();
}

async function uploadTaskToDrive() {
  const rec = state.selectedTask;
  if (!rec) { alert('Select a task first.'); return; }
  const taskName = rec.fields['Name'] || '';

  const code = appCodeFromTaskName(taskName);
  // Mirror codes resolve to their base app's folder.
  const folderMap = buildFolderMap(state.driveAppFolders, state.driveAppMirrors);
  const appFolderId = resolveAppFolderId(code, folderMap);
  if (!appFolderId) {
    alert(`No Drive folder is configured for app code "${code || '(none)'}".\n\nAdd it in Settings → Drive Delivery Folders. Nothing was uploaded.`);
    return;
  }

  const dirs = [...new Set(state.pendingFiles.map(f => f.path.substring(0, f.path.lastIndexOf('/'))))];
  if (dirs.length !== 1) {
    alert('Rename the files first — the task folder was not found.');
    return;
  }
  const sourceDir = dirs[0];

  // SAFETY: only ever upload from the per-task folder performRename() created.
  // Before renaming, these paths point at the raw working directory (e.g. the
  // After Effects folder) — uploading that would dump hundreds of unrelated
  // files into a client's Drive. The folder name must equal the task Name.
  if (sourceDir.split('/').pop() !== taskName) {
    alert(`Not uploading: "${sourceDir}" is not this task's folder.\n\nClick "Rename Files" first — that gathers the files into a folder named after the task. Nothing was uploaded.`);
    return;
  }

  // Selection-based: upload exactly the files listed in the rename panel, not
  // everything sitting in the task folder. Folder-wide upload surprised users
  // by including files left over from earlier runs.
  const allFiles = state.pendingFiles.filter(f => !f.error).map(f => f.path);
  if (!allFiles.length) { alert('No files selected — add files to the panel first.'); return; }

  // Project/source files ship only when the setting is on. Excluded files are
  // always listed below so it is never ambiguous what did and didn't go.
  const { include: filePaths, excluded } = partitionUploadFiles(allFiles, state.driveIncludeProjectFiles);
  if (!filePaths.length) {
    alert(`Nothing to upload — all ${allFiles.length} file(s) are project files, and "Also upload project/source files" is off in Settings.`);
    return;
  }

  // Test mode: the app code is still resolved above (so the unknown-code guard
  // stays meaningful and mirror resolution is exercised), but the destination is
  // redirected and the Airtable write is skipped.
  let destFolderId = appFolderId;
  if (state.driveTestMode) {
    if (!state.driveTestFolderId) {
      alert('Test mode is on but no test folder is set.\n\nAdd one in Settings → Drive Delivery Folders. Nothing was uploaded.');
      return;
    }
    destFolderId = state.driveTestFolderId;
  }

  const monthName = monthFolderName(toISO(new Date()));
  // A mirror code has no label of its own; show the base app it delivers into.
  const baseEntry = Object.entries(DRIVE_APP_LABELS).find(([b]) => state.driveAppFolders[b] === appFolderId);
  const appLabel = DRIVE_APP_LABELS[code] || (baseEntry ? `${baseEntry[1]} (via ${code})` : code);
  const destination = state.driveTestMode
    ? `TEST MODE — uploading to the test folder, NOT ${appLabel}\nTest folder / ${monthName} / ${taskName}\nCreative Link will NOT be written.`
    : `${appLabel} / ${monthName} / ${taskName}`;
  const skipNote = excluded.length
    ? `\n\nNOT uploading ${excluded.length} project file(s):\n${excluded.map(p => p.split('/').pop()).join('\n')}`
    : '';
  if (!confirm(`Upload ${filePaths.length} selected file(s) to Drive?\n\n${destination}\n\n${filePaths.map(p => p.split('/').pop()).join('\n')}${skipNote}`)) {
    return;
  }

  // Guarded: the button is hidden by default (see renderer/index.html), so this
  // lookup returns null unless someone has uncommented it.
  const btn = document.getElementById('drive-upload-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading...'; }
  try {
    const result = await window.app.driveUpload({ appFolderId: destFolderId, monthName, taskName, filePaths });
    if (result.error) {
      alert(`Upload failed — nothing written to Airtable.\n\n${result.error}`);
      return;
    }
    if (result.missing && result.missing.length) {
      alert(`Upload could not be verified — nothing written to Airtable.\n\nMissing in Drive:\n${result.missing.join('\n')}`);
      return;
    }
    if (state.driveTestMode) {
      log(`uploadTaskToDrive: TEST MODE — delivered to ${result.folderUrl}, Creative Link left untouched`);
      alert(`TEST MODE: uploaded ${filePaths.length} file(s) to the test folder.\n\nCreative Link was NOT written.\n\n${result.folderUrl}`);
      return;
    }
    // Verified: safe to record the link. updateRecordField() needs a DOM input
    // to flash status against, so write through the Airtable bridge directly.
    await window.airtable.updateRecord(state.baseId, state.tables[state.activeTable].id, rec.id, {
      'Creative Link': result.folderUrl,
    });
    rec.fields['Creative Link'] = result.folderUrl;
    log(`uploadTaskToDrive: ${filePaths.length} file(s) delivered, Creative Link -> ${result.folderUrl}`);
    const warn = result.warnings && result.warnings.length ? `\n\nWarnings:\n${result.warnings.join('\n')}` : '';
    alert(`Delivered ${filePaths.length} file(s) and set Creative Link.${warn}`);
  } catch (err) {
    alert(`Upload failed — nothing written to Airtable.\n\n${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Upload to Drive'; }
  }
}

async function performRename() {
  const fullTaskName = state.selectedTask ? (state.selectedTask.fields['Name'] || '') : '';
  const taskName = stripAspectRatio(fullTaskName);
  if (!taskName) { alert('No task selected.'); return; }

  const toRename = state.pendingFiles.filter(f => !f.error);
  if (!toRename.length) { alert('No valid files to rename.'); return; }

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
        state.selectedTask.fields['Preview'] = result.fields['Preview'];
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
    alert(`Renamed ${renamed} file(s).\n\nErrors:\n${errors.join('\n')}${previewNote}`);
  } else {
    alert(`Done! Renamed ${renamed} file(s).${previewNote}`);
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
    alert('Set a working directory first (⚙ Settings).');
    return;
  }
  // Autofill normally runs over the bulk selection, but a plain click clears
  // that and selects a single task for the rename panel instead. Fall back to
  // that task so Autofill works for one task without needing Cmd-click.
  const records = state.selectedIds.size
    ? state.records.filter(r => state.selectedIds.has(r.id) && r.fields['Name'])
    : [state.selectedTask].filter(r => r && r.fields['Name']);
  if (!records.length) return;

  const timingChoices = (state.tables[state.activeTable]?.fields || [])
    .find(f => f.name === 'Timing')?.options?.choices?.map(c => c.name) || [];

  // Either trigger may have started this: the bulk bar or the rename panel.
  const btns = ['bulk-autofill-btn', 'panel-autofill-btn']
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
      alert('No preview image or video found for the selected tasks.\n\nSearched every aspect ratio (1x1, 9x16, 4x5, 16x9, ...) as .png/.jpg/.jpeg, and .mp4 video, under the working directory.');
      return;
    }

    await renderAutofillApprovalList();
    document.getElementById('autofill-approval-modal').classList.remove('hidden');
  } catch (err) {
    alert(`Autofill failed: ${err.message}`);
    log(`openAutofillModal: FAILED — ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Autofill';
  }
}

async function renderAutofillApprovalList() {
  const list = document.getElementById('autofill-approval-list');
  list.innerHTML = '';

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

    row.appendChild(info);
    list.appendChild(row);
  });
}

function closeAutofillModal() {
  document.getElementById('autofill-approval-modal').classList.add('hidden');
  pendingAutofillCandidates = [];
}

async function confirmAutofill() {
  const toUpload = pendingAutofillCandidates.filter(c => c.preview?.include && c.preview.path);
  const toSetTiming = pendingAutofillCandidates.filter(c => c.timing?.include && c.timing.choice);
  if (!toUpload.length && !toSetTiming.length) { closeAutofillModal(); return; }

  const btn = document.getElementById('autofill-approval-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Applying...';
  let uploaded = 0, uploadFailed = 0, timed = 0;
  try {
    for (const c of toUpload) {
      try {
        const result = await window.airtable.uploadAttachment(state.baseId, c.rec.id, 'Preview', c.preview.path);
        c.rec.fields['Preview'] = result.fields['Preview'];
        uploaded++;
        log(`confirmAutofill: uploaded ${c.preview.path} to ${c.rec.fields['Name']}`);
      } catch (err) {
        uploadFailed++;
        log(`confirmAutofill: preview upload FAILED for ${c.rec.fields['Name']} — ${err.message}`);
      }
    }

    if (toSetTiming.length) {
      const tableInfo = state.tables[state.activeTable];
      const updates = toSetTiming.map(c => ({ id: c.rec.id, fields: { Timing: c.timing.choice } }));
      try {
        const results = await window.airtable.updateRecords(state.baseId, tableInfo.id, updates);
        const byId = new Map(results.map(r => [r.id, r]));
        toSetTiming.forEach(c => {
          const updated = byId.get(c.rec.id);
          if (updated) c.rec.fields = updated.fields;
        });
        timed = results.length;
        log(`confirmAutofill: set Timing on ${timed} record(s)`);
      } catch (err) {
        log(`confirmAutofill: Timing update FAILED — ${err.message}`);
      }
    }

    render();
    maybeRefreshDashboard();
    alert(`Autofill done.\n\nPreviews uploaded: ${uploaded}${uploadFailed ? `\nPreview upload failed: ${uploadFailed}` : ''}\nTiming set: ${timed}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply Selected';
    closeAutofillModal();
  }
}

// ── Settings ─────────────────────────────────────────────────────────────

function showSettingsModal(forced = false) {
  document.getElementById('settings-modal').classList.remove('hidden');
  document.getElementById('settings-cancel-btn').style.display = forced ? 'none' : '';
  document.getElementById('api-key-input').value = '';
  document.getElementById('working-dir-input').value = state.workingDirectory || '';
  document.getElementById('drive-account-index-input').value = state.driveAccountIndex || '';
  renderDriveAppFolderRows();
  document.getElementById('drive-test-mode-input').checked = state.driveTestMode;
  document.getElementById('drive-test-folder-input').value = state.driveTestFolderId || '';
  document.getElementById('drive-include-project-input').checked = state.driveIncludeProjectFiles;
  document.getElementById('api-key-input').focus();
}

// One row per app code: a code label plus an input that accepts a pasted Drive
// folder URL. The input displays the parsed folder ID rather than the URL, so
// what is stored is visibly what will be used.
function renderDriveAppFolderRows() {
  const wrap = document.getElementById('drive-app-folders');
  wrap.innerHTML = '';
  Object.entries(DRIVE_APP_LABELS).forEach(([code, label]) => {
    const row = document.createElement('div');
    row.className = 'drive-folder-row';

    const codeEl = document.createElement('span');
    codeEl.className = 'drive-folder-code';
    codeEl.textContent = code;
    codeEl.title = label;
    row.appendChild(codeEl);

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = `${label} — paste folder URL`;
    input.value = state.driveAppFolders[code] || '';
    input.addEventListener('change', async () => {
      const raw = input.value.trim();
      if (!raw) {
        delete state.driveAppFolders[code];
      } else {
        const id = parseFolderIdFromUrl(raw);
        if (!id) {
          input.value = '';
          alert(`That doesn't look like a Drive folder URL.\n\nOpen the ${label} folder in Drive and copy the address bar — it should contain "/folders/".`);
          return;
        }
        state.driveAppFolders[code] = id;
      }
      input.value = state.driveAppFolders[code] || '';
      await window.app.saveSettings({ driveAppFolders: state.driveAppFolders });
      log(`drive-app-folders: ${code} -> ${state.driveAppFolders[code] || '(cleared)'}`);
    });
    row.appendChild(input);

    // Mirror apps: different leading code, same destination folder.
    const mirrors = document.createElement('input');
    mirrors.type = 'text';
    mirrors.className = 'drive-folder-mirrors';
    mirrors.placeholder = 'mirrors: BL, HC';
    mirrors.title = `Other task-name prefixes that should also deliver into ${label} — e.g. BL`;
    mirrors.value = (state.driveAppMirrors[code] || []).join(', ');
    mirrors.addEventListener('change', async () => {
      const codes = parseMirrorCodes(mirrors.value);
      if (codes.length) state.driveAppMirrors[code] = codes;
      else delete state.driveAppMirrors[code];
      mirrors.value = codes.join(', ');
      await window.app.saveSettings({ driveAppMirrors: state.driveAppMirrors });
      log(`drive-app-mirrors: ${code} -> ${JSON.stringify(codes)}`);
    });
    row.appendChild(mirrors);

    wrap.appendChild(row);
  });
}

function hideSettingsModal() {
  document.getElementById('settings-modal').classList.add('hidden');
}

async function saveSettings() {
  const key = document.getElementById('api-key-input').value.trim();
  if (!key) { hideSettingsModal(); return; }
  const btn = // Deliberate Google sign-in. Every other Drive path only reaches Google after
// resolving folders and tasks, so a new user with nothing configured never got
// a login window at all.
document.getElementById('drive-signin-btn').addEventListener('click', async () => {
  const btn = document.getElementById('drive-signin-btn');
  const status = document.getElementById('drive-signin-status');
  btn.disabled = true;
  btn.textContent = 'Opening Google...';
  status.textContent = 'A Drive window will open — sign in there, then come back.';
  status.className = '';
  try {
    const r = await window.app.driveSignIn();
    if (r && r.error) {
      status.textContent = r.error;
      status.className = 'signin-bad';
    } else if (r && r.loggedIn) {
      status.textContent = r.alreadySignedIn ? 'Already signed in.' : 'Signed in.';
      status.className = 'signin-ok';
    } else {
      status.textContent = 'Not signed in yet. Click again once the Google window is done.';
      status.className = 'signin-bad';
    }
  } catch (err) {
    status.textContent = `Sign-in failed: ${err.message}`;
    status.className = 'signin-bad';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in to Google Drive';
  }
});

document.getElementById('settings-save-btn');
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

document.getElementById('tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  if (btn.id === 'dashboard-btn') {
    hideCanvasTab();
    showDashboard();
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
document.getElementById('bulk-drive-link-btn').addEventListener('click', () => {
  if (document.getElementById('bulk-drive-link-btn').disabled) return;
  linkSelectedFromDrive();
});

// Drive upload is retained but hidden — see the note in renderer/index.html.
// Guarded so the renderer still loads while the button is commented out.
const bulkUploadBtn = document.getElementById('bulk-drive-upload-btn');
if (bulkUploadBtn) bulkUploadBtn.addEventListener('click', () => {
  if (bulkUploadBtn.disabled) return;
  uploadSelectedToDrive();
});

document.getElementById('bulk-autofill-btn').addEventListener('click', () => {
  if (document.getElementById('bulk-autofill-btn').disabled) return;
  openAutofillModal();
});
document.getElementById('bulk-clear-btn').addEventListener('click', () => {
  state.selectedIds.clear();
  render();
});

document.getElementById('autofill-approval-confirm-btn').addEventListener('click', confirmAutofill);
document.getElementById('autofill-approval-cancel-btn').addEventListener('click', closeAutofillModal);
document.getElementById('autofill-approval-modal').addEventListener('click', e => {
  if (e.target.id === 'autofill-approval-modal') closeAutofillModal();
});

document.getElementById('dashboard-controls').addEventListener('click', e => {
  const btn = e.target.closest('.dash-preset');
  if (!btn) return;
  state.dashboardPreset = btn.dataset.preset;
  syncDashboardControls();
  renderDashboard();
});
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
  document.getElementById('working-dir-input').value = dir;
  await window.app.saveSettings({ workingDirectory: dir });
  log(`browse-dir-btn: working directory set to ${dir}`);
});

document.getElementById('drive-account-index-input').addEventListener('change', async (e) => {
  const value = e.target.value.trim();
  state.driveAccountIndex = value;
  await window.app.saveSettings({ driveAccountIndex: value });
  log(`drive-account-index-input: Drive account index set to "${value}"`);
});

document.getElementById('drive-test-mode-input').addEventListener('change', async (e) => {
  state.driveTestMode = e.target.checked;
  await window.app.saveSettings({ driveTestMode: state.driveTestMode });
  log(`drive-test-mode: ${state.driveTestMode ? 'ON — uploads redirected, Creative Link not written' : 'off'}`);
});

document.getElementById('drive-test-folder-input').addEventListener('change', async (e) => {
  const raw = e.target.value.trim();
  const id = raw ? parseFolderIdFromUrl(raw) : '';
  if (raw && !id) {
    e.target.value = state.driveTestFolderId || '';
    alert('That doesn\'t look like a Drive folder URL. Open the test folder in Drive and copy the address bar.');
    return;
  }
  state.driveTestFolderId = id;
  e.target.value = id;
  await window.app.saveSettings({ driveTestFolderId: id });
  log(`drive-test-folder: ${id || '(cleared)'}`);
});

document.getElementById('drive-include-project-input').addEventListener('change', async (e) => {
  state.driveIncludeProjectFiles = e.target.checked;
  await window.app.saveSettings({ driveIncludeProjectFiles: state.driveIncludeProjectFiles });
  log(`drive-include-project-input: project files ${state.driveIncludeProjectFiles ? 'INCLUDED' : 'excluded'}`);
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
  if (!document.getElementById('field-settings-modal').classList.contains('hidden')) {
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
const driveUploadBtn = document.getElementById('drive-upload-btn');
if (driveUploadBtn) driveUploadBtn.addEventListener('click', uploadTaskToDrive);
document.getElementById('panel-autofill-btn').addEventListener('click', () => {
  if (document.getElementById('panel-autofill-btn').disabled) return;
  openAutofillModal();
});

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
