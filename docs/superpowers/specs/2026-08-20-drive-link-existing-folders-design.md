# Link Existing Drive Folders to Tasks — Design

**Date:** 2026-08-20
**Status:** Approved

## Problem

Automated Drive delivery works but is slow. After removing redundant navigations a
small task still costs ~8s, of which only ~5s is transfer. Two probes run against
the live Drive on 2026-08-20 proved that batching — the obvious remaining
speed-up — is impossible:

* **Chooser with an array of paths.** The folder chooser reports
  `mode: "selectSingle"`, and that is a hard limit. `DOM.setFileInputFiles`
  returned success for two directory paths, then Chromium used only the first;
  Drive reported "1 of 1" and exactly one folder landed. Success from
  `setFileInputFiles` says nothing about how many paths were honoured.
* **CDP drag and drop.** `Input.dispatchDragEvent` accepted `dragEnter`,
  `dragOver` and `drop` carrying `DragData.files = [dirPath, dirPath]` without
  error, and Drive ingested nothing — no progress dialog, no folders. Dropping
  directories this way does not produce the directory entries Drive's drop
  handler reads, so a hand-made drag works where a synthesized one cannot.

Both findings are recorded in `drive-probes.js` so they are not rebuilt.

One Folder-upload action per task is therefore the floor. But the user already
drags many folders into Drive in a single gesture, which is fast and reliable.
Their actual pain is what follows: locating each uploaded folder and pasting its
link into the Airtable `Creative Link` field, task by task.

## Goal

The user uploads folders to Drive by hand. HiggTable then finds each selected
task's folder by exact name and writes the folder URL into `Creative Link`.

Uploading stays in the codebase but is hidden from the UI.

## Non-goals

* Replacing or modifying the upload machinery. It stays, working, behind
  commented-out buttons.
* Creating anything in Drive. This flow is strictly read-only.
* Fuzzy or near-miss name matching.

## User-visible behaviour

A single new bulk action, **Link from Drive**, in `#bulk-actions-bar`. It shows a
confirmation listing every selected task and what will happen to it, then runs and
reports a summary.

The two upload buttons — `#bulk-drive-upload-btn` in the bulk bar and
`#drive-upload-btn` in the task panel — are commented out in
`renderer/index.html` with a note explaining why. All upload code, IPC handlers,
probes and tests are left in place; uncommenting the two elements restores the
feature.

## Flow

1. Take selected records that have a `Name`.
2. Resolve each task's app folder: `appCodeFromTaskName` → `buildFolderMap`
   (which folds in mirrors) → `resolveAppFolderId`. A task whose app code has no
   configured folder is **skipped and reported**, never guessed at.
3. A task whose `Creative Link` is already non-empty is **skipped and reported**,
   before Drive is touched. An already-delivered task is never silently
   repointed.
4. In test mode every lookup targets `driveTestFolderId` and no Airtable write
   happens.
5. Group the remaining tasks by destination folder id, so each folder is read
   once regardless of how many tasks target it.
6. For each destination:
   a. Read the destination's own listing once. This is unavoidable: we know the
      month folder's *name* but need its *id* to open it, and that mapping only
      exists in the parent listing. It also yields the full set of month folders
      for the widen step.
   b. Find the current month folder (`monthFolderName(today)`) in that listing.
      If it is absent, that is not an error — every task for this destination
      goes straight to the widen step.
   c. Read the month folder's listing and match task names exactly.
   d. Any task still unmatched triggers the widen step: read the destination's
      other month folders, newest first, stopping as soon as every task is
      matched or the folders run out.

   So the common case costs **two** listing reads per destination — the app
   folder and the current month — regardless of how many tasks target it.
7. Derive each URL as `https://drive.google.com/drive/folders/<id>`. No
   navigation is needed to obtain it.
8. Write every found link in one batched `window.airtable.updateRecords` call,
   unless test mode is on.
9. Report: linked / skipped / not found / duplicate.

## Matching policy

Matching is **exact**, on the Drive folder name against the Airtable task name.

* **No match** → reported as not found, with the month folders searched named so
  the user can see where it looked. Nothing is written.
* **Two or more folders with the same name in one listing** → that task fails and
  is reported. The run does not pick one.

This enforces the project's standing rule that an unverified link is never
written to Airtable. The feature is worthless — worse than manual work — if a
link can land on the wrong task.

## Amendment: the year level (2026-08-20, after implementation)

The real delivery layout has a **year** between the app folder and the month:

```
<App>_creatives / 2026 / 08_August / <task folder>
```

The scratch folder used for testing is flat (`<Test GD> / 08_August / <task>`),
which is why the discrepancy was not visible during testing. Rather than assume
either shape, the traversal classifies what is actually under the destination:
a four-digit name is a year to descend into, an `MM_` prefix is a month to search
directly, anything else is ignored. Flat months are searched first (the scratch
layout, where no year folders exist), then year folders — current year first,
then newest-first — each searched month-by-month in the order below.

`searched` entries are path labels (`2026/08_August`, or just `08_August` for a
flat month), so a not-found message names where it actually looked.

**Known gap:** the hidden upload path (`uploadFolderToDrive`) still resolves
`<app>/<month>` with no year level. It is correct for the flat scratch folder and
wrong for a real app folder. It must be made year-aware before those buttons are
uncommented.

## Month search order

The widen step reads month folders newest-first. Names are `MM_Month`
(`08_August`), so a descending lexicographic sort on the name puts recent months
first within a year. This is a cost heuristic only; correctness does not depend
on the order, since the search continues until every task is matched or all
folders are exhausted.

## Components

### `renderer/drive-link.js` (new, pure, Jest-tested)

No DOM and no Electron. Loaded by a `<script>` tag before `app.js`, with the
usual `module.exports` footer.

* `planLinkRun({ records, folderMap, testFolderId, testMode })` → `{ plans, skipped }`.
  `plans` are `{ recordId, taskName, destFolderId }`; `skipped` are
  `{ taskName, reason }` covering unconfigured app codes and existing links.
* `matchTasksToFolders(taskNames, items)` → `{ matched, duplicates, unmatched }`.
  `matched` maps task name to folder id; `items` is the listing shape
  `{ id, name, isFolder }` already returned by `listFolderItems`.
* `monthSearchOrder(items, currentMonthName)` → ordered `{ id, name }` entries
  for the folders in a destination's listing: the current month first, then the
  rest newest-first. Ids are carried through because opening a month folder
  needs the id, not the name.

### `drive-browser.js` (one new read-only function)

`findFoldersByNames({ appFolderId, monthName, taskNames })` →
`{ matched, duplicates, unmatched, searched }`.

Reuses `openFolderForWork` and `readListingHere`. Contains no call to
`createFolder`. Honours the existing asymmetric listing rules: a non-empty
listing is accepted once two consecutive reads agree, an empty one only after the
patience window.

### `main.js` / `preload.js`

One IPC handler, `drive-find-folders`, exposed as
`window.app.driveFindFolders(payload)`, following the existing handlers' shape
including the `{ error }` return on failure.

### `renderer/app.js`

`linkSelectedFromDrive()`, mirroring `uploadSelectedToDrive()`'s structure:
resolve a plan, confirm it, run it, summarise it.

## Error handling

* **Expired Google session** — `openFolderForWork` already detects a redirect off
  `drive.google.com` and reports it; the run stops with that message rather than
  reporting every task as not found.
* **Destination folder unreachable** — reported once for that destination; its
  tasks are marked failed, other destinations still run.
* **Airtable write failure** — reported as a failure for the affected tasks. The
  summary never claims a link was written when it was not.
* **Nothing found at all** — a normal summary showing every task as not found,
  not an exception.

## Testing

`renderer/drive-link.js` is covered by `tests/drive-link.test.js`: exact match,
duplicate detection, unmatched reporting, unconfigured app codes, existing-link
skips, test-mode redirection, and month ordering.

The Drive-reading half needs the user's authenticated Google session and cannot
be verified by an agent. It is verified by the user running the feature in test
mode against their scratch folder.

## Risk

The feature depends on Drive folder names matching Airtable task names exactly.
The user's names are machine-generated and should hold, but a hand-renamed folder
is reported as not found rather than linked. That is the intended failure
direction.
