# Google Drive delivery via browser automation

## Problem

When a designer finishes a creative, HiggTable already renames the files and
gathers them into a local per-task folder (`performRename()`,
`renderer/app.js` — files land in `<dir>/<fullTaskName>/`). Delivery to
Google Drive is then entirely manual: navigate to the right folder in a
browser, create the month and task folders if missing, drag the files in,
copy the folder link, and paste it into the Airtable `Creative Link` field.

The Drive API was ruled out by the user: the blocker was one-time auth
setup friction (Google Cloud project, consent screen, scope verification).
Google Drive for Desktop is also unavailable — it cannot sync the work
account (`Can't load oleksandr.yukh@unitedtech.ai ... sign out and back
in`), so the filesystem route is closed.

The user chose browser automation against a logged-in Google session,
after being shown the trade-off explicitly (see Risks).

## Goals

- One operation: upload a task's finished files to its Drive folder, then
  write that folder's link into the Airtable `Creative Link` field.
- No Google Cloud project, no OAuth setup, no API credentials.
- **Never write an unverified link.** `Creative Link` is written only after
  every expected file is confirmed present in Drive.
- **Never guess a destination.** An unrecognized app code aborts rather
  than falling back to a "closest" folder.
- Breakage caused by Google UI changes must fail loudly and early, not
  silently mid-delivery.

## Non-goals

- No Drive API and no service account.
- No dependency on Google Drive for Desktop.
- No bulk upload across multiple tasks; one task per invocation.
- No re-delivery/versioning logic. If a file of the same name already
  exists in the task folder, the user is warned (Drive creates duplicates
  rather than replacing) but no rename/replace is attempted.
- No read-side Drive operations — REF-material download, Drive folder
  search, and folder reorganization were all explicitly deprioritized.
- The personal Google account (`sashayukhno@gmail.com`) is out of scope;
  only the work account is used.
- No progress bar or partial-upload resume.

## Design

### Destination structure

```
Creatives / <App>_creatives / 08_August / <task Name> / <files>
```

`Creatives` lives under **"Shared with me"**, not My Drive and not a Shared
Drive. It therefore has no navigable path, which drives two decisions:
navigation is always by folder ID (`/folders/<id>`), and the per-app folder
IDs are configuration rather than something discovered at runtime.

### Trigger

An explicit **"Upload to Drive"** button in the rename panel, next to the
existing rename action. Deliberately not chained automatically onto
`performRename()`: UI automation is fragile, so a human initiates each
delivery and sees its outcome.

### Path resolution (pure, `renderer/drive-path.js`)

A new pure module, Jest-tested, mirroring the existing
`drive-links.js` / `dashboard-data.js` / `notifications-data.js` split.
Everything decidable without a browser lives here:

- `appCodeFromTaskName(name)` — first underscore-separated token
  (`CMC_1427_...` → `CMC`).
- `monthFolderName(today)` — `08_August` from a `YYYY-MM-DD` string;
  zero-padded month number, underscore, English month name. `today` is
  passed in, never read from the clock inside the module, consistent with
  `computeDeadlineUrgency` and `recordToNotification`.
- `resolveAppFolderId(code, mapping)` — returns the configured folder ID,
  or `null` when the code is unrecognized.

The app-code mapping is **editable configuration**, seeded with:

| Code | Folder |
|---|---|
| CMC | Call Me Chat_creatives |
| LO | Lowins_creatives |
| OL | Olive_creatives |
| PL | Plamfy_creatives |
| TL | TopLive_creatives |

Configuration rather than hardcoding because mirror apps exist with
different starting letters and will need adding without a code change.
Unrecognized codes are expected in practice — `LV_1961_1957_...` already
exists in the CMC table — and must abort: delivering one client's creative
into another client's folder is the worst available outcome.

### Browser layer (`drive-browser.js`, main process)

A new main-process module owning a dedicated `BrowserWindow` with a
persistent session partition (`persist:gdrive`), so the Google login
survives app restarts. The user logs in manually, in Google's real login
page. The application never handles, stores, or types credentials.

The renderer reaches it only through IPC, consistent with the existing
`preload.js` / `ipcMain.handle` pattern — `window.app.driveUpload(...)`
bridging to an `ipcMain.handle('drive-upload', ...)`.

Four operations require the page DOM: detect whether a child folder
exists and read its ID, create a folder, trigger the file upload, and
confirm the upload finished. Everywhere else the DOM is avoided:

- Folder identity and the final link come from `webContents.getURL()`
  after navigating into a folder (`/folders/<id>`), not from scraping.
- Locating a child folder by name uses the same
  `?q=parent:<id>+title:<name>` search-URL form the user already uses
  manually.

### Containing fragility

Two structural defenses, both load-bearing:

**A single `probes` module.** Every DOM assumption — selectors, the
new-folder interaction, the drop target, the upload-complete signal — is
defined in one place, each named and documented. When Google changes the
UI, there is exactly one file to repair.

**A preflight self-test.** Before any upload is attempted, each probe is
checked against the live page. If any probe no longer matches, the
operation aborts before touching a single file. This converts "the
automation broke and the creative was never delivered, silently" into
"the automation broke and told you which probe failed".

### Upload mechanism

Files are injected into the page rather than driven through the native OS
file dialog, which cannot be scripted. Two strategies, tried in order:

1. Set `.files` on Drive's hidden `<input type="file">` via a constructed
   `DataTransfer`, then dispatch `change`.
2. Dispatch a synthetic `drop` event carrying a `DataTransfer` of `File`
   objects onto the folder view's drop target.

File bytes are read in the main process (`fs.readFile`) and passed into
the page context for `File` construction. Both strategies live behind the
`probes` module.

### Verification gate

After the upload reports completion, the task folder is reloaded fresh and
every expected filename (enumerated from the local task folder) is
confirmed present. Only then is `Creative Link` written, reusing the
existing `updateRecordField` path. On any mismatch, nothing is written and
the user is told exactly which files are missing.

### Settings

One new settings section: five rows of `code → folder URL`, seeded with the
five apps above, each populated once by opening the folder in Drive and
copying its URL (the folder ID is parsed out of it). Persisted through the
existing shallow-merging `save-settings` IPC handler, saved on change like
the working-directory and Drive-account-index fields.

### Failure modes

| Situation | Behavior |
|---|---|
| Not logged into Google | Show the Drive window, prompt manual login |
| Unrecognized app code | Abort, name the code |
| `<App>_creatives` folder missing | Abort — never created automatically |
| Month or task folder missing | Create it |
| Task folder already exists | Upload into it |
| Same-name file already present | Warn (Drive duplicates rather than replaces) |
| Any preflight probe fails | Abort before uploading |
| Verification mismatch | Write nothing; report missing files |

`<App>_creatives` is deliberately never auto-created: a typo-created
sibling folder would silently split a client's deliverables.

## Testing

`renderer/drive-path.js` is pure and gets full Jest coverage:
`appCodeFromTaskName` on real names including an unrecognized code;
`monthFolderName` across zero-padded and year-boundary cases;
`resolveAppFolderId` returning `null` for unknown codes.

The browser layer cannot be tested by the author — it requires the user's
authenticated Google session, and the author will not handle their
credentials. It is therefore built as a driver the user runs against a
single throwaway task, reporting what it observed at each step, with the
Airtable write disabled until the full path has been confirmed once.

## Risks

Accepted knowingly by the user after the alternatives were presented:

- **UI-change fragility.** Drive's web app is an obfuscated SPA; any
  redesign can break the probes. Mitigated by the preflight self-test and
  the verification gate, which make breakage loud rather than silent.
- **Untestable by the author.** Expect iteration on the probes, especially
  the upload injection, which is the least predictable component.
- **Terms of service.** Automating Google's web UI sits less comfortably
  against Google's terms than using the published API.
