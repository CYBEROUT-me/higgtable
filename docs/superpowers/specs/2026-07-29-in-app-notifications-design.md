# In-app notifications with sound

## Problem

HiggTable already notifies the user of newly-assigned tasks via the OS-native
`Notification` API (`notifyNewTask` in `renderer/app.js`), driven by a 5-minute
poll cycle (`pollOneTable`). Two gaps:

1. **No sound, no persistent record.** OS notification banners are easy to
   miss or dismiss without reading, and once gone there's no way to review
   what you missed.
2. **Nothing assigned while the app was closed is ever surfaced.** `seenTaskIds`
   is seeded from the freshly-loaded records on every launch
   (`snapshotSeenIds()`, called once during `init()`), so anything assigned
   between sessions is marked "seen" immediately and never triggers a
   notification.

## Goals

- Add an in-app bell icon + dropdown notification list, alongside (not
  replacing) the existing OS notification.
- Play a sound when a new notification arrives.
- On cold open, catch up on anything assigned while the app was closed —
  no matter how long it's been — by persisting "seen" state across restarts.
- Let the user mute the sound without losing the visual notification.

## Non-goals

- Changing the underlying "new task" detection logic (still gated on
  `state.selectedDES` matching, same as today — no DES selected means no
  notifications, same as the current OS-notification behavior).
- Changing the 5-minute poll interval or polling architecture.
- Notification preferences beyond a single mute toggle (no per-table mute,
  no snooze, etc.).

## Design

### 1. Persisted seen-ID state

Today, `seenTaskIds` (in `renderer/app.js`) is an in-memory-only
`{ [tableName]: Set<recordId> }`, populated once via `snapshotSeenIds()` after
initial load, then updated each poll cycle in `pollOneTable`.

Change: persist this set to `localStorage` under
`higgtable_seen_ids_v1` as `{ [tableName]: string[] }`, written every time
`seenTaskIds[name]` changes (both at startup catch-up and each poll cycle —
cheap, small dataset, synchronous write).

At `init()`, before the first `snapshotSeenIds()` call:

- Read `higgtable_seen_ids_v1` from `localStorage`.
- **First-ever run** (key absent): seed `seenTaskIds` from the current
  `recordsCache` as today (via `snapshotSeenIds()`), persist it, and do *not*
  generate catch-up notifications — there's no prior baseline to diff
  against, and treating a fresh install as "hundreds of missed tasks" would
  be spam, not signal.
- **Subsequent runs** (key present): for each target table, diff the
  persisted ID set against the freshly-loaded `recordsCache[name]`, filtered
  by `state.selectedDES` the same way `pollOneTable` already does. Any record
  present now but absent from the persisted set is a "missed while closed"
  notification. After computing the diff, overwrite the persisted set with
  the current full ID set (same as `snapshotSeenIds()` does for the in-memory
  copy).

This reuses the exact same filter condition already in `pollOneTable`
(`!prevSeen.has(r.id) && (r.fields['DES'] || '') === state.selectedDES`), just
sourced from persisted storage instead of the in-memory set, and run once at
startup instead of every 5 minutes.

### 2. Notification list (persisted)

New `localStorage` key `higgtable_notifications_v1`: an array of

```js
{ id, recordId, tableName, taskName, timestamp, read }
```

capped at the 50 most recent (oldest dropped past that). A new
`addNotification(rec, tableName)` helper appends one entry (unread) and
persists the trimmed list; a `addNotificationBatch(entries)` variant does the
same for the cold-open catch-up case, in one write.

Both the live poll path (`pollOneTable`, where `notifyNewTask` is already
called per new record) and the cold-open catch-up path call this helper, so
the dropdown accumulates history across both sources without duplicating the
detection logic.

### 3. UI: bell icon + dropdown

A new bell button in `<header>` (`renderer/index.html`), next to the existing
`#refresh-btn` / `#settings-btn` icons, showing an unread-count badge (hidden
at 0). Clicking toggles a dropdown (styled consistently with the existing
record modal / chain-list dropdowns) listing notifications newest-first:
task name, table (shortened the same way `notifyNewTask` does — "Creatives"
suffix stripped), and a relative timestamp ("5m ago").

Clicking a notification row calls the existing `goToRecord(rec, tableName)` —
same navigation the OS notification's `onclick` already uses — and closes the
dropdown. Since notifications are stored by `recordId`/`tableName` rather
than a live record reference, the click handler looks the record up from
`recordsCache[tableName]` at click time (it may have changed since the
notification fired); if it's no longer found (deleted since), show a brief
inline "task no longer available" message in place of navigating.

Opening the dropdown marks every currently-stored notification as read
(`read: true`, persisted) and clears the badge. Read notifications stay
visible in the list (visually de-emphasized) until they age out past the
50-item cap.

### 4. Sound

A `playNotificationSound()` helper using the Web Audio API — a short
synthesized two-tone chime (e.g. two quick oscillator tones), not a bundled
audio file. This avoids sourcing/licensing an asset and keeps it fully
self-contained.

- Live notifications: one sound per new record, called from the same site as
  today's `notifyNewTask` (so an existing user sitting in the app hears it
  once per new task, matching the current one-OS-banner-per-task behavior).
- Cold-open catch-up: exactly one sound after the whole batch is computed and
  added, regardless of how many missed tasks were found — avoids a burst of
  chimes on startup.

A speaker-icon toggle next to the bell mutes/unmutes, persisted in
`localStorage` (`higgtable_notify_muted`, default unmuted/`false`). Muting
only suppresses `playNotificationSound()` — the bell badge, dropdown list,
and existing OS notification (and whatever sound the OS attaches to it) are
unaffected.

## Data flow summary

```
init()
  ├─ load persisted seen-ID set + notification list from localStorage
  ├─ (existing) load active table, preload other tables
  ├─ if persisted seen-ID set existed: diff vs recordsCache per table
  │    → addNotificationBatch(missed) → playNotificationSound() once (if any)
  ├─ persist fresh full seen-ID set
  ├─ (existing) startPolling(), requestNotificationPermission()

pollOneTable(name)  [every 5 min, existing]
  ├─ (existing) diff prevSeen vs fresh, filtered by selectedDES
  ├─ (existing) notifyNewTask(rec, name)  — OS notification
  ├─ (new) addNotification(rec, name) → playNotificationSound()
  ├─ (existing) seenTaskIds[name] = new Set(...)
  ├─ (new) persist seenTaskIds[name] to localStorage
```

## Testing

- Unit tests (Jest, alongside existing `tests/canvas-data.test.js` style) for
  the pure logic: seen-ID diffing against a persisted set, notification-list
  capping at 50, batch vs. single-sound triggering logic. DOM/Web Audio
  interaction is exercised manually (Electron GUI, per project convention),
  not unit tested.
- Manual pass: assign a task while the app is closed, reopen, confirm one
  catch-up notification + one sound; assign a task while open, confirm live
  notification + sound; mute, confirm badge/list still update but silently;
  click a notification, confirm navigation matches OS-notification behavior;
  click a notification for a since-deleted record, confirm the inline fallback
  message.
