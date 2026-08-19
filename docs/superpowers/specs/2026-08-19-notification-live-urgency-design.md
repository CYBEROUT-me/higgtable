# Live urgency resolution for notification badges

## Problem

The notification dropdown shows Priority/Deadline badges from a **snapshot**
captured at notification-creation time (`recordToNotification`,
`renderer/notifications-data.js`). Three problems follow from that:

1. **Stale badges.** The 50-item history spans weeks. A task whose priority
   or deadline changed in Airtable after the notification was created still
   shows the old value — a badge reading "Due tomorrow" because that was
   true two weeks ago is actively misleading.
2. **Permanently bare rows.** Notifications created before the snapshot
   fields existed (verified present in this install's `localStorage`: entries
   from 2026-08-03/04, created before the feature shipped 2026-08-04 14:51)
   have no `priority`/`deadline` and can never gain badges.
3. **Drift toward a wall of red.** Every unfinished task eventually passes
   its deadline, so over time most history rows would render `overdue` — red
   stripe plus red label — including tasks that were long since completed.
   A signal that fires on everything is no signal.

The live record is already in memory: `renderNotificationDropdown` looks it
up from `recordsCache` in its click handler today.

## Goals

- Badges reflect the task's **current** Priority/Deadline whenever the live
  record is available, falling back to the stored snapshot when it isn't.
- Urgency signalling (red left stripe + deadline label) is suppressed for
  tasks that are already finished — Status `Done` or `To accept`.
- Only genuinely urgent deadlines render a label at all; non-urgent ones
  render nothing.
- No change to what's captured/persisted — the snapshot stays exactly as-is
  and remains the fallback.

## Non-goals

- No change to `notifyNewTask` (the OS-native banner).
- Completed-task notifications are **not** hidden from the list and **not**
  auto-marked read — only their urgency signalling is neutralized. History
  stays browsable and clickable.
- No CSS changes. The existing `.notify-item.urgent` / `.notify-deadline`
  rules already cover every state that can render.
- No new "Due in N days" relative formatting — non-urgent deadlines render
  nothing at all (see Design).

## Design

### Resolution rule

One rule governs the whole feature:

> **Live record found** → use its `Priority`/`Deadline`, and suppress
> urgency if its `Status` is `Done` or `To accept`.
> **Live record absent** → use the stored snapshot, urgency included.

Two deliberate choices inside that rule:

**Record-level fallback, not field-level.** If the record is found but its
Priority was *cleared* in Airtable, the badge disappears — it does not fall
back to the snapshot value. Snapshot means "I couldn't ask," never "I didn't
like the answer." Field-level fallback would create a badge that outlives
its data with no way to clear it from the UI, and could pin a red urgent
stripe on a task that is no longer urgent.

**Absent record fails toward showing urgency.** The absent case splits into
a rare permanent one (record deleted from Airtable — clicking it already
reports "This task is no longer available") and a common transient one (the
table hasn't finished preloading; `init()` loads the active table first and
preloads the other three after). Hiding urgency whenever the record is
missing would mean opening the bell right after launch shows a
falsely-calm list during exactly the window the user is most likely to
check it. Suppressing a real alert is a worse failure than briefly showing
a stale one.

### Pure function (`renderer/notifications-data.js`)

```javascript
const COMPLETED_STATUSES = ['Done', 'To accept'];

function resolveNotificationBadges(n, rec, today) { ... }
```

Returns `{ priority, deadline, urgency, isUrgent }`:
- `priority` — string or `null`.
- `deadline` — string or `null`.
- `urgency` — the existing `computeDeadlineUrgency` result
  (`null`/`'overdue'`/`'today'`/`'tomorrow'`/`'normal'`), forced to `null`
  when the task is completed.
- `isUrgent` — `true` when not completed and (`priority === 'High'` or
  `urgency === 'overdue'`). Drives the red left stripe.

`today` is passed in rather than read from the clock, consistent with
`computeDeadlineUrgency` and `recordToNotification`.

### Rendering (`renderNotificationDropdown`, `renderer/app.js`)

Per notification: look up `rec` from `recordsCache[n.tableName]` (the same
lookup its click handler already performs), call
`resolveNotificationBadges(n, rec, today)`, then:
- add `urgent` to the button's class when `isUrgent`;
- render the Priority pill when `priority` is set — **all** levels, not just
  High. Unlike a date, the pill is already encoded by color from the
  Airtable choice palette, so a red High pill jumps out while a green Low
  pill recedes; and showing only High would collapse "Medium", "Low", and
  "unset" into one indistinguishable blank;
- render the deadline label **only** when `urgency` is `'overdue'`,
  `'today'`, or `'tomorrow'`. A `'normal'` (or `null`) urgency renders no
  label. The label therefore becomes purely an urgency signal: a colored
  label means "act now", its absence means "you're fine". The accepted
  trade-off is that absence now conflates "no deadline set" with "deadline
  is far off" — both mean not-urgent, which is all this list needs to say.

## Testing

`resolveNotificationBadges` is pure — Jest coverage in
`tests/notifications-data.test.js`: live record overrides a stale snapshot;
a cleared live Priority yields `null` rather than the snapshot value;
`Done` and `To accept` each suppress `urgency`/`isUrgent` even for an
overdue High-priority task; an absent record falls back to the snapshot
*with* urgency computed; `priority === 'High'` alone sets `isUrgent` without
an overdue deadline. The render wiring in `renderNotificationDropdown` is
manual-verification-only, consistent with the rest of this DOM layer.
