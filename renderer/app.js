const TARGET_BASE = 'UT Marketing Team';
const TARGET_TABLES = ['VCP Creatives', 'PLM Creatives', 'CMC Creatives', 'LB Creatives'];
const DEFAULT_STATUSES = ['In work', 'Ready for Design'];
const COLUMNS = ['Name', 'Branch', 'Model ID', 'Script ID', 'Size', 'CP', 'DES', 'Format', 'Network', 'Type', 'Language', 'Status'];

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
};

let currentDetailRecord = null;
let currentDetailTable = null;

const recordsCache = {};
const seenTaskIds = {};
const tablesInFlight = new Set(); // prevents duplicate concurrent fetches for the same table
const POLL_INTERVAL_MS = 5 * 60 * 1000;
let pollTimer = null;
let requestCounter = 0;

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
      .forEach(r => notifyNewTask(r, name));
  }
  seenTaskIds[name] = new Set(fresh.map(r => r.id));
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

  if (state.sortCol) {
    filtered.sort((a, b) => {
      const av = String(a.fields[state.sortCol] || '');
      const bv = String(b.fields[state.sortCol] || '');
      return state.sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }

  const container = document.getElementById('records-container');
  if (!filtered.length) {
    container.innerHTML = '<p class="empty">No records match the current filters.</p>';
    setStatus('0 records');
    updateBulkActionsBar();
    return;
  }

  const fieldNames = (state.tables[state.activeTable]?.fields || []).map(f => f.name);
  const cols = COLUMNS.filter(c => fieldNames.includes(c));

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
    });
  });

  const rows = Object.entries(byDES)
    .map(([des, data]) => ({ des, total: data.total, types: data.types }))
    .sort((a, b) => b.total - a.total);

  return { rows, allTypes: [...allTypes].sort(), notLoaded, from, to };
}

function renderDashboard() {
  const { rows, allTypes, notLoaded, from, to } = computeDashboardStats();
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
function openFieldSettings(tableName) {
  if (!tableName) return;
  document.getElementById('field-settings-table-name').textContent = tableName;
  const list = document.getElementById('field-settings-list');
  list.innerHTML = '';
  const hidden = new Set(state.hiddenFields[tableName] || []);
  const fields = state.tables[tableName]?.fields || [];
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

function renderRecordModal(rec, tableName) {
  document.getElementById('record-modal-title').textContent = rec.fields['Name'] || 'Task details';
  const body = document.getElementById('record-modal-body');
  body.innerHTML = '';

  const hidden = new Set(state.hiddenFields[tableName] || []);
  const fields = (state.tables[tableName]?.fields || []).filter(f => !hidden.has(f.name));
  fields.forEach(field => {
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
    body.appendChild(row);
  });
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

  if (type === 'multilineText' || type === 'richText') {
    const ta = document.createElement('textarea');
    ta.rows = 4;
    ta.value = val == null ? '' : String(val);
    ta.onblur = () => updateRecordField(rec, tableName, field, ta.value || null, ta);
    return ta;
  }

  // Fallback for singleLineText, url, email, phoneNumber, and anything else
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = val == null ? '' : String(val);
  inp.onblur = () => updateRecordField(rec, tableName, field, inp.value || null, inp);
  return inp;
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
// so the 1x1 preview file for it lives at "<name minus suffix>_1x1.png"
// somewhere under the working directory (searched recursively) — mirrors the
// auto-upload-on-rename convention in performRename() above, but runs over
// whichever tasks the user Shift/Cmd-click-selected, with a review step
// before anything is actually uploaded to Airtable.

let pendingPreviewCandidates = [];

async function openSetPreviewsModal() {
  if (!state.workingDirectory) {
    alert('Set a working directory first (⚙ Settings).');
    return;
  }
  if (!state.selectedIds.size) return;

  const records = state.records.filter(r => state.selectedIds.has(r.id) && r.fields['Name']);
  if (!records.length) return;

  const btn = document.getElementById('bulk-set-previews-btn');
  btn.disabled = true;
  btn.textContent = 'Searching...';
  try {
    const wanted = records.map(r => `${stripAspectRatio(r.fields['Name'])}_1x1.png`);
    log(`openSetPreviewsModal: searching ${state.workingDirectory} for ${wanted.length} file(s)`);
    const found = await window.app.findPreviewFiles(state.workingDirectory, wanted);

    pendingPreviewCandidates = records.map(rec => {
      const filename = `${stripAspectRatio(rec.fields['Name'])}_1x1.png`;
      return { rec, filename, path: found[filename] || null, include: !!found[filename] };
    });

    if (!pendingPreviewCandidates.some(c => c.path)) {
      alert('No matching "_1x1.png" files found for the selected tasks.');
      return;
    }

    await renderPreviewApprovalList();
    document.getElementById('preview-approval-modal').classList.remove('hidden');
  } catch (err) {
    alert(`Set Previews failed: ${err.message}`);
    log(`openSetPreviewsModal: FAILED — ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Set Previews';
  }
}

async function renderPreviewApprovalList() {
  const list = document.getElementById('preview-approval-list');
  list.innerHTML = '';

  const thumbs = await Promise.all(pendingPreviewCandidates.map(c =>
    c.path ? window.app.readImageDataUrl(c.path).catch(() => null) : Promise.resolve(null)
  ));

  pendingPreviewCandidates.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'preview-approval-row' + (c.path ? '' : ' no-match');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = c.include;
    checkbox.disabled = !c.path;
    checkbox.addEventListener('change', () => { c.include = checkbox.checked; });
    row.appendChild(checkbox);

    const img = document.createElement('img');
    img.className = 'preview-approval-thumb';
    if (thumbs[i]) img.src = thumbs[i];
    row.appendChild(img);

    const info = document.createElement('div');
    info.className = 'preview-approval-info';
    const task = document.createElement('div');
    task.className = 'preview-approval-task';
    task.textContent = c.rec.fields['Name'];
    const file = document.createElement('div');
    file.className = 'preview-approval-file';
    file.textContent = c.path ? c.filename : 'No match found';
    if (c.path) file.title = c.path;
    info.appendChild(task);
    info.appendChild(file);
    row.appendChild(info);

    list.appendChild(row);
  });
}

function closePreviewApprovalModal() {
  document.getElementById('preview-approval-modal').classList.add('hidden');
  pendingPreviewCandidates = [];
}

async function confirmSetPreviews() {
  const toUpload = pendingPreviewCandidates.filter(c => c.include && c.path);
  if (!toUpload.length) { closePreviewApprovalModal(); return; }

  const btn = document.getElementById('preview-approval-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Uploading...';
  let uploaded = 0, failed = 0;
  try {
    for (const c of toUpload) {
      try {
        const result = await window.airtable.uploadAttachment(state.baseId, c.rec.id, 'Preview', c.path);
        c.rec.fields['Preview'] = result.fields['Preview'];
        uploaded++;
        log(`confirmSetPreviews: uploaded ${c.path} to ${c.rec.fields['Name']}`);
      } catch (err) {
        failed++;
        log(`confirmSetPreviews: FAILED for ${c.rec.fields['Name']} — ${err.message}`);
      }
    }
    render();
    maybeRefreshDashboard();
    alert(`Set Previews done.\n\nUploaded: ${uploaded}${failed ? `\nFailed: ${failed}` : ''}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Upload Selected';
    closePreviewApprovalModal();
  }
}

// ── Settings ─────────────────────────────────────────────────────────────

function showSettingsModal(forced = false) {
  document.getElementById('settings-modal').classList.remove('hidden');
  document.getElementById('settings-cancel-btn').style.display = forced ? 'none' : '';
  document.getElementById('api-key-input').value = '';
  document.getElementById('working-dir-input').value = state.workingDirectory || '';
  document.getElementById('api-key-input').focus();
}

function hideSettingsModal() {
  document.getElementById('settings-modal').classList.add('hidden');
}

async function saveSettings() {
  const key = document.getElementById('api-key-input').value.trim();
  if (!key) { alert('Please enter an API key.'); return; }
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

document.getElementById('tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  if (btn.id === 'dashboard-btn') {
    showDashboard();
  } else {
    hideDashboard();
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
document.getElementById('bulk-set-previews-btn').addEventListener('click', () => {
  if (document.getElementById('bulk-set-previews-btn').disabled) return;
  openSetPreviewsModal();
});
document.getElementById('bulk-clear-btn').addEventListener('click', () => {
  state.selectedIds.clear();
  render();
});

document.getElementById('preview-approval-confirm-btn').addEventListener('click', confirmSetPreviews);
document.getElementById('preview-approval-cancel-btn').addEventListener('click', closePreviewApprovalModal);
document.getElementById('preview-approval-modal').addEventListener('click', e => {
  if (e.target.id === 'preview-approval-modal') closePreviewApprovalModal();
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

document.getElementById('record-modal-close').addEventListener('click', closeRecordModal);
document.getElementById('record-modal').addEventListener('click', e => {
  if (e.target.id === 'record-modal') closeRecordModal();
});
document.getElementById('record-fields-settings-btn').addEventListener('click', () => openFieldSettings(currentDetailTable));
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

boot();
