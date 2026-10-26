# Video Resizer — design

Status: draft for the owner's approval (2026-10-26).
Reference material: `/Users/pc-63/Downloads/RESIZER_WORKFLOW.md`, a Ukrainian guide by a
colleague describing an ffmpeg-based resizer (a native macOS Swift app). This design uses
its ffmpeg mechanics but **replaces its look** with the owner's After Effects template
(section 4).

## 1. Intent

Designers deliver every video task as a 9x16 master plus 1x1, 4x5 and 16x9 versions,
each with a first-frame PNG. Today every resize is built and rendered in After Effects,
one task at a time. The resizes are mechanical: the original sits centred over a
blurred, vignetted copy of itself. HiggTable should make them in seconds, for a whole
batch of tasks at once, on every designer's machine (macOS and Windows).

Success means: select the tasks you've rendered in 9x16, click **Resize**, pick sizes,
and get files that look like the After Effects versions, named and placed exactly as
today. Then **Autofill** on the same selection works unchanged.

### Goals
- Batch resize from the table's action bar.
- Output visually matches the owner's After Effects template (section 4).
- Standard sizes 1x1, 4x5, 16x9, plus custom pixel sizes chosen per run.
- Works for coworkers on macOS (Apple Silicon) and Windows, with nothing to install.
- Fast: about 2 s per task on the owner's Mac for all three standard sizes (measured
  in the spike).

### Non-goals
- No Airtable writes. Resize only makes files; Autofill stays the way to fill fields.
- No resizing of statics (images), and no sources other than a 9x16 video.
- No settings for blur, codec or bitrate. The template is fixed.
- No drag-and-drop resizer window like the guide's. Entry is the action bar only.
- No Finder or Explorer integration.

### Anti-goals (would make it a failure even if it "works")
- Output that visibly differs from the After Effects look.
- Broken or half-written files left behind after a failure or cancel.
- Silently overwriting existing deliveries.
- Guessing a source file (e.g. picking `_9x16_1.mp4` because `_9x16.mp4` is missing).
- Freezing the app while rendering.

## 2. How the owner works today (observed)

- Working directory (Settings → Working Directory, used by Autofill) is
  `…/After Effects 2026/United Tech Videos`. Task folders live in its `For GD`
  subfolder, and it also contains collected AE projects whose `(Footage)` folders hold
  other `*_9x16.mp4` files (packshots such as `PL_packshot 2_9x16.mp4`, some present
  in several places). No task master is duplicated today.
- One folder per task, named after the full task name (e.g.
  `PL_7456_7071_A0_S0_EN_usr_KRU_PRI_Video_ITR_TalkingHead_9x16`), containing:
  `<base>_9x16.mp4`, `<base>_1x1.mp4`, `<base>_4x5.mp4`, `<base>_16x9.mp4`, and a
  **full-size** first-frame PNG for each (`<base>_1x1.png` is 1080×1080, etc.), plus
  an `<APP>_<id> folder` with the collected AE project. `<base>` is the task name
  without its ratio suffix (`stripAspectRatio` in app.js).
- Sources seen: H.264 Main, 1080×1920, yuv420p, BT.709 tv range, 30 fps, AAC audio.
- One folder had its master named `…_9x16_1.mp4` (a repeated render). That counts as
  missing (anti-goal: no guessing).

## 3. The user flow (decided with the owner)

1. Select one or more tasks in the table, click **Resize** in the action bar (next to
   Autofill). The button is disabled when nothing is selected, like the other buttons.
2. A dialog opens (layout "A" from the mockup, chosen by the owner):
   - **Size chips** at the top, one set for the whole batch: `1x1 1080×1080`,
     `4x5 1080×1350`, `16x9 1920×1080`, all ticked by default.
   - **Custom size**: two number inputs (width × height, exact pixels) and **Add**,
     which adds a ticked chip such as `1200×628`. Custom sizes are remembered and
     offered next time as unticked chips. *(My call: keep the last 5, in settings.json
     as `resizeCustomSizes`.)*
   - **PNG previews** chip, ticked by default.
   - **Task list**: one row per selected task, showing whether its 9x16 source was
     found, whether resizes already exist, and, while running, a progress bar and
     the result.
   - Footer: a summary (e.g. "4 tasks × 3 sizes + previews → next to each source"),
     **Render**, and **Close**. While running, Render becomes **Cancel · 38%**.
3. **Finding sources**: for each task, look for exactly `<base>_9x16.mp4` (case
   insensitive, like Autofill) anywhere under the working directory, in one recursive
   walk that collects **every** match. (The existing `find-asset-files` keeps only the
   first match, so it needs an all-matches variant; Autofill's behaviour must not
   change.)
   - No match → the row says "no _9x16.mp4" and the task is skipped.
   - One match → use it.
   - Several matches → use the one whose parent folder is named exactly after the
     task's full name (e.g. `…/For GD/<task name>/`). If none or more than one
     qualifies, skip the task with "found in N places" and list the paths in the log.
     *(My call: never guess, see the anti-goals.)*
   - No working directory set → the same alert Autofill shows.
4. **Overwrite check** before rendering: if any target **video** already exists for any
   task, ask once for the whole batch: **Overwrite** or **Don't render** (Esc = don't
   render, which cancels the whole run). PNGs are overwritten without asking.
5. Tasks render **one after another** (one ffmpeg at a time already saturates the
   machine). The app stays usable. Each row shows progress, then done (with time),
   failed (with the reason), or skipped.
6. At the end: a summary (done / skipped / failed). The dialog stays open so failures
   can be read. Closing it during a run asks whether to cancel.

## 4. The look: copy of the After Effects template

Read from `PL_7456_…_TalkingHead_9x16.aep` (2026-10-26). Each resize comp has two
layers, both the 9x16 precomp:

| Comp | Background layer | Foreground layer |
|---|---|---|
| 4x5 (1080×1350) | scale 100%, centred; Gaussian Blur: Blurriness 50, Repeat Edge Pixels on; then CC Vignette: Amount 100, Angle of View 45°, centre = layer centre | scale 70.313% (= contain), centred |
| 16x9 (1920×1080) | scale 177.778%, centred; same blur and vignette | scale 56.25% (= contain), centred |
| 1x1 (1080×1080) | no layers of its own: the 16x9 comp at 100%, centred, i.e. the **centre crop of the 16x9** | (from the 16x9) |

The effects run in the layer's own space (1080×1920) before scaling.

**ffmpeg equivalent** (validated in the spike against the AE renders of PL_7456 and
OL_14835; frames are hard to tell apart and background brightness is within ~1–4%):
- Blur: the guide's method, `sigma = 50 × 0.5 = 25` px in source space, computed on a
  copy downscaled by `d = 6` (`scale=180:320:flags=area,gblur=sigma=4.1667:steps=3`),
  computed once and `split` to every output.
- Vignette: `format=gbrp,vignette=angle=PI/4.5,format=<pix_fmt>` (PI/4.5 = 40° is the
  value that matched the AE stills best, not a typo for AE's 45°; ffmpeg's vignette
  model differs from CC Vignette's) applied to the blurred
  background at layer size, before scaling to the output. It must be in RGB (in YUV it
  only darkens luma and the colours drift). *(Builder may apply it on the small blurred
  copy instead if the result is identical, for speed.)*
- Background then scaled up and centre-cropped to the output (crop after scale, as the
  guide says).
- Foreground: source scaled to "contain", lanczos, centred, overlaid.

**Background zoom per output** (W×H = source, tw×th = output):
- 4x5, 16x9 and any **custom** size: `cover = max(tw/W, th/H)` (this is what the
  template does for 4x5 and 16x9).
- 1x1: same as the 16x9 geometry: background zoom `1920/1080 = 1.7778` (relative to the
  1080-wide source) and foreground 56.25%. Equivalent to centre-cropping the 16x9
  composite. *(My call to keep that special case, because it is what the template does.)*
- Custom sizes use the general rule (background covers, foreground fits). *(My call; the
  template has no rule for them.)*

**Sizes are fixed delivery sizes**, not derived from the source: 1x1 1080×1080,
4x5 1080×1350, 16x9 1920×1080, custom exactly as typed (rounded to even numbers,
since H.264 needs that, and the chip shows the rounded value). Sources are expected
to be 1080×1920. A source whose ratio is not 9:16 (error under 1.5%) is skipped with
the reason. *(My call: fixed sizes match HiggTable's ratio-fix delivery sizes.)*

## 5. Encoding and files (from the guide)

- One ffmpeg process per task renders all chosen sizes, plus PNGs branched off each
  composite (`trim=end_frame=1` on preview branches is mandatory for speed).
- Match the source: codec, profile, level, pix_fmt, colour tags, frame timing
  (`-fps_mode passthrough`), bitrate `-b:v <source video bitrate>`, audio stream-copied,
  `-map_metadata 0`, `-movflags +faststart`. The guide's section 6 table covers H.264,
  HEVC, ProRes and "other"; the observed sources are all H.264.
- macOS "speed" hybrid: for H.264 yuv420p sources with 2 or more outputs, the largest
  output is encoded with `h264_videotoolbox`, the rest with `libx264 -preset veryfast`.
  Windows: everything on libx264 / libx265 / prores_ks (no VideoToolbox).
- **PNG previews**: first frame of each new video at **full output size** (the guide
  says half size; the owner's deliveries are full size, and `_1x1.png` becomes the
  Airtable Preview through Autofill). `<base>_9x16.png` is made next to the source only
  if it does not exist.
- Naming: standard sizes `<base>_<ratio>.<ext>` (`_1x1`, `_4x5`, `_16x9`); custom
  sizes `<base>_<W>x<H>.<ext>` in **exact pixels** (e.g. `_1200x628.mp4`), even when
  the size happens to match a ratio HiggTable knows, such as 1.91x1. **The owner decided
  this** ("exact pixels like 1200×628"). Autofill does not need to find custom-size
  files; its preview and timing come from the standard sizes. PNG = same name, `.png`. Output
  goes next to the source file. Extension and container follow the source (`.mp4`).
- Every output is written as a hidden temp file `.<final name>.resizing` with an explicit
  `-f`. Only after ffmpeg exits 0 are temps renamed over the finals. On failure or
  cancel all temps are deleted.
- Cancel: SIGTERM, then SIGKILL after ~2 s, then clean up temps. On Windows, kill the
  process (the builder decides how).
- Always drain stdout and stderr of ffmpeg/ffprobe while running (spawn with data
  handlers, arguments as an array, no shell). Progress comes from `-progress pipe:1`
  `out_time_us` divided by the probed duration.

## 6. Shipping ffmpeg

Coworkers have no ffmpeg, so HiggTable bundles `ffmpeg` and `ffprobe`:
- macOS arm64 static build (the guide used martin-riedl.de builds: libx264, libx265,
  VideoToolbox, gblur). Windows x64 build from gyan.dev or BtbN (GPL, with
  libx264/libx265). The builder must confirm `libx264`, `gblur` and `vignette` are
  present (`ffmpeg -encoders` / `-filters`), plus `h264_videotoolbox` on macOS.
- Stored in the repo under `vendor/<platform>-<arch>/`, copied by electron-builder
  `extraResources` to `resources/bin` (not inside asar). Runtime path:
  `path.join(process.resourcesPath, 'bin', …)` when packaged, `vendor/…` in dev.
  *(Whether the ~100 MB binaries are committed to git, Git LFS, or fetched by a script
  before build is the builder's call; the result must be that `npm run release` ships
  them.)*
- macOS builds are arm64 only, like today. The existing `xattr -cr` install step also
  clears quarantine on the bundled binaries.
- Cost accepted by the owner: roughly +100 MB per download and update.

## 7. Architecture fit (HiggTable conventions, see CLAUDE.md)

- Main process: probing, planning, spawning ffmpeg, temp/rename handling, progress
  events. New IPC: probe/plan/render/cancel plus a progress event channel. Bridge
  entries in `preload.js`.
- Pure module `renderer/resize-plan.js` (or main-side equivalent), Jest-tested, for
  the parts that are pure: output sizes, layer geometry per preset (including the 1x1
  special case), output names (ratio vs custom pixels), filter-graph string, encoder
  choice, progress parsing. The spike values (section 4) become test expectations.
- Renderer: the Resize button in `#bulk-actions-bar`, the dialog, and the run state.
- Logging to `higgtable.log`: the per-task command summary, timings, and failures (the
  last stderr lines).

## 8. Left to the builder

- Exact dialog styling (follow the existing modals and the mockup in
  `.superpowers/brainstorm/…/resize-dialog.html`).
- Whether the vignette runs on the small or the full-size blurred copy (identical
  result required).
- How the binaries get into the repo or build (section 6).
- Windows process-kill details.
- Verification: compare a resize of PL_7456 and OL_14835 against the existing After
  Effects files (frame grab side by side + background brightness), as in the spike.
