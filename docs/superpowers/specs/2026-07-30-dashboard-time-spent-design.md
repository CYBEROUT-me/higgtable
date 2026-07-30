# Dashboard: time spent per designer

## Problem

The Dashboard tab (`renderer/index.html:92-109`, rendered by `renderDashboard()`
in `renderer/app.js:875-949`) shows one table today: "Done + To accept tasks
by designer, across VCP / PLM / CMC / LB", grouping the same filtered record
set by `DES` and counting tasks (with a per-`Type` breakdown). There's no
visibility into how much time designers are actually spending — only how
many creatives they finished.

Each record already carries an `Hours` field (referenced once, decoratively,
at `renderer/app.js:1022`) that designers manually log with the hours spent
on that specific creative. Nothing today aggregates it.

## Goals

- Add a second table directly below the existing one, showing per-designer
  **total hours logged** and **average hours per creative**, over the exact
  same filtered record set (Status = Done/To accept, respecting the current
  period preset / custom date range already selected on the Dashboard).
- Match the existing table's visual style (`.dash-table`, bar visualization,
  bold total row) so the Dashboard reads as one consistent system.
- Handle designers with no logged `Hours` on any of their records without
  showing a misleading `0` average.

## Non-goals

- No new Airtable fields, no changes to how `Hours` is entered (still
  manual, still edited via the existing record-field editor).
- No retroactive time-tracking from Status-change history — confirmed there
  is none available (Status has no timestamp; `Date Done` is completion-date
  only). This feature is a pure aggregation of the existing `Hours` field.
- No per-`Type` breakdown of hours, no min/max outlier row — just total and
  average per designer, per the approved scope.
- No changes to the existing task-count table or the period/date controls
  that already exist above both tables.

## Design

### Data (`renderer/app.js`)

Extend `computeDashboardStats()` (`renderer/app.js:843-873`) rather than
writing a second, separately-filtered pass — it already loops every
Done/To-accept record within the selected period. Alongside the existing
`byDES[des] = { total, types }` accumulation, add hours tracking to the same
per-designer entry:

```javascript
if (!byDES[des]) byDES[des] = { total: 0, types: {}, hoursSum: 0, hoursCount: 0 };
byDES[des].total++;
byDES[des].types[type] = (byDES[des].types[type] || 0) + 1;
const hours = r.fields['Hours'];
if (typeof hours === 'number' && Number.isFinite(hours)) {
  byDES[des].hoursSum += hours;
  byDES[des].hoursCount++;
}
```

Derive a second, independently-sorted array (the existing `rows` stays
sorted by task `total`; this one sorts by `totalHours` descending, per the
approved design):

```javascript
const hoursRows = Object.entries(byDES)
  .map(([des, data]) => ({
    des,
    totalHours: data.hoursSum,
    avgHours: data.hoursCount ? data.hoursSum / data.hoursCount : null,
  }))
  .sort((a, b) => b.totalHours - a.totalHours);
```

`avgHours: null` is the "no logged Hours at all" case — a designer with
Done/To-accept tasks but zero of them carrying an `Hours` value. `totalHours`
naturally computes to `0` in that case (an empty sum), which is correct and
distinct from "average is undefined."

`computeDashboardStats()` returns `hoursRows` alongside the existing `rows`,
`allTypes`, `notLoaded`, `from`, `to`.

### Rendering (`renderDashboard()`, `renderer/app.js:875-949`)

After the existing table is appended to `#dashboard-table-area`, append a
second `<table class="dash-table">` built the same way: a `<caption>`
reading "Time spent per designer (same filter as above)", a header row `#,
Designer, Total Hours, Avg Hours / Creative`, one row per entry in
`hoursRows` (skipped entirely if `hoursRows` is empty — reuses the same
"No … tasks found for this period" empty state already handled once, since
`hoursRows` is empty exactly when `rows` is), and a bold total row.

Each data row reuses the existing bar-visualization pattern
(`dash-bar-cell`/`dash-bar-track`/`dash-bar-fill`/`dash-bar-label`, the same
classes the task-count table already uses) for the Total Hours column, scaled
against the max `totalHours` in the list — visually consistent with the
table above it, and no new CSS needed. `Avg Hours / Creative` is a plain
numeric cell (no bar), matching how the first table's per-`Type` columns are
plain numeric. Both numeric displays round to 1 decimal place
(`totalHours.toFixed(1)`); a `null` average renders as `'–'` (the same
dash-for-empty convention the existing per-`Type` cells already use for a
zero count).

The total row sums `totalHours` across all designers for its Total Hours
cell, and computes the overall average as
`(sum of all hoursSum) / (sum of all hoursCount)` — not an average of the
per-designer averages — shown as `'–'` if no records anywhere have a logged
`Hours` value.

## Testing

Manual only, consistent with how the existing Dashboard table is verified
(no existing test file covers `computeDashboardStats()`/`renderDashboard()`).
Verify: designers with mixed logged/blank Hours compute the average from
only the logged ones; a designer with zero logged Hours shows `–` not `0`;
changing the period preset/date range updates both tables together (they
share the same underlying filtered record set); the grand-total row's
average is the true weighted average, not an average-of-averages.
