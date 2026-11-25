// renderer/pack-data.js
// Groups the table's rows into "packs": tasks made from the same parent on the
// same day (e.g. one creative localised into PT, CZ, GR, HU…, or a batch of
// VARs). No DOM access here, so it runs under plain Jest.

// Parent and day of a task. The parent is "Old ID"; when that field is empty it
// comes from the name, whose third segment is the parent id
// (APP_<New ID>_<Old ID>_…). A NEW task is its own parent, so it lands in the
// same pack as the VARs made from it that day. null = cannot tell.
function packKey(rec) {
  const f = rec.fields || {};
  let parent = f['Old ID'];
  if (parent == null || parent === '') {
    const m = /^[A-Za-z]+_\d+_(\d+)_/.exec(f['Name'] || '');
    parent = m ? m[1] : null;
  }
  if (parent == null) return null;
  return `${parent}|${f['Date'] || ''}`;
}

// For rows in display order, which pack each one is part of: consecutive rows
// with the same key form a pack. Returns one { size, index } per row (index =
// position within its pack). Rows with no key are packs of one.
function packLayout(records) {
  const keys = records.map(packKey);
  const out = new Array(records.length);
  let start = 0;
  for (let i = 1; i <= records.length; i++) {
    if (i < records.length && keys[i] !== null && keys[i] === keys[start]) continue;
    for (let j = start; j < i; j++) out[j] = { size: i - start, index: j - start };
    start = i;
  }
  return out;
}

// What a pack header says, from its tasks' names and fields: the parent id,
// the concept (the name segment before the ratio), the languages in it and
// the day. Name layout: APP_<New>_<Old>_<Model>_<Script>_<LANG>_…_<Concept>_<ratio>.
function packSummary(records) {
  const first = (records[0] && records[0].fields) || {};
  const parts = String(first['Name'] || '').split('_');
  const concept = parts.length > 2 ? parts[parts.length - 2] : '';
  const languages = [];
  records.forEach(r => {
    const lang = String((r.fields || {})['Name'] || '').split('_')[5] || '';
    if (/^[A-Z]{2}$/.test(lang) && !languages.includes(lang)) languages.push(lang);
  });
  const key = packKey(records[0] || { fields: {} });
  return {
    parent: key ? key.split('|')[0] : '',
    concept: /^[A-Za-z]/.test(concept) ? concept : '',
    languages,
    date: first['Date'] || '',
    count: records.length,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { packKey, packLayout, packSummary };
}
