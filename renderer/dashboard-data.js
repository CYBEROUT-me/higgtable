// renderer/dashboard-data.js
// Pure data-layer logic for the Dashboard's "time spent per designer"
// table: aggregating the Hours field per designer. No DOM access here —
// mirrors the canvas-data.js / notifications-data.js split so this can run
// under plain Jest.

// `entries` is an array of { des, hours } pairs, one per in-scope record
// (already filtered to the desired Status/period by the caller) — `hours`
// may be undefined/null/non-numeric when a record has no logged value.
function computeHoursByDesigner(entries) {
  const byDES = {};
  entries.forEach(({ des, hours }) => {
    if (!byDES[des]) byDES[des] = { sum: 0, count: 0 };
    if (typeof hours === 'number' && Number.isFinite(hours)) {
      byDES[des].sum += hours;
      byDES[des].count++;
    }
  });

  const rows = Object.entries(byDES)
    .map(([des, { sum, count }]) => ({
      des,
      totalHours: sum,
      avgHours: count ? sum / count : null,
    }))
    .sort((a, b) => b.totalHours - a.totalHours);

  const grandSum = rows.reduce((s, r) => s + r.totalHours, 0);
  const grandCount = Object.values(byDES).reduce((s, d) => s + d.count, 0);

  return {
    rows,
    totalHours: grandSum,
    avgHours: grandCount ? grandSum / grandCount : null,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeHoursByDesigner };
}
