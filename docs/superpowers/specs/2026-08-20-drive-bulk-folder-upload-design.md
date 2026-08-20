# Bulk Drive delivery via Folder upload

## Problem

Single-task delivery works (`deliver()` in `drive-browser.js`): it find-or-creates
`Creatives/<App>_creatives/<MM_Month>/<taskName>/`, uploads the selected files,
verifies them, and writes the Drive folder link to Airtable's `Creative Link`.

Two gaps:

1. **No bulk path.** Delivering a batch means repeating the whole flow by hand,
   one task at a time.
2. **The task-folder creation step is the fragile part.** Open the New menu →
   click "New folder" → clear the pre-filled "Untitled folder" → type the name →
   click Create → read the id back with retries. Most failures during
   development were in exactly that sequence.

The local layout already mirrors the destination: `For GD/<TASK_NAME>/<files>`,
one correctly-named, ready-to-ship folder per task. Drive's **Folder upload**
can create the folder and its contents in a single action, removing the
create-folder machinery entirely.

## Verified facts (diagnostic runs, 2026-08-19/20)

Nothing below is assumed; each came from `driveDiagnose` against the live account.

- Folder upload's chooser **is** interceptable: `Page.fileChooserOpened` fires
  with `mode: "selectSingle"` and a `backendNodeId`.
- `DOM.setFileInputFiles` **accepts a directory path** (`setFilesAccepted: true`),
  and Drive uploads the folder with its full contents.
- `mode` is `selectSingle`, not `selectMultiple` — **one folder per action**, so
  bulk is N sequential uploads, not one batched call.
- **No confirmation dialog.** Upload starts immediately; only a progress dialog
  appears: `"Uploading 1 item 26 min left... Cancel"` with a `"2 of 99"` counter.
- Upload is **recursive and unfiltered**: subfolders (`DE`, `ES`, nested folders)
  and `.DS_Store` all go up. The test folder was 99 files, ~26 minutes.

## Goals

- Deliver several selected tasks in one run, each into its own Drive folder,
  writing a verified `Creative Link` per task.
- Remove the New-folder dialog from the task-folder step by using Folder upload.
- Strip `.DS_Store` before uploading, so client folders don't receive Finder junk.
- Survive long uploads (tens of minutes per task) without false timeouts.
- Each task succeeds or fails independently.

## Non-goals

- **The single-task path is not changed.** It works in production; switching it
  to folder upload would destabilise it for no user-visible gain, and it keeps
  per-file selection, which folder upload cannot offer.
- No filtering within a folder upload — subfolders and every non-`.DS_Store`
  file ship. `.DS_Store` is the single documented exception.
- No batching of multiple folders into one action; `selectSingle` forbids it.
- Autofill is not modified. Bulk delivery sits beside it, not inside it.
- No retry of a failed task within a run; report it and move on.

## Design

### Entry point

A **"Upload to Drive"** button in the bulk actions bar, beside Autofill,
operating on `state.selectedIds`.

Deliberately *not* folded into the Autofill approval modal, despite the original
request. Autofill matches Preview/Timing files and completes in seconds; delivery
is a multi-minute-per-task network operation with unrelated failure modes.
Combining them means neither can fail cleanly. They sit adjacent, run separately.

### Locating each task's local folder

Search `state.workingDirectory` for a directory whose name equals the task's
`Name` exactly (the same convention `performRename()` already produces, and the
one the `For GD/` layout follows). A new main-process helper,
`find-task-folder`, walks the working directory and returns the path or `null`.

Exact match only. A task with no matching folder is **reported and skipped** —
never guessed at, never delivered to a similarly-named folder.

### Per-task sequence

Tasks run **sequentially** — one shared BrowserWindow, and `selectSingle`
prevents batching. For each task:

1. **Strip `.DS_Store`** recursively from the local task folder. Scope is
   deliberately narrow: only files named exactly `.DS_Store`, only inside that
   folder, each deletion logged. This is the one place the feature writes to
   disk, and it exists only because Folder upload cannot filter.
2. **Resolve the destination** — app code (including mirrors) → app folder;
   abort this task if unconfigured. Find-or-create the **month** folder. The
   task folder is *not* created; Folder upload makes it.
3. **Upload** — New → "Folder upload" → intercepted chooser →
   `DOM.setFileInputFiles` with the folder path.
4. **Wait for completion** by watching the progress dialog's `"X of Y"` counter.
5. **Read back** the new folder by name in the month folder, take its id and URL.
6. **Write `Creative Link`** — only after read-back confirms the folder exists.

### Long-running uploads

The existing 5-minute watchdog and 90-second verification poll are both too
short — a single 99-file folder took ~26 minutes — and would report false
failures.

Both become **progress-based**: while the `"X of Y"` counter advances, keep
waiting. Only a stall — no counter movement for several minutes — is a failure.
An absolute ceiling still exists per task so a wedged run cannot hang forever.

### Failure handling

Each task is committed independently. A failure in task 3 does not roll back or
block tasks 1, 2, 4–7. Per task the outcome is binary: a verified `Creative Link`,
or nothing written at all.

The run ends with a summary listing each task as delivered, skipped (no local
folder / unconfigured app code), or failed with its reason. With a run possibly
lasting an hour, discarding successful deliveries because a later one failed
would be the wrong trade.

### Existing behaviour reused unchanged

Test mode (redirects to the test folder, skips the Airtable write) applies to
bulk, so a whole run can be rehearsed safely. The single-operation concurrency
guard, `[drive]` step logging, mirror resolution, and the duplicate-folder abort
all continue to apply.

## Testing

Pure and Jest-testable: task→folder matching rules, and the run-summary
classification (delivered / skipped / failed).

The browser automation cannot be tested by the author — it needs the user's
authenticated session. It is verified by a bulk run in **test mode** against the
scratch folder with two or three tasks, checking that each lands in its own
folder, `.DS_Store` is absent, subfolders survive, and no `Creative Link` is
written. Only then a real run.
