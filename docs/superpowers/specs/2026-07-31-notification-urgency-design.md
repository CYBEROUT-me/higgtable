# Priority/deadline urgency indicators in the notification dropdown

## Problem

The notifications dropdown (`renderNotificationDropdown()`,
`renderer/app.js:531-560`) shows only a timestamp, task name, and table tag
per notification — no indication of how urgent the underlying task is. A
user has to open each task to find out whether it's high-priority or
overdue.

The notification data model doesn't carry this today:
`recordToNotification()` (`renderer/notifications-data.js:13-22`) only
captures `Name`, not `Priority` or `Deadline`, and notifications are
persisted to `localStorage` and rendered later purely from that stored
data (never re-fetched live) — so this has to be captured at
notification-creation time, not computed at render time from fresh
Airtable data.

## Goals

- Each notification shows its task's Priority as a colored pill, using the
  exact same colors already used for Priority in the main records table
  (via the existing `singleSelectSwatch` helper) — not a separate,
  invented color scheme.
- Each notification shows its Deadline, colored by urgency: red if
  overdue, orange if due today or tomorrow, muted/default otherwise.
- A notification whose task is overdue **or** Priority is High gets a red
  left-border highlight on the whole row, so urgency is visible without
  reading any text.
- Both live-poll and cold-start-catch-up notification creation paths pick
  this up automatically, since both already funnel through the same
  `recordToNotification()`.

## Non-goals

- No change to the OS-native notification banner (`notifyNewTask()`,
  `renderer/app.js:474-481`) — it builds its own body string independently
  and is out of scope here.
- No retroactive backfill for already-persisted notifications — one saved
  before this change simply has no `priority`/`deadline`, and its badges
  don't render (graceful omission, not an error state).
- No general-purpose date-formatting utility — the "normal" (not
  overdue/today/tomorrow) case displays the raw stored `Deadline` string
  as-is, matching how Deadline is handled everywhere else in the codebase
  today (no existing formatter to reuse or extend).

## Design

### Data model (`renderer/notifications-data.js`)

`recordToNotification(rec, tableName, now)` gains two fields:
`priority: rec.fields['Priority'] || null` and
`deadline: rec.fields['Deadline'] || null` (Airtable's raw `YYYY-MM-DD`
string, same representation already used for sorting/reading it
elsewhere).

New pure function, `computeDeadlineUrgency(deadline, today)` — both
plain `YYYY-MM-DD` strings (`today` passed in, not read via `new Date()`
internally, matching how `recordToNotification` already takes `now` as a
parameter for determinism/testability). Returns:
- `null` if `deadline` is falsy.
- `'overdue'` if `deadline < today`.
- `'today'` if `deadline === today`.
- `'tomorrow'` if `deadline` is exactly one day after `today`.
- `'normal'` otherwise.

### Rendering (`renderNotificationDropdown()`, `renderer/app.js`)

For each notification `n`:
- Compute `urgency = computeDeadlineUrgency(n.deadline, toISO(new Date()))`
  (`toISO` already exists at `renderer/app.js:161`).
- `isUrgentRow = n.priority === 'High' || urgency === 'overdue'` — the
  single binary trigger for the row-level highlight (a `'today'`/
  `'tomorrow'` deadline alone does not trigger it, only its own badge
  color).
- If `n.priority` is truthy: append a pill reusing the existing
  `.select-pill` class (`renderer/styles.css:80`) with its color from
  `singleSelectSwatch(n.tableName, 'Priority', n.priority)` — identical
  mechanism to how the main table already colors Priority pills
  (`renderer/app.js:706-712`), so it stays in sync with whatever colors
  are configured in Airtable, no hardcoded color list.
- If `n.deadline` is truthy: append a `.notify-deadline` span. Text is
  `'Overdue'` / `'Due today'` / `'Due tomorrow'` for those three urgency
  values, or the raw `n.deadline` string for `'normal'`. An additional
  class (`overdue` / `today` / `tomorrow`) is added for the urgency
  levels that need color; `'normal'` gets no extra class (default muted
  color).
- `btn.className` gains `' urgent'` when `isUrgentRow` is true.

### Styling (`renderer/styles.css`)

```css
.notify-item.urgent { border-left: 3px solid #f66; }
.notify-deadline { font-size: 10px; margin-left: var(--space-2); color: var(--text-muted); }
.notify-deadline.overdue { color: #f66; font-weight: 600; }
.notify-deadline.today, .notify-deadline.tomorrow { color: #fa0; font-weight: 600; }
```

`#f66`/`#fa0` match the colors already used elsewhere in the app for
error/warning states (`.ferror`, `.ftype.unknown`) — no new color
introduced. The Priority pill needs no new CSS at all, since it reuses
`.select-pill` exactly as-is.

## Testing

`computeDeadlineUrgency` is a pure function — full Jest coverage in
`tests/notifications-data.test.js`: overdue, exactly today, exactly
tomorrow, a date further out (`'normal'`), and no deadline (`null`).
`recordToNotification`'s existing tests get two new assertions
(`priority`/`deadline` present when the source record has them, `null`
when it doesn't). The DOM-rendering side (pill/badge/row-highlight
wiring in `renderNotificationDropdown`) is manual-verification-only,
consistent with how this layer has been verified throughout the session.
