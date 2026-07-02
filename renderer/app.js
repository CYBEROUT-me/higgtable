const TARGET_BASE = 'UT Marketing Team';
const TARGET_TABLES = ['VCP Creatives', 'PLM Creatives', 'CMC Creatives', 'LB Creatives'];
const DEFAULT_STATUSES = ['In Work', 'Ready to Design'];
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
};

const recordsCache = {};
const seenTaskIds = {};
const POLL_INTERVAL_MS = 5 * 60 * 1000;
let pollTimer = null;

// ── Boot ────────────────────────────────────────────────────────────────

async function boot() {
  const hasKey = await window.app.hasApiKey();
  if (!hasKey) {
    showSettingsModal(true);
    return;
  }
  await init();
}

async function init() {
  setStatus('Connecting...');
  try {
    const bases = await window.airtable.getBases();
    const base = bases.find(b => b.name === TARGET_BASE);
    if (!base) throw new Error(`Base "${TARGET_BASE}" not found`);
    state.baseId = base.id;

    const tables = await window.airtable.getTables(state.baseId);
    TARGET_TABLES.forEach(name => {
      const t = tables.find(t => t.name === name);
      if (t) state.tables[name] = { id: t.id, fields: t.fields };
    });

    const firstTable = state.tables[TARGET_TABLES[0]];
    if (firstTable) {
      const sf = firstTable.fields.find(f => f.name === 'Status');
      if (sf && sf.options && sf.options.choices) {
        state.statusOptions = sf.options.choices.map(c => c.name);
      }
    }

    renderStatusChips();
    await loadTable(state.activeTable);
    await preloadOtherTables();
    snapshotSeenIds();
    startPolling();
    requestNotificationPermission();
  } catch (err) {
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
    return;
  }

  document.getElementById('records-container').innerHTML = '<p class="empty">Loading...</p>';
  setStatus(`Loading ${tableName}...`);

  try {
    const records = await window.airtable.getRecords(state.baseId, tableInfo.id);
    // Guard: user may have switched tabs while this fetch was in flight
    if (state.activeTable !== tableName) {
      recordsCache[tableName] = records;
      return;
    }
    recordsCache[tableName] = records;
    state.records = records;
    refreshDES();
    render();
  } catch (err) {
    if (state.activeTable !== tableName) return;
    document.getElementById('records-container').innerHTML = `<p class="empty error">${err.message}</p>`;
    setStatus(`Error: ${err.message}`, true);
  }
}

async function preloadOtherTables() {
  // Sequential on purpose: each table paginates internally, and firing all
  // of them at once can burst past Airtable's per-base rate limit.
  for (const name of TARGET_TABLES) {
    if (name === state.activeTable || recordsCache[name]) continue;
    const info = state.tables[name];
    if (!info) continue;
    try { recordsCache[name] = await window.airtable.getRecords(state.baseId, info.id); }
    catch {}
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
  if (!state.baseId || pollInFlight) return;
  pollInFlight = true;
  try {
    await pollAllTables();
  } finally {
    pollInFlight = false;
  }
}

async function pollAllTables() {
  for (const name of TARGET_TABLES) {
    const info = state.tables[name];
    if (!info) continue;
    let fresh;
    try {
      fresh = await window.airtable.getRecords(state.baseId, info.id);
    } catch {
      continue; // leave cache/seen set untouched; retry next cycle
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
  loadTable(btn.dataset.table);
});

document.getElementById('des-select').addEventListener('change', e => {
  state.selectedDES = e.target.value;
  state.selectedDES ? localStorage.setItem('higgtable_des', state.selectedDES)
                     : localStorage.removeItem('higgtable_des');
  render();
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

boot();
