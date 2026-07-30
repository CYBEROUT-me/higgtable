# Markdown-lite labeled link support

## Problem

The just-shipped bare-URL linkification (`renderer/markdown-data.js`,
[[2026-07-30-markdown-link-processing-design]]) renders a raw URL as its own
link text. Real Description content, however, is often written as an actual
`[label](url)` markdown link — just with a line break between the `]` and
`(` instead of sitting adjacent, e.g.:

```
[TikTok One\_0486\_LO\_US\_Campaign\_30\_12\_24]
(https://drive.google.com/file/d/1NY2dRsYc-.../view?usp=sharing)
```

Today this renders as a bracketed label followed by a bare-URL link — the
label is never associated with the link, and the link text is the full raw
URL instead of the (much more readable) label.

## Goals

- `[label](url)` renders as a single link whose visible text is `label`,
  not the URL — whether the label and URL sit immediately adjacent (true
  Markdown syntax) or are separated by any whitespace, including the
  newline shown above.
- The label's backslash-escapes (e.g. `\_`) are stripped for display, so
  the link reads "TikTok One_0486_LO_US_Campaign_30_12_24", not with
  literal backslashes.
- Bare URLs not part of a `[label](url)` construct still linkify exactly as
  today (raw URL as link text) — this is additive, not a replacement.

## Non-goals

- No other Markdown link variants (reference-style `[label][ref]`, titled
  links `[label](url "title")`) — only the plain `[label](url)` form,
  matching what's actually written in these fields.
- Backslash-unescaping applies only to the extracted label text, not
  anywhere else in the rendered text — a broader "unescape everywhere"
  pass is a separate, unrequested concern.

## Design

### Matching (`renderer/markdown-data.js`)

Add `linkifyMarkdownLinks(html)`, operating on already-`escapeHtml`'d text
(run before the existing `linkifyUrls`): matches
`\[([^\[\]]+)\]\s*\(\s*(https?:\/\/[^\s()]+)\s*\)` — group 1 is the label
(anything but brackets), `\s*` between `]` and `(` allows zero-or-more
whitespace characters of any kind (spaces, newlines), group 2 is the URL.
Each match becomes `<a href="URL" class="record-markdown-link">LABEL</a>`,
with `LABEL` passed through a small `unescapeBackslashes(text)` helper
(`text.replace(/\\(.)/g, '$1')` — any backslash followed by one character
becomes just that character) before insertion.

### Avoiding double-linkification of the same URL

`linkifyMarkdownLinks` runs before the existing `linkifyUrls`. Its output
places the raw URL inside an `href="..."` attribute — `linkifyUrls`'s
`https?:\/\/[^\s<]+` pattern would otherwise match that same URL text
again and wrap it in a second, nested/malformed anchor. `linkifyUrls`'s
regex gains a negative lookbehind, `(?<!href=")`, so it skips a match that
starts immediately after `href="` — precisely the shape
`linkifyMarkdownLinks` just produced, without needing any other
coordination between the two functions.

### Pipeline order (`renderMarkdownLite`)

```
escapeHtml(text) → linkifyMarkdownLinks(...) → linkifyUrls(...) → **bold** → \n→<br>
```

Bare URLs not consumed by the `[label](url)` pass still linkify exactly as
before (raw URL as link text) — unchanged behavior for that case.

## Testing

Extends the existing `tests/markdown-data.test.js` (no new test file):
`[label](url)` with a newline between them (the reported case) produces a
link with the label as text and backslashes stripped; the same with zero
whitespace (true adjacent Markdown syntax) also works; a bare URL elsewhere
in the same text still linkifies with the URL as its own text, without
being double-wrapped; a bare URL with no label construct anywhere is
unaffected (regression check against the existing test).
