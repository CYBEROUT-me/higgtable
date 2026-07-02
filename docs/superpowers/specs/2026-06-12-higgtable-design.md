# HiggTable — Design Spec
_2026-06-12_

## Overview

A macOS desktop app (Electron + Node.js) that connects to an Airtable workspace, lets each user pick their personal table, selects media files, and bulk-renames them using task names from Airtable — with aspect ratio auto-detected from the file.

---

## Architecture

- **Electron** — wraps Node.js, packages to a `.app` via `electron-builder`
- **Renderer** — plain HTML/CSS/JS (no framework)
- **Main process** — handles Airtable API calls (via `node-fetch` or built-in `fetch`), file system renaming
- **Config** — `config.js` in project root; stores API key and user's saved table preferences
- **Airtable API** — REST (`https://api.airtable.com/v0/`)

---

## Data Model (Airtable)

One workspace, 3 databases (bases). Each base has multiple tables, one per "person/role" (e.g., `Prince (PRI)`, `Twitch (TWI)`, etc.).

Each task record has a name like:
```
PL_5531_5531_М129_S757_EN_usr_NIN_PRI_Video_NEW_9x16
```
The last segment is the aspect ratio: `9x16`, `16x9`, or `1x1`. The rest is the "base name" shared across 3 variants.

---

## Phases

### Phase 1 — Explorer (build first)
Goal: see what data is actually in Airtable before finalising the UI.

- Connect with API key
- List all bases in the workspace
- Click a base → list its tables
- Click a table → show all records as a plain HTML table (all fields)
- This phase is throwaway scaffolding, used to understand the data shape

### Phase 2 — Full Workflow (built after Phase 1 exploration)

**Screen layout:**

```
┌──────────────────────────────────────────────────────┐
│  [Base A ▾]  [Base B ▾]  [Base C ▾]   (table pickers)│
├──────────────────────────────────────────────────────┤
│  Task: [search & pick one task from list        ▾]   │
├──────────────────────────────────────────────────────┤
│  [ Drop files here / Browse ]                        │
│                                                      │
│  higgsfield_314212.mp4   1920×1080  →  _16x9.mp4     │
│  higgsfield_314213.mp4   1080×1920  →  _9x16.mp4     │
│  higgsfield_314214.jpg   1080×1080  →  _1x1.jpg      │
│                                                      │
│  [ Rename Files ]                                    │
└──────────────────────────────────────────────────────┘
```

**Renaming logic:**
1. User selects files (drag-drop or file picker)
2. App detects aspect ratio of each file (video: via ffprobe or file metadata; image: via native sharp/jimp)
3. User picks ONE task from the searchable list (any aspect ratio variant — anchor)
4. App strips the trailing `_9x16` / `_16x9` / `_1x1` from the task name to get the base name
5. Preview updates in real time: each file row shows its detected ratio and resulting name
6. User clicks Rename — files renamed in-place, original extension preserved

**Example:**
- `higgsfield_314212.mp4` (1920×1080, 16x9) → `PL_5531_5531_М129_S757_EN_usr_NIN_PRI_Video_NEW_16x9.mp4`
- `higgsfield_314213.mp4` (1080×1920, 9x16) → `PL_5531_5531_М129_S757_EN_usr_NIN_PRI_Video_NEW_9x16.mp4`
- `higgsfield_314214.jpg` (1080×1080, 1x1)  → `PL_5531_5531_М129_S757_EN_usr_NIN_PRI_Video_NEW_1x1.jpg`

**User preferences (persisted):**
- Per-base table selection saved to `config.js` so user doesn't re-pick every session

---

## File Renaming Safety
- Show a preview of old → new names before executing
- Rename is non-destructive (only renames, no copy/move)
- If a target filename already exists, show a warning and skip (don't overwrite)

---

## Packaging
- `electron-builder` → `dist/HiggTable.app`
- macOS only target
- No auto-update needed (in-house, manual distribution)

---

## Out of Scope (for now)
- Writing back to Airtable (status updates, etc.)
- Multi-user sync
- Windows/Linux builds
- Pagination (load all records for now)
