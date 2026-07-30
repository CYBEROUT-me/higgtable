// renderer/markdown-data.js
// Pure markdown-lite rendering for long text fields (Description, etc.):
// HTML-escaping, bare-URL linkification, **bold**, and line breaks. No DOM
// access here — mirrors the canvas-data.js / notifications-data.js /
// dashboard-data.js split so this can run under plain Jest.

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Strips a backslash immediately before any character, e.g. "\_" -> "_" —
// undoes markdown-style backslash-escaping so labels display cleanly.
function unescapeBackslashes(text) {
  return text.replace(/\\(.)/g, '$1');
}

// Converts [label](url) into a link with `label` as its visible text —
// any whitespace (including a newline) between the closing `]` and the
// opening `(` counts, matching how these fields are actually written (not
// just true-adjacent Markdown syntax). Operates on already-escaped `html`,
// same as linkifyUrls below. Must run BEFORE linkifyUrls, since linkifyUrls
// is guarded against re-wrapping a URL already inside an href attribute —
// see the note on its regex below.
function linkifyMarkdownLinks(html) {
  return html.replace(/\[([^\[\]]+)\]\s*\(\s*(https?:\/\/[^\s()]+)\s*\)/g, (match, label, url) => {
    return `<a href="${url}" class="record-markdown-link">${unescapeBackslashes(label)}</a>`;
  });
}

// Wraps bare http(s) URLs in already-escaped `html` with a clickable
// anchor, trimming trailing punctuation (common when a URL is wrapped in
// parens or ends a sentence) out of the link so it isn't swallowed into
// the href. A single-pass strip, not a balanced-parenthesis parser — see
// the design doc's Non-goals for the known trade-off.
function linkifyUrls(html) {
  return html.replace(/(?<!href=")https?:\/\/[^\s<]+/g, (match) => {
    let url = match;
    let trailing = '';
    while (url.length && /[).,;:!?\]}'"]$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    return `<a href="${url}" class="record-markdown-link">${url}</a>${trailing}`;
  });
}

// Minimal markdown-lite renderer for long text fields (Description, etc.) —
// HTML-escaping, bare-URL links, **bold**, and line breaks, matching how
// these fields are actually written in Airtable, without pulling in a full
// markdown library.
function renderMarkdownLite(text) {
  return linkifyUrls(linkifyMarkdownLinks(escapeHtml(text)))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtml, linkifyUrls, renderMarkdownLite, unescapeBackslashes, linkifyMarkdownLinks };
}
