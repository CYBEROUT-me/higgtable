// renderer/dashboard-data.js
// Pure data-layer logic for the Dashboard's "time spent per designer"
// table: aggregating the Hours field per designer. No DOM access here —
// mirrors the canvas-data.js / notifications-data.js split so this can run
// under plain Jest.

// Normalizes a raw Hours field value into decimal hours, or `undefined` if
// nothing usable was logged. Airtable's Duration field type surfaces as an
// "H:MM" (or "H:MM:SS") string — e.g. '01:00' (1 hour), '00:15' (15 min) —
// not a plain number, so that's parsed here; a plain finite number passes
// through unchanged (defensive, in case a table's Hours is a Number field
// instead). Anything else (blank/undefined/null/unparseable) is undefined.
function parseHoursValue(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const match = raw.match(/^(\d+):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/);
    if (match) {
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      const seconds = match[3] ? Number(match[3]) : 0;
      return hours + minutes / 60 + seconds / 3600;
    }
  }
  return undefined;
}

// `entries` is an array of { des, hours } pairs, one per in-scope record
// (already filtered to the desired Status/period by the caller) — `hours`
// is the raw Airtable field value, normalized via parseHoursValue above.
function computeHoursByDesigner(entries) {
  const byDES = {};
  entries.forEach(({ des, hours }) => {
    if (!byDES[des]) byDES[des] = { sum: 0, count: 0 };
    const parsed = parseHoursValue(hours);
    if (parsed !== undefined) {
      byDES[des].sum += parsed;
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
  module.exports = { computeHoursByDesigner, parseHoursValue };
}
