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
};

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

async function preloadOtherTables() {
  // Sequential on purpose: each table paginates internally, and firing all
  // of them at once can burst past Airtable's per-base rate limit.
  for (const name of TARGET_TABLES) {
    if (name === state.activeTable || recordsCache[name] || tablesInFlight.has(name)) continue;
    const info = state.tables[name];
    if (!info) continue;
    const t0 = Date.now();
    tablesInFlight.add(name);
    try {
      recordsCache[name] = newestFirst(await window.airtable.getRecords(state.baseId, info.id));
      log(`preloadOtherTables: ${name} — ${recordsCache[name].length} records in ${Date.now() - t0}ms`);
    } catch (err) {
      log(`preloadOtherTables: ${name} — FAILED after ${Date.now() - t0}ms — ${err.message}`);
    } finally {
      tablesInFlight.delete(name);
    }
  }
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
  for (const name of TARGET_TABLES) {
    const info = state.tables[name];
    if (!info) continue;
    if (tablesInFlight.has(name)) {
      log(`pollAllTables: ${name} — skipped, a fetch is already in progress elsewhere`);
      continue;
    }
    let fresh;
    const t0 = Date.now();
    tablesInFlight.add(name);
    try {
      fresh = newestFirst(await window.airtable.getRecords(state.baseId, info.id));
      log(`pollAllTables: ${name} — ${fresh.length} records in ${Date.now() - t0}ms`);
    } catch (err) {
      log(`pollAllTables: ${name} — FAILED after ${Date.now() - t0}ms — ${err.message}`);
      continue; // leave cache/seen set untouched; retry next cycle
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

    if (state.activeTable === name) {
      state.records = fresh;
      refreshDES();
      render();
    }
  }
}

function notifyNewTask(rec, tableName) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const shortTable = tableName.replace(' Creatives', '');
  const n = new Notification('New task assigned', {
    body: `${rec.fields['Name'] || 'Untitled task'} (${shortTable})`,
  });
  n.onclick = () => window.focus();
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
  filtered.forEach((rec, i) => {
    const tr = tbody.insertRow();
    if (state.selectedTask && state.selectedTask.id === rec.id) tr.classList.add('selected');
    tr.onclick = () => onRowClick(rec, tr);
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
  document.getElementById('records-container').classList.add('hidden');
  document.getElementById('status-filters').classList.add('hidden');
  document.getElementById('des-control').classList.add('hidden');
  document.getElementById('refresh-btn').classList.add('hidden');
  document.getElementById('dashboard-container').classList.remove('hidden');
  setStatus('Dashboard: Done tasks by designer');
  syncDashboardControls();
  renderDashboard();
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
      if ((r.fields['Status'] || '') !== 'Done') return;
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
    empty.textContent = 'No "Done" tasks found for this period.';
    area.appendChild(empty);
    return;
  }

  const maxTotal = rows[0].total;
  const table = document.createElement('table');
  table.className = 'dash-table';

  const caption = document.createElement('caption');
  caption.textContent = 'Done tasks by designer, across VCP / PLM / CMC / LB';
  table.appendChild(caption);

  const hr = table.createTHead().insertRow();
  ['#', 'Designer', 'Done', ...allTypes].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
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
      td.className = 'dash-type-count';
      td.textContent = row.types[type] || '';
    });
  });

  const totalRow = tbody.insertRow();
  totalRow.className = 'total-row';
  totalRow.insertCell().textContent = '';
  totalRow.insertCell().textContent = 'Total';
  totalRow.insertCell().textContent = rows.reduce((s, r) => s + r.total, 0);
  allTypes.forEach(type => {
    const td = totalRow.insertCell();
    td.className = 'dash-type-count';
    td.textContent = rows.reduce((s, r) => s + (r.types[type] || 0), 0);
  });

  area.appendChild(table);
}

// ── Task selection & rename panel ────────────────────────────────────────

function onRowClick(rec, tr) {
  document.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
  if (state.selectedTask && state.selectedTask.id === rec.id) {
    clearTaskSelection();
    return;
  }
  tr.classList.add('selected');
  state.selectedTask = rec;
  openRenamePanel(rec);
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

async function performRename() {
  const fullTaskName = state.selectedTask ? (state.selectedTask.fields['Name'] || '') : '';
  const taskName = stripAspectRatio(fullTaskName);
  if (!taskName) { alert('No task selected.'); return; }

  const toRename = state.pendingFiles.filter(f => !f.error);
  if (!toRename.length) { alert('No valid files to rename.'); return; }

  const errors = [];
  let renamed = 0;
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
    } catch (err) {
      errors.push(`${f.name}: ${err.message}`);
    }
  }

  if (errors.length) {
    alert(`Renamed ${renamed} file(s).\n\nErrors:\n${errors.join('\n')}`);
  } else {
    alert(`Done! Renamed ${renamed} file(s).`);
    clearTaskSelection();
  }
}

// ── Settings ─────────────────────────────────────────────────────────────

function showSettingsModal(forced = false) {
  document.getElementById('settings-modal').classList.remove('hidden');
  document.getElementById('settings-cancel-btn').style.display = forced ? 'none' : '';
  document.getElementById('api-key-input').value = '';
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
  delete recordsCache[state.activeTable];
  loadTable(state.activeTable);
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
