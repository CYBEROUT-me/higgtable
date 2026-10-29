// renderer/workload-data.js
// Pure counting for the manager's Workload view: open tasks per designer, and
// how many of those are High priority. No DOM access here, same split as
// dashboard-data.js, so it runs under plain Jest.

// "Open" = assigned and not yet handed in. Backlog and Rework are left out on
// purpose: Backlog is not assigned work yet, and Rework is not part of the
// manager's ask (add it here if that changes).
const WORKLOAD_STATUSES = ['Ready for Design', 'In work'];
const WORKLOAD_UNASSIGNED = '(unassigned)';

// `sources` is [{ tableName, records }]. `table` (a table name) and `product`
// (a Project value, e.g. "OL") narrow the count; null/'' means "all".
function computeWorkload(sources, { table = null, product = '' } = {}) {
  const byDES = {};
  sources.forEach(({ tableName, records }) => {
    if (table && tableName !== table) return;
    (records || []).forEach(r => {
      const status = r.fields['Status'] || '';
      if (!WORKLOAD_STATUSES.includes(status)) return;
      if (product && (r.fields['Project'] || '') !== product) return;
      const des = r.fields['DES'] || WORKLOAD_UNASSIGNED;
      if (!byDES[des]) {
        byDES[des] = { des, open: 0, high: 0, statuses: Object.fromEntries(WORKLOAD_STATUSES.map(s => [s, 0])) };
      }
      byDES[des].open++;
      byDES[des].statuses[status]++;
      if (r.fields['Priority'] === 'High') byDES[des].high++;
    });
  });

  // Busiest first; ties by name. Unassigned work sorts last whatever its size,
  // since it is nobody's load yet.
  const rows = Object.values(byDES).sort((a, b) => {
    if ((a.des === WORKLOAD_UNASSIGNED) !== (b.des === WORKLOAD_UNASSIGNED)) {
      return a.des === WORKLOAD_UNASSIGNED ? 1 : -1;
    }
    return b.open - a.open || a.des.localeCompare(b.des);
  });
  const totals = {
    open: rows.reduce((s, r) => s + r.open, 0),
    high: rows.reduce((s, r) => s + r.high, 0),
    statuses: Object.fromEntries(WORKLOAD_STATUSES.map(s => [s, rows.reduce((n, r) => n + r.statuses[s], 0)])),
  };
  return { rows, totals };
}

// Every Project value in the given tables (all of them when `table` is null),
// sorted, for the product filter.
function listWorkloadProducts(sources, table = null) {
  const out = new Set();
  sources.forEach(({ tableName, records }) => {
    if (table && tableName !== table) return;
    (records || []).forEach(r => { if (r.fields['Project']) out.add(r.fields['Project']); });
  });
  return [...out].sort();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WORKLOAD_STATUSES, WORKLOAD_UNASSIGNED, computeWorkload, listWorkloadProducts };
}
