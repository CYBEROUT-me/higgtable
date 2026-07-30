# Google Drive account-index link rewriting

## Problem

Description-field links to Google Drive (e.g.
`https://drive.google.com/drive/search?q=parent:FOLDER_ID%20title:X`) open
using whatever Google account the OS default browser currently has active.
When the user (or a teammate whose data flows into the same Airtable base)
has multiple Google accounts signed in, that's frequently the wrong one —
the account that actually has access to a given shared Drive folder is a
specific, known account, not whichever one the browser happens to default
to.

## Goals

- Google Drive links open with a specific Google account by inserting a
  `/u/<N>/` segment into the URL before opening — e.g.
  `.../drive/search?q=...` → `.../drive/u/2/search?q=...`.
- `<N>` is a single value configured once in Settings, not per-link or
  per-click.
- Applies to any `drive.google.com/drive/...` link (search, folders,
  my-drive, etc.) that doesn't already specify its own `/u/N/` — a link
  that already has one (presumably intentional) is left untouched.
- Before the setting is ever configured (blank), links open exactly as
  written — no rewriting.

## Non-goals

- No support for other Google Workspace domains (docs.google.com,
  sheets.google.com, etc.) — `drive.google.com` only, per what was actually
  requested.
- No per-link override UI — one global setting, applied uniformly.
- No changes to `renderer/markdown-data.js`'s rendering pipeline — the
  `href` shown/hovered is the original, unrewritten URL; rewriting happens
  only at the moment a link is actually opened (see Design).

## Design

### Rewriting (`renderer/drive-links.js`, new pure module)

`rewriteDriveLink(url, accountIndex)`: returns `url` unchanged unless
`accountIndex` (after `String(...).trim()`) matches `/^\d+$/` — this makes
`0` a valid, distinct choice from blank/unset, while any non-numeric or
empty value is a no-op. When valid, matches
`^(https:\/\/drive\.google\.com\/drive\/)(?!u\/\d+\/)(.*)$` — the negative
lookahead means a URL that already has its own `/u/N/` segment right after
`/drive/` doesn't match at all, so it's returned unchanged — and inserts
`u/<accountIndex>/` between the two captured groups.

### Where rewriting happens (`renderer/app.js`)

Not in `renderMarkdownLite`'s render pipeline — the displayed/hovered
`href` stays exactly as written in the source text. Instead,
`buildMarkdownField`'s existing link-click handler (which already calls
`window.app.openExternal(link.href)`) becomes
`window.app.openExternal(rewriteDriveLink(link.href, state.driveAccountIndex))`.
Rewriting at click time (not render time) means changing the setting takes
effect immediately for already-rendered previews, with no re-render needed.

### Settings (`renderer/index.html`, `renderer/app.js`)

A new number input in `#settings-modal`, next to the existing Working
Directory field: `<input type="number" id="drive-account-index-input" min="0" placeholder="e.g. 2">`.
Following the precedent set by the working-directory field (not the
API-key Save button, which requires re-entering the key every time and
triggers a full `init()` re-fetch) — this field saves immediately on
`change` via its own `window.app.saveSettings({ driveAccountIndex: ... })`
call and updates `state.driveAccountIndex`, independent of the main Save
button. `state.driveAccountIndex` is initialized from `getSettings()` in
`boot()`, alongside the existing `state.workingDirectory` initialization,
and the input is populated from it in `showSettingsModal()`. Persisted as a
plain string in `settings.json` (via the existing shallow-merging
`save-settings` IPC handler — no changes needed there).

## Testing

`rewriteDriveLink` is a pure function — full Jest coverage in a new
`tests/drive-links.test.js`: rewrites a bare search URL; leaves a URL that
already has `/u/5/` untouched; leaves a non-Drive URL untouched; treats
blank/non-numeric `accountIndex` as "no rewriting" (including explicitly
verifying `0` **does** rewrite, since it's falsy in JS but a valid,
distinct-from-unset setting). The Settings UI wiring and click-time
integration are manual-verification-only, consistent with how the rest of
`buildMarkdownField`/the settings modal are verified today.
