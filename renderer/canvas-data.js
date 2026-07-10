// renderer/canvas-data.js
// Pure data logic for the Lineage Canvas — no DOM references anywhere in
// this file, so it can be required directly by Jest as well as loaded via
// <script> in the renderer. See:
// docs/superpowers/specs/2026-07-09-lineage-canvas-design.md

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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isChainRoot, buildChains };
}
