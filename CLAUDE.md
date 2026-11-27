# HiggTable — notes for Claude

Read this before working on the project. It records how the app is built, how
the owner works, and the decisions made over its history, so a new session (or
a new Claude subscription) can continue without re-discovering any of it.

## What it is

An internal Electron desktop app for the UT marketing team (macOS + Windows).
It reads the **UT Marketing Team** Airtable base and helps designers work their
creative tasks:

- browse each app's Creatives table as a table (tasks grouped into packs, with
  preview thumbnails) or a board, filter by status and designer
- rename rendered media to the task's naming convention, and fix off-ratio statics
- Resize / Compress videos, then **Autofill**: upload previews, set Timing and
  Hours, paste Creative Links, stamp Date Done
- dashboard of completed work, manager workload view, lineage canvas, new-task
  and deadline notifications, a ⌘K command palette

Owner: Oleksandr (GitHub `CYBEROUT-me`). Releases are published to
`github.com/CYBEROUT-me/higgtable`, and coworkers install them from there.

## Commands

```bash
npm install
npm start      # run the app locally (Electron)
npm test       # Jest; all pure modules are covered. Must stay green.
```

Release (the owner usually does this step themselves):

```bash
GH_TOKEN=$(gh auth token) npm run release   # builds mac .dmg + win .exe and publishes a GitHub release
```

`gh` is logged in as CYBEROUT-me with `repo` + `workflow` scopes, so no pasted
token is needed. If a shell has a stale `GH_TOKEN` exported, `unset GH_TOKEN`
first: `gh auth token` itself honours `GH_TOKEN`, and a bad value gives
`HttpError: 401`.

## Working conventions with the owner

- Development happens **directly on `main`**. No branches or PRs.
- **"bump version, commit and push"** means: commit the pending work, run
  `npm version <next patch> --no-git-tag-version`, commit `package.json` and
  `package-lock.json` as `Bump version to X.Y.Z`, then `git push origin main`.
  Use a minor bump for a feature-sized release when asked. The owner then runs
  the release. The tag is created by electron-builder at release time, so push
  **before** they release, or the tag points at an old commit.
- Stage **only the files you changed**. The owner sometimes has their own
  uncommitted edits, for example a hand-edited `package.json` version.
- Commit messages: one imperative sentence describing the user-visible change
  (e.g. "Normalise 1x1 statics to exactly 1080x1080"), optional body for why.
- Don't push unless asked. Don't create tags or releases yourself.
- The owner writes in English, often quickly and with typos. Answer in English.
  **Release notes are requested in Ukrainian**, describing what changed since
  the previous release from the user's point of view, workflow by workflow.
- They test by running `npm start` and report back with screenshots, DevTools
  output, or log lines. Ask them for `higgtable.log` lines when diagnosing.
- Never echo, store, or use tokens they paste. A GitHub token was once pasted
  in plain text; the advice was to revoke it.
- Never handle their Google credentials. Never write a link to Airtable that
  has not been verified or explicitly reviewed by the user.

## Architecture

No bundler, no framework. Plain JS.

```
main.js        Electron main process: window, IPC handlers, settings file, logging,
               file dimension probing (image-size + a hand-rolled MP4 box parser),
               image normalisation (nativeImage), auto-update.
airtable.js    Airtable REST client used by main.js: concurrency limiter, 429 retry,
               pagination, attachment upload, single and batched PATCH.
resizer.js     Video Resizer engine used by main.js: bundled ffmpeg path, ffprobe
               (cached), one ffmpeg per task, temp -> final renames, cancel.
preload.js     contextBridge: exposes window.airtable.* and window.app.* to the renderer.
mcp-server.js  Read-only MCP server for Claude (stdio), launched by Claude Desktop as
               HiggTable's own executable in ELECTRON_RUN_AS_NODE mode; answers from
               the records cache. Logic in renderer/mcp-tools.js.
claude-config.js  Pure helpers for HiggTable's entry in claude_desktop_config.json.
renderer/
  index.html   All markup, including the modals. The <script> order at the bottom matters.
  styles.css
  app.js       The renderer (~4.6k lines): state, loading, rendering, every feature's UI.
  canvas.js    Lineage canvas DOM, pan and zoom. Shares app.js's global scope.
  *-data.js, ratio-fix.js, task-refs.js, task-search.js, link-paste.js, drive-links.js,
  records-sync.js, icons.js, resize-plan.js (also required by main.js to build the
  ffmpeg command)
               PURE modules (no DOM, no IO), each with a Jest test in tests/.
tests/         Jest tests, one per pure module plus airtable.test.js.
docs/superpowers/specs, plans   Historical design docs and plans (several describe
               the removed Drive automation; treat them as history, not current design).
scripts/fetch-ffmpeg.js, fetch-rclone.js  Download ffmpeg/ffprobe and rclone into
               vendor/<os>-<arch>/ (git-ignored); `npm run fetch-binaries` runs
               both automatically before every build/release script.
build/         App icons.  dist/  Build output (git-ignored).
```

### The pure-module pattern (follow it for new logic)

Logic that can be separated from the DOM goes into its own `renderer/<name>.js`:
top-level functions and consts, no DOM access, ending in

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ... };
}
```

The browser loads it with a `<script>` tag **before `app.js`**, so its functions
are globals there. Jest `require`s the same file. Add the `<script>` tag in
`index.html` (current order: notifications-data, dashboard-data, markdown-data,
drive-links, ratio-fix, task-refs, task-search, link-paste, autofill-data,
workload-data, resize-plan, readiness-data, records-sync, icons, pack-data, app,
canvas-data, canvas; performance-data right after dashboard-data, drive-index
right after drive-links) and add
`tests/<name>.test.js`.

### Process boundary

- The renderer has `contextIsolation: true`, `nodeIntegration: false`. All file
  system, network, and clipboard access goes through `ipcMain.handle` in
  `main.js` plus a bridge entry in `preload.js`. Adding a capability means
  editing both.
- The page is loaded with `loadFile` (a `file://` origin). Use the
  `copy-to-clipboard` IPC, not `navigator.clipboard`. External links go
  through the `open-external` IPC, which only allows http(s) URLs.
- CSP in `index.html`: scripts from `'self'` only; images from
  `*.airtableusercontent.com` and `data:`.

### Settings and persisted state

- `settings.json` in Electron `userData` (macOS:
  `~/Library/Application Support/HiggTable/`): `apiKey` (Airtable PAT),
  `workingDirectory`, `driveAccountIndex`, `driveRootFolderId`, `rcloneRemote`,
  `driveCodeApps`, `driveFolderIds`, `autoFixRatio`, `resizeCustomSizes`
  (last 5 custom resize sizes, e.g. `"1200x628"`), `selectedDesigner`
  (Settings → Claude → "I am"), `lastRunVersion` (spots an update). Saved via the
  `save-settings` IPC, which **merges** with the existing contents.
- `higgtable.log` sits in the same folder. Both main (`log()`) and the
  renderer (`log()` → `window.app.log`) write to it. Timings for every
  Airtable page are logged there.
- renderer `localStorage`: `higgtable_des` (the selected designer),
  `higgtable_hidden_fields`, `higgtable_seen_ids_v1`,
  `higgtable_notifications_v1`, `higgtable_notify_muted`,
  `higgtable_deadline_alerts_v1` (deadline alerts already raised),
  `higgtable_view` (`table` | `board`), `higgtable_panel_width`.

## Airtable

- Base **UT Marketing Team**, found by name at startup. Tables in
  `TARGET_TABLES` (app.js): `VCP Creatives`, `PLM Creatives`, `CMC Creatives`,
  `LB Creatives`, `OMGF Creatives`. Tabs in `index.html` mirror that list, so
  adding a table means editing both.
- Fields the app relies on: `Name`, `Status`, `DES` (designer), `Priority`,
  `Deadline`, `Format` (`Stat` vs `Video`), `Type`, `Preview` (attachment;
  its `thumbnails.small/large/full` feed the table, board and panel),
  `Timing` (single select), `Creative Link`, `Figma/Canvas link` (LB spells it
  `Figmа Link` with a **Cyrillic "а"**, so `resolveFieldName` misses it; the
  panel falls back to any "Fig… link" column), `REF` (url), `Project` (single
  select: the product, e.g. TL/OL/LO; the Workload filter), `Date` (task day),
  `Date Done` (YYYY-MM-DD), `Hours` (a **single select** of "HH:MM" choices in
  15-minute steps, 00:15–06:00, not a duration), `Old ID` / `New ID`
  (lineage), `Description` (markdown long text; Airtable escapes punctuation
  as `\_`, which `markdown-data.js`/`task-search.js` undo).
- Task names: `APP_<New ID>_<Old ID>_<Model>_<Script>_<LANG>_<branch>_…_<Format>_<Type>_<Concept>_<ratio>`,
  e.g. `LO_15945_13140_M0_S0_GR_usr_ARI_ILU_Video_VAR_Mix_9x16`.
- Statuses: `Backlog`, `Rework`, `Ready for Design`, `In work` (the default
  filter), `To accept`, `Done`. The dashboard counts `Done` + `To accept` by
  `Date Done`; Workload counts `Ready for Design` + `In work`.
- Field names that vary between tables are resolved against the live schema
  with `resolveFieldName` (task-refs.js). A missing field fails loudly
  instead of writing silently to nothing.
- `airtable.js`: `MAX_CONCURRENT_REQUESTS = 3` across the whole app. The slot
  is held **until the response body is read**, because releasing it at
  headers let unlimited bodies stream at once. 429 retries wait **outside**
  the slot. Batched PATCH sends 10 records per call.
- Loading: the active table loads first (from the disk cache when there is
  one, see "Disk cache + incremental sync"), the others preload in parallel.
  Records are reversed to newest-first. Progress renders are coalesced to one
  every 500 ms (`PROGRESS_RENDER_MS`), because rendering per page was
  quadratic.
- Polling is self-scheduling: the next cycle starts after the current one
  finishes, resting at least as long as the cycle took (minimum 5 min). A
  fixed interval ran back to back once tables reached ~16k records.
- Reference speed: ~3 ms per record (VCP, ~11k records, loads in ~33 s).

## Features and where they live

- **Table view** (`render()`): status chips, a designer picker ("You:"),
  sortable columns, a column chooser, Airtable select colours. Click selects
  one row; Cmd/Ctrl-click toggles; Shift-click selects a range.
- **Step bar + side panel**: the action bar reads as the
  workflow, Resize › Compress › Autofill › To Accept, each step showing what is
  left for the selection (`renderStepButtons`); the next step is outlined. Rare
  actions sit at the right as icon-only buttons (`#extra-actions`): ↩ Mark as
  In Work, Copy name, Copy name + brief, Copy name + brief + REF, Clear.
  "Ready" is computed in `readiness-data.js` from one walk of the working
  directory (`index-task-files` IPC, refreshed on focus at most every 30 s and
  after runs) plus the record's fields; it also feeds the table's Ready column.
  A single click opens `#task-panel` on the right, laid out as a task card:
  the large Preview (click opens it full size), priority / status / deadline
  countdown / Type / Format, Drive · Figma · REF link buttons, the brief
  (copy), files with sizes, fields, and the rename drop zone. Its width is
  draggable (left edge) and remembered.
  Double-click still opens the full field editor. Several selected → the panel
  lists them all with what each needs. ↑/↓ move through tasks, Shift extends.
  **▶ Finish** starts at the first step still needed; Resize/Compress opened
  by it hand over to Autofill on a clean run, and Autofill's result offers To
  Accept.
- **Disk cache + incremental sync** (`records-sync.js`, IPC
  `records-cache-read/write`, `get-records` with `modifiedAfter`): records are
  stored in `userData/records-cache/<base>_<table>.json`; at startup they show
  at once, then only records with `LAST_MODIFIED_TIME()` after the last sync
  (minus 2 min) are fetched and merged in place. Polling does the same. A full
  download still runs every 6 h and on ⟳, because deletions are invisible to
  the incremental query. Measured: VCP changes over 24 h = 114 records in 0.5 s
  vs ~30 s for the full table.
- **Action bar** (`#bulk-actions-bar`, `updateBulkActionsBar`): shown for one
  or more selected rows. With nothing selected it stays in place, **greyed
  and inactive at the same size** (class `inactive`), so rows never jump. Don't
  name it `empty`, which collides with the `.empty` utility class. The owner
  rejected both a shrunken bar and empty space. The Mark buttons do **not**
  touch Date Done. Mark as In Work keeps the selection (usually more work on
  the same tasks follows); To Accept clears it. Both offer Undo in a toast.
- **Repeat renders**: After Effects writes `<base>_9x16_1.mp4` when the master
  exists. `index-task-files` indexes those (with mtime); `readiness-data.js`
  (`findRepeatRenders`) flags a newer one in the Ready column, the panel, the
  step-bar count, Resize/Compress and Autofill. "Use _9x16_1 as master"
  (`promote-repeat-render` IPC) renames it over the master: no backup, by the
  owner's choice. It warns, never blocks.
- **Packs** (`pack-data.js`): consecutive rows with the same `Old ID` + `Date`
  (parent from the name when `Old ID` is empty) form a pack, e.g. one creative
  localised into several languages. A pack gets a header row
  (`renderPackHeader`: concept, parent, languages, day, size, "ready k/N");
  clicking it selects the whole pack, the arrow folds it (session only).
- **Preview links expire**: Airtable signs attachment links for 2–4 hours
  (`.../v3/u/N/N/<expiry ms>/...`), but records stay in the disk cache and
  through incremental syncs much longer. `previewElement` never shows a broken
  image: an expired link (`previewNeedsRefresh`, records-sync.js) or a failed
  load shows the placeholder and queues the record for `get-records-by-id`
  (50 ids per request, each record at most every 5 min). ⌘K "Reload previews"
  forces it for the visible rows. Fresh links are not written to the disk cache.
- **Table details**: a Preview thumbnail column; Format is not a column but
  shows as the placeholder icon; with several rows selected each shows a check
  instead of its number.
- **Board view** (`renderBoard`, toggle `#view-toggle`): columns Rework / Ready
  for Design / In work / To accept regardless of the status chips; cards show
  preview, priority, deadline, Type. Dragging cards to a column calls
  `moveToStatus` (writes Status, toast with Undo via `restoreStatuses`).
  At most 150 cards per column. Within a column, tasks of one pack
  (`groupIntoPacks`, not only consecutive ones) sit under a compact pack header:
  click selects the pack, dragging it moves the whole pack, the arrow folds it.
- **Command palette** (⌘K / Ctrl+K, `PALETTE_COMMANDS` +
  `dynamicPaletteCommands`): actions (mostly clicking the app's own buttons),
  Set status: X on the selection (Undo), Filter status: X, Designer: X,
  Dashboard: <period>, Workload: <table>, plus task search across loaded tables.
  On a task hit ⌘↵ opens its Creative Link / Figma, ⇧↵ copies the name, ⌥↵
  name + brief.
- **Toasts** (`toast`, `toastError`, `#toast-stack`): replace `alert()`
  everywhere. Info fades, errors stay until closed; optional action button.
- **Icons** (`icons.js`): one 16×16, 1.5 px stroke line set. Static buttons
  get theirs from `data-icon="name"` (`applyIcons` at startup); JS-built
  buttons use `iconSvg(name)`. A button that flashes "copied" must go through
  `flashCopied`, which restores its markup, never `textContent`.
- **Copying**: ⌘C / Ctrl+C copies the selected names, ⌘⇧C names + briefs
  (`copySelectedTasks`, `formatNameAndBriefs` in markdown-data.js); uses
  `e.code` so non-Latin layouts work; normal copy wins in inputs, with text
  selected, or with a modal open.
- **Links**: every link click opens in the system browser. The renderer
  handles its own links; main.js also has `setWindowOpenHandler` and a
  `will-navigate` guard, because a plain `<a href>` once replaced the app
  window with the web page.
- **Task details modal** (double-click a row): every field is editable and
  saved immediately, and the ⚙ button hides fields. Pinned fields: Hours,
  Date Done, Timing; Preview, Creative Link, Figma/Canvas link. Task
  references in the Description (e.g. `PL_6940`, `OL\_10838`) get buttons that
  open the referenced task's Creative Link (Video) or Figma/Canvas link
  (Stat), via `task-refs.js`.
- **Task search** (header): searches across all loaded tables
  (`task-search.js`, numeric-aware so `CMC_999` sorts before `CMC_1000`).
- **Rename panel** (select a task, drop files): the ratio is detected from
  real dimensions (`ratioFromDimensions`). A file becomes
  `<task name without ratio suffix>_<ratio>.<ext>`, moved into a subfolder
  named after the full task name next to the original. A renamed 1x1 image is
  auto-uploaded to `Preview`.
- **Ratio fix** (`ratio-fix.js` + `normalize-image` IPC): Higgsfield statics
  arrive slightly off-ratio (1520×2688, 1536×2752, 2752×1536) or small
  (768×1365, 1024×1024). Fix = **centred crop** of the too-long axis to the
  exact ratio (never stretch; differences under 2 px are ignored,
  `MIN_CROP_PIXELS`), then scale (up or down) to the delivery size in
  `CANONICAL_SIZES`: 9x16 → 1080×1920, 16x9 → 1920×1080, 1x1 → 1080×1080.
  Other ratios are cropped only. Upscales are labelled as such in the UI. The
  file is re-measured after writing, and the fix throws if the size is wrong.
  PNG stays PNG, and JPEG is re-encoded at quality 95. An "Always fix
  automatically" checkbox (`autoFixRatio`) fixes files as they are added. Its
  row stays visible while it is on, so it can be turned off.
- **Autofill** (`openAutofillModal` → `renderAutofillApprovalList` →
  `confirmAutofill`; logic in `autofill-data.js`, `link-paste.js`):
  - Searches `workingDirectory` recursively, once, for
    `<base>_<ratio>.(png|jpg|jpeg)` previews and `<base>_<ratio>.mp4`
    videos. Ratio preference order with fallback; filenames match regardless
    of case.
  - The video duration gives `Timing` via `TIMING_BUCKETS` (±0.5 s around
    30/45/60 s).
  - The Figma/Canvas link field applies one link to every **Stat** task in the
    selection.
  - Creative Links textarea: the pasted links pair with tasks **sorted by
    name**. Tasks that already have a link keep their slot but start
    unticked. The order is editable with ↑/↓.
  - The "Drive order" checkbox undoes Google Drive's shift-select copy order
    (anchor, target, then the range between: `reorderFromDriveSelection`).
  - Each task is shown with a checkbox in a review list, and **nothing is
    written before Apply**. Previews upload one by one. Everything else goes
    out as one batched PATCH per record, and `Date Done` = today is stamped
    on every record actually written.
  - The modal is capped at 88vh and laid out as a flex column so Apply stays
    reachable.
- **Resize** (action bar → `openResizeModal`; logic in `resize-plan.js`, engine
  in `resizer.js`, IPC `find-all-files` / `resize-inspect` / `resize-render` /
  `resize-cancel` + `resize-progress` events). Spec:
  `docs/superpowers/specs/2026-10-26-video-resizer-design.md`.
  - Source = exactly `<base>_9x16.mp4` under the working directory (all matches
    collected; several → only the one in a folder named after the full task
    name, otherwise skipped, never guessed). Must be 9:16.
  - Look copies the owner's AE template: background = source blurred (sigma 25
    on a 1/6 copy) + `vignette=angle=PI/4.5` in RGB **at full layer size** (on
    the small copy it is not identical: chroma drifts), cover-scaled; foreground
    contain-scaled, centred. 1x1 is the centre crop of the 16x9 composite;
    custom sizes use plain cover/contain. Delivery sizes fixed: 1080×1080,
    1080×1350, 1920×1080; custom = exact pixels, named `<base>_<W>x<H>.mp4`.
  - One ffmpeg per task, tasks in sequence; encoding matches the source; on
    macOS the largest output uses h264_videotoolbox. Full-size first-frame PNGs;
    `<base>_9x16.png` only if missing. Temps `.<name>.resizing`, renamed after
    exit 0, deleted on failure/cancel/quit. Existing videos → one Overwrite /
    Don't render prompt per batch. No Airtable writes.
  - ffmpeg ships in `resources/bin` (electron-builder `extraResources` from
    `vendor/`). In dev it falls back to Homebrew's ffmpeg.
  - Speed reference: 37 s 1080×1920 clip, 3 sizes + PNGs ≈ 12.8 s on the
    owner's Mac; the full-size vignette is ~5 s of that (not slice-threaded).
- **32 MB limit** (`MAX_DELIVERY_BYTES` = 32,000,000 bytes, as Finder counts):
  every delivered video, master and resizes, must be under it.
  - Resize encodes each output at `deliveryVideoBitrate` (source bitrate,
    capped by duration to aim at 92% of the limit: single-pass x264 overshoots
    ~4%, and Finder shows 31.99 MB as "32 MB"). After rendering, any output
    still over, and then the 9x16 master, are compressed in place.
  - **Compress** button: same dialog in `mode: 'compress'` (no size chips). Finds
    the task's master like Resize, then every `<base>_<ratio|WxH>.mp4` next to it
    (`isTaskVideoName`; `_9x16_1.mp4` repeats excluded) and compresses those
    over the limit. IPC `compress-inspect` / `compress-render`.
  - `compressVideo` (resizer.js): libx264/libx265 `-preset medium`, software
    only, same resolution/timing/colour, audio copied. The temp is measured
    before the swap; over → retry lower (`retryVideoBitrate`), up to 3 tries.
    **The original is replaced, no backup** (the owner's decision: AE can
    re-render). The swap is a single rename over the original, never a
    delete-then-rename, so a crash cannot lose the file.
  - Reference: TLN_3536 9x16 (18 s, 32.7 MB) → 30.3 MB in ~6 s, SSIM 0.997.
- **Dashboard** (`computeDashboardStats`, `dashboard-data.js`,
  `performance-data.js`): period presets (week … quarter, previous quarter) and
  two views (`#dashboard-view-toggle`, `higgtable_dash_view`). **Compact** (the
  default, as before): Done + To accept per designer by Type, then hours per
  designer. **Detailed**: the same first table (the owner wants it first),
  headline tiles, a load chart (tasks and hours per day / week / month, two
  single-series SVG bar charts with the value inside each bar, never one chart
  with two scales) with a designer picker, the last six full months per
  designer (last 3 vs the 3 before, fitted trend, ±5 %/month = steady),
  designers in the period with Rework now, hours per task by Type. A
  period-vs-previous-period comparison was tried and dropped: week against
  week said little. The step bar, Table/Board switch and Columns button are
  hidden in Dashboard, Workload and Canvas.
- **Workload** (header tab, `renderWorkload`, `workload-data.js`): for the
  manager, open tasks (Ready for Design + In work) and High ones per designer;
  filter by table and by product (`Project`).
- **Canvas** (`canvas.js`, `canvas-data.js`): lineage chains via Old ID /
  New ID, with pan and zoom.
- **Notifications** (`notifications-data.js`): when polling finds a new task
  for the selected designer, it notifies, rings the in-app bell (with sound
  and a mute toggle), and runs a cold-start catch-up for tasks assigned while
  the app was closed. Urgency badges come from the deadline. **Deadline
  alerts**: the selected designer's unfinished tasks due in 1–2 days raise a
  second sound, an OS banner and an accented bell entry, once per task per
  deadline (`findDeadlineAlerts`, keys in `higgtable_deadline_alerts_v1`).
- **Google Drive through rclone** (read only; `drive-rclone.js` in main,
  `renderer/drive-index.js` pure, IPC `drive-find-task-folders` /
  `drive-check`). Layout: `<root>/<App>_creatives/<YYYY>/<MM_Month>/<task
  name>/`. A task's Creative Link is its own folder's link, built from the
  folder ID (`drive.google.com/drive/folders/<ID>`); never `rclone link`, which
  changes sharing. Autofill looks the folders up when it opens (this month,
  last month, months of Date Done) and pairs them by name (Cyrillic look-alike
  letters folded); two folders with one name or an existing link arrive
  unticked; pasted links still take over. "Open GD Folder" opens the task's
  folder (one task) or the month folder. Which `<App>_creatives` holds a
  prefix (LO, LiV, TLN…) is learned from each app's latest non-empty month
  (a prefix whose own folder is empty is then looked for in every app's
  months) and saved as `driveCodeApps`; folder ids are cached in `driveFolderIds`. Settings:
  `driveRootFolderId`, `rcloneRemote` (default `gdrive`), optional
  `rclonePath` (overrides the bundled one). rclone v1.76.0 ships in the app
  like ffmpeg (`scripts/fetch-rclone.js`, checked against rclone's
  SHA256SUMS, into vendor/ → resources/bin; ~33 MB per installer). Settings →
  "Connect Google Drive" runs `rclone config create <remote> drive
  scope=drive.readonly`: rclone opens Google's sign-in in the user's browser
  and keeps the token in its own config (`~/.config/rclone/rclone.conf`,
  shared with a system rclone); the app never sees credentials. rclone's shared Google
  client is throttled (first lookup ~60 s, then ~2 s per month folder) and is
  being retired during 2026: an own client_id is the fix. Upload is not built
  (needs write scope). The old `driveAppFolders` / `driveAppMirrors` keys in
  settings.json are no longer used.
- **Claude (read-only MCP server)** (`mcp-server.js`, `renderer/mcp-tools.js`,
  `claude-config.js`; spec `docs/superpowers/specs/2026-11-27-claude-mcp-server-design.md`):
  the shared Airtable account allows only 10 connections, so designers read
  tasks in Claude Desktop through HiggTable instead of the Airtable connector.
  Settings → Claude → Connect writes only `mcpServers.higgtable` into Claude
  Desktop's config (macOS `~/Library/Application Support/Claude/`, Windows
  `%APPDATA%\Claude\`), refusing a config that isn't valid JSON; Disconnect
  removes only that entry; a button copies the `claude mcp add` command for
  Claude Code. Claude then runs `<HiggTable executable> <app.asar>/mcp-server.js`
  with `ELECTRON_RUN_AS_NODE=1` and `HIGGTABLE_USER_DATA`, so it works with the
  app closed, needs no network and never sees the Airtable token (of
  settings.json it reads only `selectedDesigner`). Tools, all read-only:
  `find_tasks` (names, then "Brief mentions it"), `get_task` (fields, links,
  cleaned brief), `my_tasks` (Rework / Ready for Design / In work of "I am",
  soonest deadline first), `workload` (as the Workload tab). Every answer ends
  with "From HiggTable · VCP synced …" and warns about tables older than 24 h.
  The cache payload carries `tableName`; an incremental sync that finds nothing
  writes only `<key>.meta.json` (`{ syncedAt }`, IPC `records-cache-touch`).
  A packaged app repairs a moved entry at startup (never adds one, never from a
  mounted .dmg or a translocated copy); that check can never stop the window opening.
  `mcp-tools.js` follows the pure-module pattern but is not in index.html.
  Windows: an update most likely closes the server Claude runs (same exe
  name), so after an update HiggTable shows "Quit and reopen Claude to
  reconnect" (accepted by the owner; check on a Windows PC and note here).
  Reference: first load of the owner's cache (21.5k records) 0.25 s, then
  instant; a search ~60 ms.
- **Drive links**: the other Drive feature. Before a
  `drive.google.com/drive/...` link opens, `rewriteDriveLink` inserts
  `/u/<driveAccountIndex>/` (set in Settings, e.g. `2`) so it opens in the
  right Google account. The owner explicitly asked to keep this.
- **Auto-update**: on Windows, electron-updater installs silently. On macOS
  (the app is unsigned) it checks GitHub's latest release and offers the
  .dmg. A mac user must run `xattr -cr /Applications/HiggTable.app` once.
- **Windows build is x64** (`build.win.target` arch `["x64"]`). On the
  owner's Apple Silicon Mac electron-builder otherwise defaulted to arm64:
  the installer then left only the uninstaller on x64 PCs and shipped no
  ffmpeg (fixed in 1.8.1).

## History and decisions (don't relitigate without the owner)

- **Google Drive automation was built and then removed** (v1.6.0, commit
  `fe568a9`): a hidden Electron Drive window driven over CDP that created
  month and task folders, uploaded files and folders, and found folders by
  name. It was slow, fragile against Drive's virtualised DOM, and needed a
  Google login inside the app. It was replaced by pasting Creative Links into
  Autofill. Do not re-add Drive automation unless the owner asks. `/u/N/`
  link rewriting stays.
- The rename panel's own Autofill button was removed. Autofill lives only in
  the action bar, which now also appears for a single selected row.
- Date Done is stamped by Autofill, not by status changes.
- Off-ratio statics: crop, never stretch. The owner did not want a choice
  between the two.
- Edits to the large `app.js`: there were several bugs from inserting code at
  the wrong "first occurrence", such as an `addEventListener` chained onto a
  `const`, or an orphaned line. After non-trivial edits, check that every
  `getElementById(...)` used for wiring exists in `index.html`, run
  `node --check renderer/app.js main.js preload.js`, and run `npm test`.

## Known loose ends

- Dead code left over from the Drive removal: `findDirByExactName` in
  `main.js` (unused) and a run of blank lines around the clipboard IPC. Some
  comments still mention the deleted `drive-path.js`.
- `README.md` is the user-facing install guide, and its feature list is brief.

## Release notes and screenshots

- Each release gets `release-assets/<version>/` (untracked): numbered
  screenshots plus `slack-message.md`, the Ukrainian notes in Slack markup
  that reference them ("скрін 1, 2").
- Since 1.10.0 the owner wants screenshots of **real data** for Slack (it
  shows the real dashboard numbers). They stay untracked in release-assets and
  must never be committed or attached to the public GitHub release. Recipe: an
  Electron launcher that sets `userData` to the HiggTable folder, points
  `BrowserWindow.loadFile` at the repo, `require`s main.js, then replaces every
  writing IPC handler (update-records, upload-attachment, rename-file,
  resize/compress-render, records-cache-write, save-settings, open-external,
  copy-to-clipboard, …) with one that throws, and runs scripted scenes with
  `executeJavaScript` + `capturePage()` (`force-device-scale-factor 2`, content
  1440×860). The owner's own app must be closed; restore their view
  (`higgtable_view`) afterwards.
- The demo harness below is for anything that must not show real data:
- Screenshots are 2880×1720 (1440×860 at 2×) of a **demo harness**: copy `renderer/` to the
  scratchpad, add a `stub.js` before `notifications-data.js` that sets
  `window.app` / `window.airtable` to no-op proxies (`indexTaskFiles` returns
  fake `[name, bytes, path]` entries), and a `seed.js` after `canvas.js` that
  fills `state.tables`, `state.records`, `recordsCache` with invented tasks
  in the real naming pattern (previews as `data:` SVG, which the CSP allows).
  Serve it with `python3 -m http.server` and capture with a small Electron
  script (`force-device-scale-factor 2`, `capturePage()`), one scripted
  scene per shot.
