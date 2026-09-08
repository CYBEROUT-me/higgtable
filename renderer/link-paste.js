// renderer/link-paste.js
// Pure parsing and pairing for "paste a list of links into Autofill": turning a
// pasted blob into an ordered link list, and pairing it with the selected tasks
// sorted by name. No DOM, no IO — runs under Jest.

// Entries are separated by commas, newlines or spaces, because that is how a
// list copied out of Drive or a chat message actually arrives.
const SEPARATORS = /[\s,]+/;

// Links are kept EXACTLY as pasted — "?usp=drive_link" and all. Rewriting a
// link the user gave us risks turning a working URL into a broken one, and the
// review list shows precisely what will be written.
function parseLinkList(text) {
  const links = [];
  const invalid = [];
  const duplicates = [];
  const seen = new Set();

  for (const raw of String(text || '').split(SEPARATORS)) {
    const entry = raw.trim();
    if (!entry) continue;
    if (!/^https?:\/\/\S+$/i.test(entry)) { invalid.push(entry); continue; }
    if (seen.has(entry)) {
      if (!duplicates.includes(entry)) duplicates.push(entry);
      continue;
    }
    seen.add(entry);
    links.push(entry);
  }
  return { links, invalid, duplicates };
}

// Names are "CODE_1234_..." so a plain text sort would put CMC_1000 before
// CMC_999. Numeric-aware comparison matches what "sorted by name" means here.
function compareByName(a, b) {
  return String((a && a.name) || '').localeCompare(
    String((b && b.name) || ''), undefined, { numeric: true, sensitivity: 'base' },
  );
}

// Google Drive does not hand back a shift-selection's links in display order.
// Observed 2026-09-08: selecting five folders whose names sort
//   13999, 14000, 14001, 14002, 14003
// copied links in the order
//   13999, 14003, 14000, 14001, 14002
// i.e. the ANCHOR you clicked, then the TARGET you shift-clicked, then the
// range fill in order. This undoes that so positional pairing lines up again:
// output[0] takes the first link, output[last] the second, and everything
// between shifts down by one.
//
// This is a single observation, not a documented guarantee, which is why the UI
// exposes it as a switch whose effect is visible before anything is written
// rather than applying it silently.
function reorderFromDriveSelection(links) {
  const l = [...(links || [])];
  if (l.length < 3) return l;           // nothing to undo for one or two links
  const out = new Array(l.length);
  out[0] = l[0];                        // anchor
  out[l.length - 1] = l[1];             // shift-clicked target
  for (let i = 1; i < l.length - 1; i++) out[i] = l[i + 1];
  return out;
}

// Pairs the Nth link with the Nth task, tasks ascending by name.
//
// Tasks that already hold a link STAY in the ordering and still consume their
// link: dropping them would shift every later pairing, silently sending links to
// the wrong tasks. They come back marked `hasExisting` so the caller can leave
// them unticked instead.
function pairLinksToTasks(tasks, links) {
  const ordered = [...(tasks || [])].sort(compareByName);
  const list = links || [];
  const pairs = [];
  const tasksWithoutLink = [];

  ordered.forEach((task, i) => {
    const link = list[i];
    const existing = String((task && task.existingLink) || '').trim();
    if (link === undefined) {
      tasksWithoutLink.push(task);
      return;
    }
    pairs.push({ task, link, hasExisting: Boolean(existing), existingLink: existing });
  });

  return {
    pairs,
    tasksWithoutLink,
    unusedLinks: list.slice(ordered.length),
  };
}

// One-line summary of a pairing's problems, or null when it is clean.
function describeMismatch({ pairs, tasksWithoutLink, unusedLinks }, { invalid = [], duplicates = [] } = {}) {
  const notes = [];
  if (tasksWithoutLink.length) notes.push(`${tasksWithoutLink.length} task(s) have no link`);
  if (unusedLinks.length) notes.push(`${unusedLinks.length} link(s) left over`);
  if (invalid.length) notes.push(`${invalid.length} entr(y/ies) are not URLs`);
  if (duplicates.length) notes.push(`${duplicates.length} duplicate link(s) ignored`);
  if (!notes.length) return null;
  return `${pairs.length} paired — ${notes.join(', ')}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseLinkList, compareByName, pairLinksToTasks, describeMismatch,
    reorderFromDriveSelection,
  };
}
