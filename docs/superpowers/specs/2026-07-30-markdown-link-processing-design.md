# Markdown-lite link processing

## Problem

The record detail modal's long-text fields (Description, etc.) render through
`renderMarkdownLite()` (`renderer/app.js:1203-1209`), which only handles
`**bold**` and `\n` → `<br>`. Bare URLs pasted into these fields (e.g. a
Google Drive share link wrapped in parentheses) sit as inert plain text —
not clickable.

## Goals

- Bare `http(s)://` URLs inside the markdown-lite preview render as
  clickable links.
- Clicking a link opens it in the user's default OS browser, not inside the
  Electron app's own window.
- Visually consistent with the app's existing accent-colored link styling.

## Non-goals

- Dedicated URL-type fields (`Creative Link`, `Figma/Canvas link`,
  `Preview`) stay as plain editable text inputs — confirmed out of scope for
  this pass; they're a separate, already-existing gap.
- No markdown-style `[label](url)` link syntax — only bare URLs, matching
  what's actually written in these fields today.
- Not a full markdown/autolink library — a single-character trailing-
  punctuation trim (see Design) is a known simplification; a URL that
  legitimately ends in a closing paren as its very last character (rare) may
  have it trimmed into plain text alongside the link. Acceptable given
  `renderMarkdownLite`'s existing "lite, not a full library" scope.

## Design

### Linkification (`renderer/app.js`)

Add a step to `renderMarkdownLite(text)`, before the existing bold/newline
replacements (so it operates on plain escaped text, not on the `<strong>`
tags those steps introduce): find `https?:\/\/[^\s<]+` matches, and for
each, strip trailing punctuation characters (from
`` )].,;:!?}'" `` — a single pass, not a balanced-parenthesis parser) into
a separate trailing-text fragment, then wrap the remainder in
`<a href="URL" class="record-markdown-link">URL</a>` followed by that
trailing fragment as plain text. This is exactly what handles the reported
case: `(https://drive.google.com/.../sharing)` becomes a link ending at
`sharing`, with the closing `)` left outside the tag as plain text.

### Opening the link (`preload.js`, `main.js`, `renderer/app.js`)

A plain `<a href>` click in this Electron renderer would attempt to
navigate the app's own `BrowserWindow` to that URL rather than open the OS
browser — not what's wanted, and this app has no existing `will-navigate`
interception to prevent that. Rather than add window-level navigation
interception (broader than this feature needs), the link keeps a real
`href` (so hover/cursor affordance still works) but a click handler
intercepts it directly:

- `preload.js` gains `openExternal: (url) => ipcRenderer.invoke('open-external', url)`,
  added to the existing `contextBridge.exposeInMainWorld('app', {...})`
  block alongside the other `window.app.*` methods.
- `main.js` gains `ipcMain.handle('open-external', (_e, url) => {...})`,
  validating `url` starts with `http://` or `https://` before calling the
  already-imported `shell.openExternal(url)` — anything else is silently
  ignored, since this processes arbitrary user/Airtable-authored text, not
  a trusted internal value.
- In `buildMarkdownField()` (`renderer/app.js:1214-1252`), the `preview`
  element's click handler checks `event.target.closest('a.record-markdown-link')`
  first: if found, `preventDefault()` + `stopPropagation()`, call
  `window.app.openExternal(anchor.href)`, and return — skipping the
  existing "click preview to edit" behavior for that click. Clicking
  anywhere else in the preview still opens the textarea editor as today.

### Styling

`.record-markdown-link { color: var(--accent); text-decoration: underline; cursor: pointer; }`
in `renderer/styles.css`, matching the existing accent-colored link
treatment (`#drop-zone button`'s link-like styling).

## Testing

Manual only, consistent with how `buildMarkdownField`/`renderMarkdownLite`
are verified today (no existing test coverage for this DOM-rendering
layer). Verify: a Description field containing
`(https://drive.google.com/file/d/XYZ/view?usp=sharing)` renders a clickable
link ending at `sharing` with the `)` outside it; clicking the link opens
the OS default browser, not the app window; clicking elsewhere in the
preview still opens the edit textarea; a field with no URL renders
unchanged.
