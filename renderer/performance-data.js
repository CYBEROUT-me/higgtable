// renderer/performance-data.js
// Pure numbers for the Dashboard's detailed view: period ranges, tasks handed
// in per day / week / month, per-designer stats, hours per task by Type,
// Rework share and a six-month trend per designer (with the last three months
// against the three before). No DOM access, so it runs under plain Jest.
//
// Dates are ISO "YYYY-MM-DD" strings throughout (Airtable's Date Done), and the
// arithmetic is done in UTC so no time zone shifts a day.

const HANDED_IN = ['Done', 'To accept'];
const TREND_MONTHS = 6;
const TREND_FLAT_PCT = 5; // within ±5 % a month counts as flat

function isoToUTC(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function utcToISO(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function addDays(iso, n) {
  return utcToISO(isoToUTC(iso) + n * 86400000);
}
function daysBetween(from, to) {
  return Math.round((isoToUTC(to) - isoToUTC(from)) / 86400000);
}
function monthStart(iso) {
  return `${iso.slice(0, 7)}-01`;
}
// First day of the month `n` months after the month of `iso`.
function addMonths(iso, n) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1 + n;
  return utcToISO(Date.UTC(y + Math.floor(m / 12), ((m % 12) + 12) % 12, 1));
}
function monthEnd(iso) {
  return addDays(addMonths(iso, 1), -1);
}
function mondayOf(iso) {
  const day = new Date(isoToUTC(iso)).getUTCDay(); // 0 = Sunday
  return addDays(iso, day === 0 ? -6 : 1 - day);
}
function quarterStart(iso) {
  const m = Number(iso.slice(5, 7)) - 1;
  return `${iso.slice(0, 4)}-${String(m - (m % 3) + 1).padStart(2, '0')}-01`;
}

// The Dashboard's period presets. `today` is ISO; `custom` = { from, to }.
// Returns { from, to } (ISO or null = open).
function dashboardRange(preset, today, custom = {}) {
  switch (preset) {
    case 'week': { const from = mondayOf(today); return { from, to: addDays(from, 6) }; }
    case 'lastWeek': { const from = addDays(mondayOf(today), -7); return { from, to: addDays(from, 6) }; }
    case 'month': return { from: monthStart(today), to: monthEnd(today) };
    case 'prevMonth': { const from = addMonths(today, -1); return { from, to: monthEnd(from) }; }
    case 'quarter': { const from = quarterStart(today); return { from, to: addDays(addMonths(from, 3), -1) }; }
    case 'prevQuarter': { const from = addMonths(quarterStart(today), -3); return { from, to: addDays(addMonths(from, 3), -1) }; }
    case 'custom': return { from: custom.from || null, to: custom.to || null };
    case 'all':
    default: return { from: null, to: null };
  }
}

function inRange(date, range) {
  if (!date) return false;
  if (!range) return true;
  return (!range.from || date >= range.from) && (!range.to || date <= range.to);
}

// From every table's records: the tasks handed in (Done / To accept with a
// Date Done), and how many tasks each designer has in Rework right now.
// `parseHours` turns the Hours field into decimal hours (undefined if empty).
function collectPerformance(recordLists, parseHours) {
  const tasks = [];
  const reworkByDes = {};
  recordLists.forEach(list => (list || []).forEach(r => {
    const f = r.fields || {};
    const des = f['DES'] || '(unassigned)';
    const status = f['Status'] || '';
    if (status === 'Rework') { reworkByDes[des] = (reworkByDes[des] || 0) + 1; return; }
    if (!HANDED_IN.includes(status) || !f['Date Done']) return;
    tasks.push({
      des,
      type: f['Type'] || '(unspecified)',
      date: String(f['Date Done']).slice(0, 10),
      hours: parseHours(f['Hours']),
    });
  }));
  return { tasks, reworkByDes };
}

function sumTaskHours(list) {
  return list.reduce((s, t) => s + (t.hours || 0), 0);
}
function avgTaskHours(list) {
  const withHours = list.filter(t => t.hours !== undefined);
  return withHours.length ? sumTaskHours(withHours) / withHours.length : null;
}
// Percent change, or null when there is nothing to compare with.
function pctChange(now, before) {
  if (!before) return null;
  return ((now - before) / before) * 100;
}

// Day buckets up to a month, weeks up to half a year, months beyond.
function pickGranularity(from, to) {
  const days = daysBetween(from, to) + 1;
  if (days <= 31) return 'day';
  if (days <= 183) return 'week';
  return 'month';
}

function bucketStart(date, granularity) {
  if (granularity === 'week') return mondayOf(date);
  if (granularity === 'month') return monthStart(date);
  return date;
}
function nextBucket(start, granularity) {
  if (granularity === 'week') return addDays(start, 7);
  if (granularity === 'month') return addMonths(start, 1);
  return addDays(start, 1);
}

// Tasks and hours per bucket across the range, empty buckets included, for
// the load chart. An open range spans the tasks' own first and last day (and
// at most `today`). `des` narrows it to one designer.
function loadSeries(tasks, range, { des = '', today } = {}) {
  const list = tasks.filter(t => (!des || t.des === des) && inRange(t.date, range));
  let from = range && range.from;
  let to = range && range.to;
  if (!from || !to) {
    const dates = list.map(t => t.date).sort();
    if (!dates.length) return { granularity: 'day', buckets: [] };
    from = from || dates[0];
    to = to || dates[dates.length - 1];
  }
  if (today && to > today) to = today < from ? from : today;
  const granularity = pickGranularity(from, to);
  const buckets = [];
  const index = new Map();
  for (let start = bucketStart(from, granularity); start <= to; start = nextBucket(start, granularity)) {
    const b = { start, end: addDays(nextBucket(start, granularity), -1), tasks: 0, hours: 0 };
    index.set(start, b);
    buckets.push(b);
  }
  list.forEach(t => {
    const b = index.get(bucketStart(t.date, granularity));
    if (!b) return;
    b.tasks++;
    b.hours += t.hours || 0;
  });
  return { granularity, buckets };
}

// Headline numbers for the period.
function performanceKpis(tasks, range, reworkByDes) {
  const now = tasks.filter(t => inRange(t.date, range));
  const rework = Object.values(reworkByDes || {}).reduce((s, n) => s + n, 0);
  return {
    tasks: now.length,
    hours: sumTaskHours(now),
    avgHours: avgTaskHours(now),
    designers: new Set(now.map(t => t.des)).size,
    rework,
    reworkShare: reworkShareOf(rework, now.length),
  };
}

// Rework now as a share of (Rework now + handed in during the period).
function reworkShareOf(rework, handedIn) {
  return rework + handedIn ? (rework / (rework + handedIn)) * 100 : null;
}

// Each designer in the period: tasks, hours, average hours per task, and
// Rework now. Sorted by tasks, most first.
function designerStats(tasks, range, reworkByDes = {}) {
  const now = tasks.filter(t => inRange(t.date, range));
  const names = new Set(now.map(t => t.des).concat(Object.keys(reworkByDes)));
  return [...names].map(des => {
    const mine = now.filter(t => t.des === des);
    const rework = reworkByDes[des] || 0;
    return {
      des,
      tasks: mine.length,
      hours: sumTaskHours(mine),
      avgHours: avgTaskHours(mine),
      rework,
      reworkShare: reworkShareOf(rework, mine.length),
    };
  }).sort((a, b) => b.tasks - a.tasks || b.rework - a.rework || a.des.localeCompare(b.des));
}

// Average hours per task by Type, per designer and for the team. Only tasks
// with Hours count toward an average; `n` is how many did.
function hoursByType(tasks, range) {
  const list = tasks.filter(t => inRange(t.date, range) && t.hours !== undefined);
  const types = [...new Set(list.map(t => t.type))].sort();
  const cell = subset => (subset.length ? { avg: sumTaskHours(subset) / subset.length, n: subset.length } : null);
  const designers = [...new Set(list.map(t => t.des))];
  const rows = designers.map(des => {
    const mine = list.filter(t => t.des === des);
    const cells = {};
    types.forEach(type => { cells[type] = cell(mine.filter(t => t.type === type)); });
    return { des, cells, all: cell(mine) };
  }).sort((a, b) => b.all.n - a.all.n);
  const total = {};
  types.forEach(type => { total[type] = cell(list.filter(t => t.type === type)); });
  return { types, rows, total, all: cell(list) };
}

// Slope of a least-squares line through the values, as % of their mean per
// step, and what it says: 'up', 'down' or 'flat'.
function trendOf(values) {
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / (n || 1);
  if (n < 2 || !mean) return { pct: null, direction: mean ? 'flat' : 'none' };
  const xMean = (n - 1) / 2;
  let num = 0;
  let den = 0;
  values.forEach((v, i) => { num += (i - xMean) * (v - mean); den += (i - xMean) ** 2; });
  const pct = ((num / den) / mean) * 100;
  return { pct, direction: pct > TREND_FLAT_PCT ? 'up' : pct < -TREND_FLAT_PCT ? 'down' : 'flat' };
}

// The last three full months against the three before them (of six).
function lastThree(counts) {
  const sum = list => list.reduce((s, v) => s + v, 0);
  const last3 = sum(counts.slice(-3));
  const prev3 = sum(counts.slice(-6, -3));
  return { last3, prev3, change3: pctChange(last3, prev3) };
}

// Tasks per designer for the last `months` full months (the current month is
// shown apart: it is not over yet), with the trend over the full months.
function monthlyTrend(tasks, today, months = TREND_MONTHS) {
  const current = monthStart(today);
  const keys = [];
  for (let i = months; i >= 1; i--) keys.push(addMonths(current, -i).slice(0, 7));
  const curKey = current.slice(0, 7);
  const byDes = {};
  tasks.forEach(t => {
    const key = t.date.slice(0, 7);
    const col = keys.indexOf(key);
    if (col < 0 && key !== curKey) return;
    if (!byDes[t.des]) byDes[t.des] = { counts: keys.map(() => 0), hours: keys.map(() => 0), current: 0, currentHours: 0 };
    const row = byDes[t.des];
    if (col < 0) { row.current++; row.currentHours += t.hours || 0; return; }
    row.counts[col]++;
    row.hours[col] += t.hours || 0;
  });
  const rows = Object.entries(byDes).map(([des, r]) => ({
    des, ...r, total: r.counts.reduce((s, v) => s + v, 0), trend: trendOf(r.counts), ...lastThree(r.counts),
  })).sort((a, b) => b.total - a.total || b.current - a.current);
  const teamCounts = keys.map((_, i) => rows.reduce((s, r) => s + r.counts[i], 0));
  return {
    months: keys,
    current: curKey,
    rows,
    team: {
      counts: teamCounts, current: rows.reduce((s, r) => s + r.current, 0), trend: trendOf(teamCounts), ...lastThree(teamCounts),
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    dashboardRange, collectPerformance, loadSeries, pickGranularity, performanceKpis,
    designerStats, hoursByType, trendOf, monthlyTrend, pctChange, addMonths, mondayOf,
  };
}
