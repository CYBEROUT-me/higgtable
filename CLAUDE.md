# HiggTable — notes for Claude

Read this before working on the project. It records how the app is built, how
the owner works, and the decisions made over its history, so a new session (or
a new Claude subscription) can continue without re-discovering any of it.

## What it is

An internal Electron desktop app for the UT marketing team (macOS + Windows).
It reads the **UT Marketing Team** Airtable base and helps designers work their
creative tasks:

- browse each app's Creatives table, filter by status and designer
- rename rendered media to the task's naming convention, and fix off-ratio statics
- **Autofill**: upload previews, set Timing, paste Creative Links, stamp Date Done
- dashboard of completed work, lineage canvas, new-task notifications

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
renderer/
  index.html   All markup, including the modals. The <script> order at the bottom matters.
  styles.css
  app.js       The renderer (~2.7k lines): state, loading, rendering, every feature's UI.
  canvas.js    Lineage canvas DOM, pan and zoom. Shares app.js's global scope.
  *-data.js, ratio-fix.js, task-refs.js, task-search.js, link-paste.js, drive-links.js,
  resize-plan.js (also required by main.js to build the ffmpeg command)
               PURE modules (no DOM, no IO), each with a Jest test in tests/.
tests/         Jest tests, one per pure module plus airtable.test.js.
docs/superpowers/specs, plans   Historical design docs and plans (several describe
               the removed Drive automation; treat them as history, not current design).
scripts/fetch-ffmpeg.js  Downloads ffmpeg/ffprobe into vendor/<os>-<arch>/ (git-ignored);
               runs automatically before every build/release script.
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
drive-links, ratio-fix, task-refs, task-search, link-paste, autofill-data, resize-plan, app,
canvas-data, canvas) and add `tests/<name>.test.js`.

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
  `workingDirectory`, `driveAccountIndex`, `autoFixRatio`, `resizeCustomSizes`
  (last 5 custom resize sizes, e.g. `"1200x628"`). Saved via the
  `save-settings` IPC, which **merges** with the existing contents.
- `higgtable.log` sits in the same folder. Both main (`log()`) and the
  renderer (`log()` → `window.app.log`) write to it. Timings for every
  Airtable page are logged there.
- renderer `localStorage`: `higgtable_des` (the selected designer),
  `higgtable_hidden_fields`, `higgtable_seen_ids_v1`,
  `higgtable_notifications_v1`, `higgtable_notify_muted`.

## Airtable

- Base **UT Marketing Team**, found by name at startup. Tables in
  `TARGET_TABLES` (app.js): `VCP Creatives`, `PLM Creatives`, `CMC Creatives`,
  `LB Creatives`, `OMGF Creatives`. Tabs in `index.html` mirror that list, so
  adding a table means editing both.
- Fields the app relies on: `Name`, `Status`, `DES` (designer), `Priority`,
  `Deadline`, `Format` (`Stat` vs `Video`), `Type`, `Preview` (attachment),
  `Timing` (single select), `Creative Link`, `Figma/Canvas link`,
  `Date Done` (YYYY-MM-DD), `Hours` (duration "H:MM"), `Old ID` / `New ID`
  (lineage), `Description` (markdown long text; Airtable escapes punctuation
  as `\_`, which `markdown-data.js`/`task-search.js` undo).
- Statuses used: `Ready for Design`, `In work` (the default filter), `To accept`,
  `Done`. The dashboard counts `Done` + `To accept` by `Date Done`.
- Field names that vary between tables are resolved against the live schema
  with `resolveFieldName` (task-refs.js). A missing field fails loudly
  instead of writing silently to nothing.
- `airtable.js`: `MAX_CONCURRENT_REQUESTS = 3` across the whole app. The slot
  is held **until the response body is read**, because releasing it at
  headers let unlimited bodies stream at once. 429 retries wait **outside**
  the slot. Batched PATCH sends 10 records per call.
- Loading: the active table loads first, the others preload in parallel.
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
- **Action bar** (`#bulk-actions-bar`, `updateBulkActionsBar`): shown for one
  or more selected rows. With nothing selected it stays in place, **greyed
  and inactive at the same size** (class `inactive`), so rows never jump. Don't
  name it `empty`, which collides with the `.empty` utility class. The owner
  rejected both a shrunken bar and empty space. Buttons: Mark as To Accept,
  Mark as In Work, Autofill, Resize, Compress, ⧉ Copy name (via clipboard
  IPC), Clear selection. The Mark buttons do **not** touch Date Done.
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
- **Dashboard** (`computeDashboardStats`, `dashboard-data.js`): Done and To
  accept tasks per designer by type, hours per designer, period presets.
- **Canvas** (`canvas.js`, `canvas-data.js`): lineage chains via Old ID /
  New ID, with pan and zoom.
- **Notifications** (`notifications-data.js`): when polling finds a new task
  for the selected designer, it notifies, rings the in-app bell (with sound
  and a mute toggle), and runs a cold-start catch-up for tasks assigned while
  the app was closed. Urgency badges come from the deadline.
- **Drive links**: the only remaining Drive feature. Before a
  `drive.google.com/drive/...` link opens, `rewriteDriveLink` inserts
  `/u/<driveAccountIndex>/` (set in Settings, e.g. `2`) so it opens in the
  right Google account. The owner explicitly asked to keep this.
- **Auto-update**: on Windows, electron-updater installs silently. On macOS
  (the app is unsigned) it checks GitHub's latest release and offers the
  .dmg. A mac user must run `xattr -cr /Applications/HiggTable.app` once.

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

- **Preview may be wiped locally after an upload**: Airtable's
  `uploadAttachment` response keys `fields` by **field ID**, but
  `performRename` and `confirmAutofill` do
  `rec.fields['Preview'] = result.fields['Preview']` (undefined). The log
  shows `upload-attachment: success, Preview now has 0 attachment(s)`. The
  data in Airtable is fine; the local copy is blank until the next refresh.
  Fix: take the first value of `result.fields`, or re-read the record.
- Dead code left over from the Drive removal: `findDirByExactName` in
  `main.js` (unused) and a run of blank lines around the clipboard IPC. Some
  comments still mention the deleted `drive-path.js`.
- `README.md` is the user-facing install guide, and its feature list is brief.
