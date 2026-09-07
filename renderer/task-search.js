// renderer/task-search.js
// Pure ranking for the header task search. No DOM, no IO — runs under Jest.

// Airtable stores long text with markdown-escaped punctuation, and a name typed
// or pasted from a Description can arrive as "OL\_10838". Both the query and the
// candidate names are normalised the same way so the escaping never affects a
// match.
function normalizeForSearch(text) {
  return String(text || '')
    .replace(/\\([\\_*[\]()~`>#+\-=|{}.!])/g, '$1')
    .trim()
    .toLowerCase();
}

// Names are mostly "CODE_1234_..." so a plain text sort puts CMC_1000 before
// CMC_999. Numeric-aware comparison is what people mean by "sorted by name".
function compareTaskNames(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
}

const MIN_QUERY_LENGTH = 2;

// Ranked matches for `query` over `records` ({ id, name, table }).
// Rank order: exact name, then starts-with, then contains — so typing a full
// name puts that task first even when dozens of variants share its prefix.
function searchTasks(query, records, { limit = 20 } = {}) {
  const q = normalizeForSearch(query);
  if (q.length < MIN_QUERY_LENGTH) return [];

  const scored = [];
  for (const rec of records || []) {
    const name = String((rec && rec.name) || '');
    if (!name) continue;
    const hay = normalizeForSearch(name);
    let rank;
    if (hay === q) rank = 0;
    else if (hay.startsWith(q)) rank = 1;
    else if (hay.includes(q)) rank = 2;
    else continue;
    scored.push({ rank, rec });
  }

  scored.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : compareTaskNames(a.rec.name, b.rec.name)));
  return scored.slice(0, limit).map(s => s.rec);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MIN_QUERY_LENGTH, normalizeForSearch, compareTaskNames, searchTasks };
}
