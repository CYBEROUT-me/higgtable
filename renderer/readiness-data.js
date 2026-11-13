// renderer/readiness-data.js
// Pure "is this task ready to hand in?" logic for the step bar, the Ready
// column and the side panel. No DOM, no IO: the files come from an index of the
// working directory built by main.js (`index-task-files`), the fields from the
// task's Airtable record.

// Video deliveries every task needs, in the order they are listed.
const READY_VIDEO_SIZES = ['9x16', '1x1', '4x5', '16x9'];
const READY_LIMIT_BYTES = 32000000; // same as resize-plan.js MAX_DELIVERY_BYTES
const HANDED_IN_STATUSES = ['To accept', 'Done'];

// `entries` is what `index-task-files` returns: [[lowercased name, bytes, path]].
function buildFileIndex(entries) {
  const index = new Map();
  (entries || []).forEach(([name, bytes, path]) => {
    if (!index.has(name)) index.set(name, { bytes, path });
  });
  return index;
}

function isStatTask(rec) {
  return (rec.fields['Format'] || '') === 'Stat';
}

// What the working directory holds for one task: each standard video with its
// size (null when missing), and the 1x1 preview image Autofill uploads.
function taskFiles(base, index) {
  const lower = base.toLowerCase();
  const videos = READY_VIDEO_SIZES.map(label => {
    const hit = index.get(`${lower}_${label}.mp4`);
    return { label, bytes: hit ? hit.bytes : null, path: hit ? hit.path : null };
  });
  const preview = ['png', 'jpg', 'jpeg'].map(ext => index.get(`${lower}_1x1.${ext}`)).find(Boolean) || null;
  return { videos, preview };
}

function hasValue(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  return String(v).trim() !== '' && v !== 0;
}

// Checklist for one task. Each item: { key, label, done, step }, where step is
// the step-bar action that fixes it ('resize' | 'compress' | 'autofill').
// A task already handed in (To accept / Done) counts as ready.
function taskReadiness(rec, files, fieldNames) {
  const f = rec.fields;
  const handedIn = HANDED_IN_STATUSES.includes(f['Status'] || '');
  const items = [];
  if (!isStatTask(rec)) {
    const missing = files.videos.filter(v => v.bytes == null).map(v => v.label);
    const over = files.videos.filter(v => v.bytes != null && v.bytes > READY_LIMIT_BYTES).map(v => v.label);
    items.push({ key: 'sizes', label: missing.length ? `no ${missing.join(', ')}` : 'all sizes', done: !missing.length, step: 'resize' });
    items.push({ key: 'limit', label: over.length ? `${over.join(', ')} over 32 MB` : 'under 32 MB', done: !over.length, step: 'compress' });
    items.push({ key: 'timing', label: 'Timing', done: hasValue(f['Timing']), step: 'autofill' });
    items.push({ key: 'link', label: 'Creative Link', done: hasValue(f[fieldNames.creativeLink]), step: 'autofill' });
  } else {
    items.push({ key: 'figma', label: 'Figma/Canvas link', done: hasValue(f[fieldNames.figmaLink]), step: 'autofill' });
  }
  items.push({ key: 'preview', label: 'Preview', done: hasValue(f['Preview']), step: 'autofill' });
  items.push({ key: 'hours', label: 'Hours', done: hasValue(f['Hours']), step: 'autofill' });
  const missing = items.filter(i => !i.done);
  return { handedIn, items, missing, ready: handedIn || !missing.length };
}

// Short text for the Ready column.
function readinessLabel(r) {
  if (r.handedIn) return 'handed in';
  if (r.ready) return 'ready';
  return r.missing.length === 1 ? r.missing[0].label : `${r.missing.length} left`;
}

// Step-bar summary for the selection. `list` is taskReadiness results.
// Returns per step how many tasks still need it, and the first step with work
// (the one to highlight); 'accept' once everything is filled.
function stepSummary(list) {
  const open = list.filter(r => !r.handedIn);
  const need = step => open.filter(r => r.missing.some(i => i.step === step)).length;
  const fieldsMissing = {};
  open.forEach(r => r.missing.filter(i => i.step === 'autofill').forEach(i => {
    fieldsMissing[i.label] = (fieldsMissing[i.label] || 0) + 1;
  }));
  const summary = {
    total: list.length,
    resize: need('resize'),
    compress: need('compress'),
    autofill: need('autofill'),
    autofillFields: Object.keys(fieldsMissing),
    accept: open.length,
  };
  summary.next = summary.resize ? 'resize' : summary.compress ? 'compress' : summary.autofill ? 'autofill'
    : summary.accept ? 'accept' : null;
  return summary;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    READY_VIDEO_SIZES, READY_LIMIT_BYTES, buildFileIndex, isStatTask, taskFiles, taskReadiness,
    readinessLabel, stepSummary,
  };
}
