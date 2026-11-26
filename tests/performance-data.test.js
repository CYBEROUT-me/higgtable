// tests/performance-data.test.js
const {
  dashboardRange, collectPerformance, loadSeries, pickGranularity, performanceKpis,
  designerStats, hoursByType, trendOf, monthlyTrend, pctChange, addMonths, mondayOf,
} = require('../renderer/performance-data');
const { parseHoursValue } = require('../renderer/dashboard-data');

const T = (des, date, hours, type = 'VAR') => ({ des, date, hours, type });

describe('ranges', () => {
  const today = '2026-11-26'; // a Thursday
  test('presets', () => {
    expect(dashboardRange('week', today)).toEqual({ from: '2026-11-23', to: '2026-11-29' });
    expect(dashboardRange('lastWeek', today)).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    expect(dashboardRange('month', today)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(dashboardRange('prevMonth', today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(dashboardRange('quarter', today)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(dashboardRange('prevQuarter', today)).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(dashboardRange('prevQuarter', '2026-02-10')).toEqual({ from: '2025-10-01', to: '2025-12-31' });
    expect(dashboardRange('custom', today, { from: '2026-01-01' })).toEqual({ from: '2026-01-01', to: null });
    expect(dashboardRange('all', today)).toEqual({ from: null, to: null });
  });
  test('mondayOf a Sunday is the Monday before', () => {
    expect(mondayOf('2026-11-29')).toBe('2026-11-23');
    expect(addMonths('2026-01-31', -2)).toBe('2025-11-01');
  });
});

test('collectPerformance keeps handed-in tasks with a Date Done and counts Rework', () => {
  const recs = [
    { fields: { DES: 'Ann', Status: 'Done', 'Date Done': '2026-11-02', Hours: '01:30', Type: 'NEW' } },
    { fields: { DES: 'Ann', Status: 'To accept', 'Date Done': '2026-11-03' } },
    { fields: { DES: 'Ann', Status: 'Done' } },
    { fields: { DES: 'Ann', Status: 'Rework' } },
    { fields: { DES: 'Bo', Status: 'In work', 'Date Done': '2026-11-03' } },
    { fields: { Status: 'Rework' } },
  ];
  const { tasks, reworkByDes } = collectPerformance([recs, null], parseHoursValue);
  expect(tasks).toEqual([
    { des: 'Ann', type: 'NEW', date: '2026-11-02', hours: 1.5 },
    { des: 'Ann', type: '(unspecified)', date: '2026-11-03', hours: undefined },
  ]);
  expect(reworkByDes).toEqual({ Ann: 1, '(unassigned)': 1 });
});

describe('loadSeries', () => {
  const tasks = [T('Ann', '2026-11-02', 1), T('Ann', '2026-11-02', 2), T('Bo', '2026-11-04', 0.5), T('Bo', '2026-12-01', 1)];
  test('days for a month, empty days included', () => {
    const s = loadSeries(tasks, { from: '2026-11-01', to: '2026-11-30' });
    expect(s.granularity).toBe('day');
    expect(s.buckets).toHaveLength(30);
    expect(s.buckets[1]).toEqual({ start: '2026-11-02', end: '2026-11-02', tasks: 2, hours: 3 });
    expect(s.buckets[3].tasks).toBe(1);
  });
  test('one designer, and the range stops at today', () => {
    const s = loadSeries(tasks, { from: '2026-11-01', to: '2026-11-30' }, { des: 'Bo', today: '2026-11-10' });
    expect(s.buckets).toHaveLength(10);
    expect(s.buckets.reduce((n, b) => n + b.tasks, 0)).toBe(1);
  });
  test('weeks for a quarter, months for all time', () => {
    expect(pickGranularity('2026-10-01', '2026-12-31')).toBe('week');
    const w = loadSeries(tasks, { from: '2026-10-01', to: '2026-12-31' });
    expect(w.buckets[0].start).toBe('2026-09-28');
    expect(w.buckets.find(b => b.start === '2026-11-02').tasks).toBe(3);
    const all = loadSeries([...tasks, T('Ann', '2026-01-15', 1)], { from: null, to: null });
    expect(all.granularity).toBe('month');
    expect(all.buckets.map(b => b.tasks)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 1]);
  });
  test('nothing to show', () => {
    expect(loadSeries([], { from: null, to: null }).buckets).toEqual([]);
  });
});

describe('comparisons', () => {
  const now = { from: '2026-11-01', to: '2026-11-30' };
  const tasks = [
    T('Ann', '2026-11-02', 1), T('Ann', '2026-11-03', 3), T('Ann', '2026-11-04', undefined),
    T('Ann', '2026-10-02', 1), T('Ann', '2026-10-03', 1),
    T('Bo', '2026-10-05', 2),
  ];
  test('pctChange', () => {
    expect(pctChange(3, 2)).toBe(50);
    expect(pctChange(3, 0)).toBeNull();
  });
  test('kpis for the period', () => {
    const k = performanceKpis(tasks, now, { Ann: 1 });
    expect(k).toEqual({ tasks: 3, hours: 4, avgHours: 2, designers: 1, rework: 1, reworkShare: 25 });
    expect(performanceKpis([], now, {}).reworkShare).toBeNull();
  });
  test('designerStats, including designers with only Rework', () => {
    const rows = designerStats(tasks, now, { Cy: 2 });
    expect(rows.map(r => [r.des, r.tasks, r.hours, r.avgHours, r.rework])).toEqual([
      ['Ann', 3, 4, 2, 0], ['Cy', 0, 0, null, 2],
    ]);
    expect(rows[1].reworkShare).toBe(100);
  });
  test('hoursByType averages only tasks with Hours', () => {
    const h = hoursByType([...tasks, T('Bo', '2026-11-09', 4, 'NEW')], now);
    expect(h.types).toEqual(['NEW', 'VAR']);
    expect(h.rows.map(r => r.des)).toEqual(['Ann', 'Bo']);
    expect(h.rows[0].cells).toEqual({ NEW: null, VAR: { avg: 2, n: 2 } });
    expect(h.total.NEW).toEqual({ avg: 4, n: 1 });
    expect(h.all).toEqual({ avg: 8 / 3, n: 3 });
  });
});

describe('trend', () => {
  test('trendOf', () => {
    expect(trendOf([10, 10, 10]).direction).toBe('flat');
    expect(trendOf([5, 10, 15]).direction).toBe('up');
    expect(trendOf([15, 10, 5]).pct).toBeCloseTo(-50);
    expect(trendOf([0, 0]).direction).toBe('none');
  });
  test('monthlyTrend: six full months plus the current one apart', () => {
    const tasks = [
      T('Ann', '2026-05-10', 1), T('Ann', '2026-10-01', 2), T('Ann', '2026-10-02', 1), T('Ann', '2026-11-20', 1),
      T('Bo', '2026-04-30', 1), T('Bo', '2026-08-01', 1),
    ];
    const m = monthlyTrend(tasks, '2026-11-26');
    expect(m.months).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(m.current).toBe('2026-11');
    expect(m.rows[0]).toMatchObject({ des: 'Ann', counts: [1, 0, 0, 0, 0, 2], current: 1, total: 3 });
    expect(m.rows[0].hours[5]).toBe(3);
    expect(m.rows[1]).toMatchObject({ des: 'Bo', counts: [0, 0, 0, 1, 0, 0], total: 1 });
    expect(m.team.counts).toEqual([1, 0, 0, 1, 0, 2]);
    expect(m.team.current).toBe(1);
    expect(m.rows[0]).toMatchObject({ last3: 2, prev3: 1, change3: 100 });
    expect(m.rows[1]).toMatchObject({ last3: 1, prev3: 0, change3: null });
  });
});
