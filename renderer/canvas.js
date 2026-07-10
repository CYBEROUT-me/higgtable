// renderer/canvas.js
// DOM rendering, pan/zoom, and tab wiring for the Lineage Canvas. Loaded
// after app.js and canvas-data.js, sharing their global scope (no
// bundler in this project — same pattern app.js itself uses). See:
// docs/superpowers/specs/2026-07-09-lineage-canvas-design.md

function showCanvasTab() {
  clearTaskSelection();
  state.selectedIds.clear();
  updateBulkActionsBar();
  document.getElementById('records-container').classList.add('hidden');
  document.getElementById('status-filters').classList.add('hidden');
  document.getElementById('des-control').classList.add('hidden');
  document.getElementById('multiselect-hint').classList.add('hidden');
  document.getElementById('columns-btn').classList.add('hidden');
  document.getElementById('refresh-btn').classList.add('hidden');
  document.getElementById('canvas-container').classList.remove('hidden');
  setStatus('Canvas: lineage view');
  renderChainList();
}

function hideCanvasTab() {
  document.getElementById('canvas-container').classList.add('hidden');
  document.getElementById('records-container').classList.remove('hidden');
  document.getElementById('status-filters').classList.remove('hidden');
  document.getElementById('des-control').classList.remove('hidden');
  document.getElementById('multiselect-hint').classList.remove('hidden');
  document.getElementById('columns-btn').classList.remove('hidden');
  document.getElementById('refresh-btn').classList.remove('hidden');
}

function countChainNodes(node) {
  return 1 + node.children.reduce((sum, child) => sum + countChainNodes(child), 0);
}

// Renders the browsable list of every lineage in the active table,
// biggest first. Rendering (Task 4) fills in what clicking a row does.
function renderChainList() {
  document.getElementById('canvas-tree-view').classList.add('hidden');
  document.getElementById('canvas-list-view').classList.remove('hidden');

  const container = document.getElementById('canvas-chain-list');
  container.innerHTML = '';

  const chains = buildChains(state.records)
    .map(root => ({ root, size: countChainNodes(root) }))
    .sort((a, b) => b.size - a.size);

  if (!chains.length) {
    container.innerHTML = '<p class="empty">No records to build lineages from.</p>';
    return;
  }

  chains.forEach(({ root, size }) => {
    const row = document.createElement('div');
    row.className = 'canvas-chain-row';
    const name = document.createElement('span');
    name.className = 'canvas-chain-name';
    name.textContent = root.record.fields['Name'] || '(untitled)';
    const count = document.createElement('span');
    count.className = 'canvas-chain-count';
    count.textContent = size === 1 ? '1 creative' : `${size} creatives`;
    row.appendChild(name);
    row.appendChild(count);
    container.appendChild(row);
  });
}

document.getElementById('canvas-back-btn').addEventListener('click', renderChainList);
