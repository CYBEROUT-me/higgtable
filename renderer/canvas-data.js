// renderer/canvas-data.js
// Pure data logic for the Lineage Canvas — no DOM references anywhere in
// this file, so it can be required directly by Jest as well as loaded via
// <script> in the renderer. See:
// docs/superpowers/specs/2026-07-09-lineage-canvas-design.md

const CANVAS_CARD_WIDTH = 220;
const CANVAS_CARD_HEIGHT = 110;
const CANVAS_COL_GAP = 80;
const CANVAS_ROW_GAP = 24;

// A record is a chain root when compared purely by Old ID/New ID values —
// the Type field is never consulted (a Type=NEW record can still have a
// real parent). `byNewId` maps every record's New ID (as a string) to
// that record, used to detect a dangling Old ID (points at nothing).
function isChainRoot(record, byNewId) {
  const newId = record.fields['New ID'];
  const oldId = record.fields['Old ID'];
  if (newId == null || newId === '') return true;
  if (oldId == null || oldId === '') return true;
  if (String(oldId) === String(newId)) return true;
  if (!byNewId.has(String(oldId))) return true;
  return false;
}

// Groups `records` into root -> descendants trees using the Old ID / New ID
// linking convention. Returns an array of tree roots, each shaped
// { record, children: [ ...same shape... ] }.
function buildChains(records) {
  const byNewId = new Map();
  records.forEach(r => {
    const newId = r.fields['New ID'];
    if (newId != null && newId !== '') byNewId.set(String(newId), r);
  });

  const childrenByOldId = new Map();
  records.forEach(r => {
    const oldId = r.fields['Old ID'];
    if (oldId == null || oldId === '') return;
    const key = String(oldId);
    if (!childrenByOldId.has(key)) childrenByOldId.set(key, []);
    childrenByOldId.get(key).push(r);
  });

  function keyOf(record) {
    const newId = record.fields['New ID'];
    return newId == null || newId === '' ? null : String(newId);
  }

  // `path` is the set of New IDs from the root down to (and including) the
  // current node — used to drop a child whose own New ID already appears
  // as one of its own ancestors, so malformed cyclic data can't recurse
  // forever.
  function buildNode(record, path) {
    const key = keyOf(record);
    const nextPath = key == null ? path : new Set(path).add(key);
    const kids = key == null ? [] : (childrenByOldId.get(key) || []);
    const children = kids
      .filter(child => child.id !== record.id)
      .filter(child => {
        const childKey = keyOf(child);
        return childKey == null || !nextPath.has(childKey);
      })
      .map(child => buildNode(child, nextPath));
    return { record, children };
  }

  return records
    .filter(r => isChainRoot(r, byNewId))
    .map(root => buildNode(root, new Set()));
}

// Assigns {x, y} (top-left, px) to every node in a tree returned by
// buildChains() — left-to-right by generation (x), siblings stacked
// top-to-bottom (y), parent vertically centered on its children's span.
// Pure function: computed from the tree's shape alone, no DOM involved.
function layoutChain(root) {
  const positions = [];

  function subtreeHeight(node) {
    if (!node.children.length) return CANVAS_CARD_HEIGHT;
    const total = node.children.reduce((sum, child) => sum + subtreeHeight(child), 0);
    return total + CANVAS_ROW_GAP * (node.children.length - 1);
  }

  // Returns the vertical center (px) of the node it just placed, so the
  // caller (its parent) can average its children's centers.
  function place(node, depth, top) {
    const x = depth * (CANVAS_CARD_WIDTH + CANVAS_COL_GAP);

    if (!node.children.length) {
      positions.push({ node, x, y: top });
      return top + CANVAS_CARD_HEIGHT / 2;
    }

    let childTop = top;
    const childCenters = node.children.map(child => {
      const center = place(child, depth + 1, childTop);
      childTop += subtreeHeight(child) + CANVAS_ROW_GAP;
      return center;
    });

    const y = (childCenters[0] + childCenters[childCenters.length - 1]) / 2 - CANVAS_CARD_HEIGHT / 2;
    positions.push({ node, x, y });
    return y + CANVAS_CARD_HEIGHT / 2;
  }

  place(root, 0, 0);
  return positions;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isChainRoot, buildChains, layoutChain,
    CANVAS_CARD_WIDTH, CANVAS_CARD_HEIGHT, CANVAS_COL_GAP, CANVAS_ROW_GAP,
  };
}
