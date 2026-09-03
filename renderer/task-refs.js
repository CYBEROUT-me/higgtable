// renderer/task-refs.js
// Pure logic for the "jump to the referenced task's link" button: finding task
// references inside a Description, matching them to records, and deciding which
// link field a match should open. No DOM, no IO — runs under plain Jest.

// Field that holds the deliverable link, chosen by the record's Format.
// "Stat" creatives are delivered as a Figma/Canvas board; everything else
// (Video) is delivered as a Drive folder.
const CREATIVE_LINK_FIELD = 'Creative Link';
const FIGMA_LINK_FIELD = 'Figma/Canvas link';

// A reference is an app code, an underscore, a number, and optionally more
// underscore-joined segments — so it matches both the shorthand "PL_6940" and a
// full "PL_6940_6940_М689_S0_EN_usr_KRU_PRI_Video_NEW_9x16".
//
// Segments deliberately allow ANY non-space, non-punctuation character: real
// task names contain Cyrillic letters (the "М689" above is a Cyrillic М, not a
// Latin M), so restricting to [A-Za-z0-9] would silently truncate them.
const TASK_REF_PATTERN = /[A-Za-z]{2,4}_\d+(?:_[^\s,;:()[\]{}"'<>]+)*/g;

function extractTaskRefs(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TASK_REF_PATTERN)) {
    // Trailing dots and dashes come from prose ("see PL_6940."), not the name.
    const ref = m[0].replace(/[.,;:\-–—]+$/, '');
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

// A reference matches a record when it IS the full name, or when it is a
// complete leading SEGMENT prefix of it. Requiring the underscore boundary is
// what stops "PL_694" from matching "PL_6940_...".
function matchRefToRecords(ref, records) {
  const r = String(ref || '');
  if (!r) return [];
  return (records || []).filter(rec => {
    const name = String((rec && rec.name) || '');
    return name === r || name.startsWith(`${r}_`);
  });
}

// Which link a match should open. Format is authoritative; the name suffix is
// only consulted when Format is empty, since names embed it too.
function linkFieldForRecord(rec) {
  const format = String((rec && rec.format) || '').trim().toLowerCase();
  if (format) return format === 'stat' ? FIGMA_LINK_FIELD : CREATIVE_LINK_FIELD;
  const name = String((rec && rec.name) || '');
  return /_Stat_/i.test(name) ? FIGMA_LINK_FIELD : CREATIVE_LINK_FIELD;
}

// Resolves a wanted field name against the table's ACTUAL schema, so a table
// that spells it differently ("Figma/Canvas Link") still works instead of
// silently writing nothing. Exact match wins, then case-insensitive, then a
// field containing every word of the wanted name.
function resolveFieldName(fieldNames, wanted) {
  const names = (fieldNames || []).filter(n => typeof n === 'string');
  const w = String(wanted || '');
  if (!w) return null;
  if (names.includes(w)) return w;
  const lower = w.toLowerCase();
  const ci = names.find(n => n.toLowerCase() === lower);
  if (ci) return ci;
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const loose = names.find(n => {
    const nl = n.toLowerCase();
    return words.every(word => nl.includes(word));
  });
  return loose || null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CREATIVE_LINK_FIELD, FIGMA_LINK_FIELD, TASK_REF_PATTERN,
    extractTaskRefs, matchRefToRecords, linkFieldForRecord, resolveFieldName,
  };
}
