// renderer/canvas.js
// DOM rendering, pan/zoom, and tab wiring for the Lineage Canvas. Loaded
// after app.js and canvas-data.js, sharing their global scope (no
// bundler in this project — same pattern app.js itself uses). See:
// docs/superpowers/specs/2026-07-09-lineage-canvas-design.md

let canvasZoom = 1;
let canvasPanX = 0;
let canvasPanY = 0;
let canvasIsDragging = false;
let canvasDragStartX = 0;
let canvasDragStartY = 0;

function renderCanvasTransform() {
  const content = document.getElementById('canvas-content');
  content.style.transform = `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasZoom})`;
}

document.getElementById('canvas-viewport').addEventListener('mousedown', e => {
  if (e.target.closest('.canvas-card')) return;
  canvasIsDragging = true;
  canvasDragStartX = e.clientX - canvasPanX;
  canvasDragStartY = e.clientY - canvasPanY;
});
document.addEventListener('mousemove', e => {
  if (!canvasIsDragging) return;
  canvasPanX = e.clientX - canvasDragStartX;
  canvasPanY = e.clientY - canvasDragStartY;
  renderCanvasTransform();
});
document.addEventListener('mouseup', () => { canvasIsDragging = false; });

document.getElementById('canvas-viewport').addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.1 : 0.1;
  canvasZoom = Math.min(2, Math.max(0.3, canvasZoom + delta));
  renderCanvasTransform();
}, { passive: false });

document.getElementById('canvas-zoom-in-btn').addEventListener('click', () => {
  canvasZoom = Math.min(2, canvasZoom + 0.2);
  renderCanvasTransform();
});
document.getElementById('canvas-zoom-out-btn').addEventListener('click', () => {
  canvasZoom = Math.max(0.3, canvasZoom - 0.2);
  renderCanvasTransform();
});

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
    row.onclick = () => openChain(root);
    container.appendChild(row);
  });
}

document.getElementById('canvas-back-btn').addEventListener('click', renderChainList);

// ── Tree rendering ──────────────────────────────────────────────────────

function collectEdges(root) {
  const edges = [];
  (function walk(node) {
    node.children.forEach(child => {
      edges.push({ parent: node, child });
      walk(child);
    });
  })(root);
  return edges;
}

function buildCanvasCard(record, x, y) {
  const card = document.createElement('div');
  card.className = 'canvas-card';
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.title = record.fields['Name'] || '';
  card.onclick = () => openRecordModal(record, state.activeTable);

  const thumb = document.createElement('img');
  thumb.className = 'canvas-card-thumb';
  const previewUrl = record.fields['Preview']?.[0]?.url;
  if (previewUrl) thumb.src = previewUrl;
  card.appendChild(thumb);

  const body = document.createElement('div');
  body.className = 'canvas-card-body';

  const top = document.createElement('div');
  top.className = 'canvas-card-top';
  const typeBadge = document.createElement('span');
  typeBadge.className = 'canvas-card-type';
  typeBadge.textContent = record.fields['Type'] || '';
  top.appendChild(typeBadge);
  const statusVal = record.fields['Status'];
  if (statusVal) {
    const statusPill = document.createElement('span');
    statusPill.className = 'select-pill';
    statusPill.textContent = statusVal;
    const swatch = singleSelectSwatch(state.activeTable, 'Status', statusVal);
    if (swatch) { statusPill.style.background = swatch.bg; statusPill.style.color = swatch.text; }
    top.appendChild(statusPill);
  }
  body.appendChild(top);

  const name = document.createElement('div');
  name.className = 'canvas-card-name';
  name.textContent = record.fields['Name'] || '(untitled)';
  body.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'canvas-card-meta';
  meta.textContent = [record.fields['Model ID'], record.fields['Format']].filter(Boolean).join(' · ');
  body.appendChild(meta);

  const network = document.createElement('div');
  network.className = 'canvas-card-network';
  const nets = record.fields['Network'];
  network.textContent = Array.isArray(nets) ? nets.join(', ') : (nets || '');
  body.appendChild(network);

  card.appendChild(body);
  return card;
}

function renderCanvas(root, highlightRecordId) {
  const positions = layoutChain(root);
  const edges = collectEdges(root);
  const posByNode = new Map(positions.map(p => [p.node, p]));

  const maxX = Math.max(...positions.map(p => p.x)) + CANVAS_CARD_WIDTH;
  const maxY = Math.max(...positions.map(p => p.y)) + CANVAS_CARD_HEIGHT;

  const content = document.getElementById('canvas-content');
  content.style.width = `${maxX}px`;
  content.style.height = `${maxY}px`;

  const cardsLayer = document.getElementById('canvas-cards');
  cardsLayer.innerHTML = '';
  let highlightEl = null;
  positions.forEach(({ node, x, y }) => {
    const card = buildCanvasCard(node.record, x, y);
    if (highlightRecordId && node.record.id === highlightRecordId) {
      card.classList.add('highlight-flash');
      highlightEl = card;
    }
    cardsLayer.appendChild(card);
  });

  const svg = document.getElementById('canvas-edges');
  svg.setAttribute('width', String(maxX));
  svg.setAttribute('height', String(maxY));
  svg.innerHTML = '';
  edges.forEach(({ parent, child }) => {
    const p1 = posByNode.get(parent);
    const p2 = posByNode.get(child);
    const x1 = p1.x + CANVAS_CARD_WIDTH;
    const y1 = p1.y + CANVAS_CARD_HEIGHT / 2;
    const x2 = p2.x;
    const y2 = p2.y + CANVAS_CARD_HEIGHT / 2;
    const midX = (x1 + x2) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', 'canvas-edge');
    const swatch = singleSelectSwatch(state.activeTable, 'Status', child.record.fields['Status']);
    if (swatch) path.setAttribute('stroke', swatch.bg);
    svg.appendChild(path);
  });

  if (highlightEl) {
    highlightEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }
}

function openChain(root, highlightRecordId) {
  document.getElementById('canvas-list-view').classList.add('hidden');
  document.getElementById('canvas-tree-view').classList.remove('hidden');
  document.getElementById('canvas-tree-title').textContent = root.record.fields['Name'] || '(untitled)';
  canvasZoom = 1;
  canvasPanX = 0;
  canvasPanY = 0;
  renderCanvasTransform();
  renderCanvas(root, highlightRecordId);
}
