// renderer/records-sync.js
// Pure helpers for the on-disk record cache and incremental refresh. No DOM, no
// IO. The app shows the cached records at startup and then asks Airtable only
// for records modified since the last sync, instead of re-downloading every
// table (VCP alone took ~30 s).

const RECORDS_CACHE_VERSION = 1;
// Airtable's LAST_MODIFIED_TIME and this machine's clock can disagree a little;
// asking for a little more than needed is free, missing a change is not.
const SYNC_OVERLAP_MS = 2 * 60 * 1000;
// Incremental syncs cannot see deleted records, so a full download still runs
// this often (and whenever the user presses refresh).
const FULL_SYNC_EVERY_MS = 6 * 60 * 60 * 1000;

// Applies changed records to the cached list, newest-first like the rest of the
// app. Existing records are updated IN PLACE (rec.fields replaced), so objects
// other code holds (the selected task, an open task window) stay current.
// `changed` is in Airtable's order (oldest first). Returns the same array,
// mutated, plus the records that were new.
function mergeChangedRecords(records, changed) {
  const byId = new Map(records.map(r => [r.id, r]));
  const added = [];
  (changed || []).forEach(c => {
    const existing = byId.get(c.id);
    if (existing) existing.fields = c.fields;
    else { added.push(c); byId.set(c.id, c); }
  });
  if (added.length) records.unshift(...added.slice().reverse());
  return { records, added };
}

// ISO time to ask "modified after" from, or null when a full download is due.
function incrementalSince(meta, now) {
  if (!meta || !meta.syncedAt || !meta.fullSyncedAt) return null;
  if (now - meta.fullSyncedAt > FULL_SYNC_EVERY_MS) return null;
  return new Date(meta.syncedAt - SYNC_OVERLAP_MS).toISOString();
}

// A cache file is usable only if it was written by this format for this table.
function usableCache(payload, tableId) {
  return !!payload && payload.v === RECORDS_CACHE_VERSION && payload.tableId === tableId
    && Array.isArray(payload.records) && payload.syncedAt > 0 && payload.fullSyncedAt > 0;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RECORDS_CACHE_VERSION, SYNC_OVERLAP_MS, FULL_SYNC_EVERY_MS,
    mergeChangedRecords, incrementalSince, usableCache,
  };
}
