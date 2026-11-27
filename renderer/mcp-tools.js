// renderer/mcp-tools.js
// Pure answers for HiggTable's read-only MCP server (mcp-server.js): turns the
// cached Airtable records into short text for Claude. No DOM, no IO. Unlike the
// other pure modules this one is never loaded by index.html; it runs only under
// Node (the server, started by Claude Desktop, and Jest).
//
// Shapes:
//   Source = { tableName: 'VCP Creatives', syncedAt: <ms>, records: [{ id, createdTime?, fields }] }
//   ctx    = { sources: Source[], defaultDesigner: string, now: Date }
// Every tool returns { text, isError }.

const { searchTasks, normalizeForSearch, compareTaskNames, MIN_QUERY_LENGTH } = require('./task-search.js');
const { briefFromDescription } = require('./markdown-data.js');
const { resolveFieldName } = require('./task-refs.js');
const { computeWorkload, WORKLOAD_STATUSES } = require('./workload-data.js');

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const OPEN_STATUSES = ['Rework', 'Ready for Design', 'In work'];
const FIND_LIMIT_DEFAULT = 20;
const FIND_LIMIT_MAX = 50;
const SEVERAL_SHOWN = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NO_CACHE_TEXT = 'No HiggTable data found. Open HiggTable once and let it load the tables.';
const RECORD_ID_PATTERN = /^rec[A-Za-z0-9]{14}$/;

function shortTableName(tableName) {
  return String(tableName || '').replace(/ Creatives$/, '');
}

const pad2 = n => String(n).padStart(2, '0');

// "27 Nov 14:32", local time.
function formatSyncTime(ms) {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function freshnessText(sources, now) {
  if (!sources || !sources.length) return NO_CACHE_TEXT;
  const synced = sources.map(s => `${shortTableName(s.tableName)} synced ${formatSyncTime(s.syncedAt)}`);
  const lines = [`From HiggTable · ${synced.join(', ')}`];
  sources.forEach(s => {
    const age = now.getTime() - s.syncedAt;
    if (age <= STALE_AFTER_MS) return;
    const days = Math.floor(age / DAY_MS);
    lines.push(`${shortTableName(s.tableName)} was last synced ${days} day${days === 1 ? '' : 's'} ago; open HiggTable to refresh it.`);
  });
  return lines.join('\n');
}

// Whole days from today to a "YYYY-MM-DD" deadline (negative = overdue), or null.
function daysUntil(deadline, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(deadline || ''));
  if (!m) return null;
  const due = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / DAY_MS);
}

function relativeDays(days) {
  if (days === 0) return 'today';
  const n = Math.abs(days);
  const unit = `${n} day${n === 1 ? '' : 's'}`;
  return days > 0 ? `in ${unit}` : `${unit} late`;
}

// Handed-in tasks keep their date but are never "late".
const FINISHED_STATUSES = ['To accept', 'Done'];

function dueText(deadline, now, status) {
  const days = daysUntil(deadline, now);
  if (days === null) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(deadline);
  const date = `due ${+m[3]} ${MONTHS[+m[2] - 1]}`;
  return FINISHED_STATUSES.includes(status) ? date : `${date} (${relativeDays(days)})`;
}

function taskLine(rec, tableName, now) {
  const f = rec.fields || {};
  return [f.Name, f.Status, f.DES, dueText(f.Deadline, now, f.Status), f.Priority, shortTableName(tableName)]
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .join(' · ');
}

const normalizeName = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// One display name per person: DES options are per table, so the same designer
// can be spelled "Olena" in one table and "olena " in another. The most common
// spelling wins.
function knownDesigners(sources) {
  const counts = new Map(); // normalized -> Map(spelling -> count)
  sources.forEach(s => s.records.forEach(r => {
    const des = String(r.fields.DES || '').trim();
    if (!des) return;
    const key = normalizeName(des);
    const spellings = counts.get(key) || new Map();
    spellings.set(des, (spellings.get(des) || 0) + 1);
    counts.set(key, spellings);
  }));
  return [...counts.values()]
    .map(spellings => [...spellings.entries()].sort((a, b) => b[1] - a[1])[0][0])
    .sort((a, b) => a.localeCompare(b));
}

function resolveDesigner(sources, name) {
  const known = knownDesigners(sources);
  const wanted = normalizeName(name);
  const hit = known.find(n => normalizeName(n) === wanted);
  if (hit) return { name: hit };
  return { error: `Unknown designer "${String(name || '').trim()}". Known designers: ${known.join(', ')}.` };
}

const isDesigner = (rec, name) => normalizeName(rec.fields.DES) === normalizeName(name);

// The sources a `table` argument selects: all of them when empty.
function selectSources(sources, table) {
  if (!table || !String(table).trim()) return { sources };
  const wanted = String(table).trim().toLowerCase();
  const hit = sources.filter(s =>
    shortTableName(s.tableName).toLowerCase() === wanted || String(s.tableName).toLowerCase() === wanted);
  if (hit.length) return { sources: hit };
  const names = sources.map(s => shortTableName(s.tableName)).sort((a, b) => a.localeCompare(b));
  return { error: `Unknown table "${String(table).trim()}". Tables: ${names.join(', ')}.` };
}

// One entry per named record, in source order: { id, name, table, rec }.
function flatten(sources) {
  const out = [];
  sources.forEach(s => s.records.forEach(r => {
    const name = String((r.fields && r.fields.Name) || '').trim();
    if (name) out.push({ id: r.id, name, table: s.tableName, rec: r });
  }));
  return out;
}

const result = (text, isError = false) => ({ text, isError });

function findTasks(ctx, { query, table, status, designer, limit } = {}) {
  const { sources, now } = ctx;
  if (!sources.length) return result(NO_CACHE_TEXT);
  const q = normalizeForSearch(query);
  if (q.length < MIN_QUERY_LENGTH) {
    return result(`The search needs at least ${MIN_QUERY_LENGTH} characters: a task name, a number like LO_15945, or words from the brief.`, true);
  }
  const picked = selectSources(sources, table);
  if (picked.error) return result(picked.error, true);
  let des = null;
  if (designer && String(designer).trim()) {
    const d = resolveDesigner(sources, designer);
    if (d.error) return result(d.error, true);
    des = d.name;
  }
  const max = Math.min(Math.max(1, Number(limit) || FIND_LIMIT_DEFAULT), FIND_LIMIT_MAX);
  const wantedStatus = status && String(status).trim() ? normalizeName(status) : null;
  const keep = t => (!des || isDesigner(t.rec, des))
    && (!wantedStatus || normalizeName(t.rec.fields.Status) === wantedStatus);

  const flat = flatten(picked.sources);
  const nameHits = searchTasks(query, flat, { limit: Infinity }).filter(keep).slice(0, max);
  const hitIds = new Set(nameHits.map(t => t.id));
  const briefHits = flat
    .map((t, index) => ({ t, index }))
    .filter(({ t }) => !hitIds.has(t.id) && keep(t)
      && normalizeForSearch(briefFromDescription(t.rec.fields.Description)).includes(q))
    .sort((a, b) => String(b.t.rec.createdTime || '').localeCompare(String(a.t.rec.createdTime || '')) || a.index - b.index)
    .slice(0, max - nameHits.length)
    .map(({ t }) => t);

  const parts = [];
  if (nameHits.length) parts.push(nameHits.map(t => taskLine(t.rec, t.table, now)).join('\n'));
  if (briefHits.length) parts.push(`Brief mentions it:\n${briefHits.map(t => taskLine(t.rec, t.table, now)).join('\n')}`);
  if (!parts.length) parts.push(`No tasks match "${String(query).trim()}".`);
  parts.push(freshnessText(sources, now));
  return result(parts.join('\n\n'));
}

function linkFields(source) {
  const keys = new Set();
  source.records.forEach(r => Object.keys(r.fields || {}).forEach(k => keys.add(k)));
  const names = [...keys];
  return {
    creative: resolveFieldName(names, 'Creative Link'),
    figma: resolveFieldName(names, 'Figma/Canvas link') || names.find(n => /^fig/i.test(n) && /link/i.test(n)) || null,
    ref: resolveFieldName(names, 'REF'),
  };
}

const httpLink = v => (/^https?:\/\//i.test(String(v || '').trim()) ? String(v).trim() : '');

function taskDetails(t, sources, now) {
  const f = t.rec.fields;
  const source = sources.find(s => s.tableName === t.table);
  const links = linkFields(source);
  const days = daysUntil(f.Deadline, now);
  const rows = [
    ['Table', shortTableName(t.table)],
    ['Status', f.Status],
    ['Designer', f.DES],
    ['Priority', f.Priority],
    ['Deadline', f.Deadline ? `${f.Deadline}${days === null || FINISHED_STATUSES.includes(f.Status) ? '' : ` (${relativeDays(days)})`}` : ''],
    ['Type', f.Type],
    ['Format', f.Format],
    ['Project', f.Project],
    ['Date', f.Date],
    ['Date Done', f['Date Done']],
    ['Hours', f.Hours],
    ['Timing', f.Timing],
    ['Old ID', f['Old ID']],
    ['New ID', f['New ID']],
    ['Creative Link', links.creative && httpLink(f[links.creative])],
    ['Figma', links.figma && httpLink(f[links.figma])],
    ['REF', links.ref && httpLink(f[links.ref])],
  ].filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '');
  const brief = briefFromDescription(f.Description);
  return [
    t.name,
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    `Brief:\n${brief || '(no brief)'}`,
    '',
    freshnessText(sources, now),
  ].join('\n');
}

function getTask(ctx, { task } = {}) {
  const { sources, now } = ctx;
  if (!sources.length) return result(NO_CACHE_TEXT);
  const wanted = String(task || '').trim();
  const flat = flatten(sources);
  let hit = null;
  if (RECORD_ID_PATTERN.test(wanted)) hit = flat.find(t => t.id === wanted) || null;
  if (!hit) hit = flat.find(t => normalizeForSearch(t.name) === normalizeForSearch(wanted)) || null;
  if (hit) return result(taskDetails(hit, sources, now));

  const matches = searchTasks(wanted, flat, { limit: Infinity });
  if (matches.length === 1) return result(taskDetails(matches[0], sources, now));
  if (!matches.length) return result(`No task matches "${wanted}".\n\n${freshnessText(sources, now)}`, true);
  const shown = matches.slice(0, SEVERAL_SHOWN).map(t => taskLine(t.rec, t.table, now));
  if (matches.length > SEVERAL_SHOWN) shown.push(`…and ${matches.length - SEVERAL_SHOWN} more`);
  return result(`Several tasks match "${wanted}". Ask for one by its full name:\n${shown.join('\n')}\n\n${freshnessText(sources, now)}`);
}

function myTasks(ctx, { designer } = {}) {
  const { sources, now, defaultDesigner } = ctx;
  if (!sources.length) return result(NO_CACHE_TEXT);
  const asked = designer && String(designer).trim() ? designer : defaultDesigner;
  if (!asked || !String(asked).trim()) {
    return result(`No designer given, and none is set in HiggTable's Settings → Claude → "I am". Known designers: ${knownDesigners(sources).join(', ')}.`, true);
  }
  const d = resolveDesigner(sources, asked);
  if (d.error) return result(d.error, true);
  const open = flatten(sources).filter(t =>
    isDesigner(t.rec, d.name) && OPEN_STATUSES.includes(t.rec.fields.Status));
  const rank = t => { const n = daysUntil(t.rec.fields.Deadline, now); return n === null ? Infinity : n; };
  open.sort((a, b) => (rank(a) - rank(b)) || compareTaskNames(a.name, b.name));
  const body = open.length
    ? `Open tasks for ${d.name} (${OPEN_STATUSES.join(', ')}):\n${open.map(t => taskLine(t.rec, t.table, now)).join('\n')}`
    : `${d.name} has no open tasks (${OPEN_STATUSES.join(', ')}).`;
  return result(`${body}\n\n${freshnessText(sources, now)}`);
}

function workload(ctx, { table, product } = {}) {
  const { sources, now } = ctx;
  if (!sources.length) return result(NO_CACHE_TEXT);
  const picked = selectSources(sources, table);
  if (picked.error) return result(picked.error, true);
  const fullName = table && String(table).trim() ? picked.sources[0].tableName : null;
  const { rows, totals } = computeWorkload(
    sources.map(s => ({ tableName: s.tableName, records: s.records })),
    { table: fullName, product: String(product || '').trim() });
  const scope = [fullName && `in ${shortTableName(fullName)}`, product && String(product).trim() && `product ${String(product).trim()}`]
    .filter(Boolean).join(', ');
  const header = `Open tasks per designer (${WORKLOAD_STATUSES.join(' + ')})${scope ? `, ${scope}` : ''}:`;
  const statusText = st => WORKLOAD_STATUSES.map(s => `${s} ${st[s]}`).join(', ');
  const lines = rows.map(r => `${r.des}: ${r.open} open (${r.high} High) — ${statusText(r.statuses)}`);
  const body = rows.length
    ? `${header}\n${lines.join('\n')}\nTotal: ${totals.open} open (${totals.high} High)`
    : `${header}\nNo open tasks.`;
  return result(`${body}\n\n${freshnessText(sources, now)}`);
}

const TOOL_PREAMBLE = 'Read-only. UT Marketing Team Airtable tasks as last synced by HiggTable on this computer.';
const TABLE_PROP = { type: 'string', description: 'Table short name: VCP, PLM, CMC, LB or OMGF. Omit for all tables.' };

const TOOL_DEFINITIONS = [
  {
    name: 'find_tasks',
    description: `${TOOL_PREAMBLE} Finds creative tasks by name, by number (e.g. LO_15945) or by words in the brief. Returns one line per task: name, status, designer, deadline, priority, table.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Task name or part of it, a number like LO_15945, or words from the brief (at least 2 characters).' },
        table: TABLE_PROP,
        status: { type: 'string', description: 'Only tasks with this Status: Backlog, Rework, Ready for Design, In work, To accept or Done.' },
        designer: { type: 'string', description: 'Only tasks of this designer (the DES field).' },
        limit: { type: 'integer', minimum: 1, maximum: FIND_LIMIT_MAX, description: `How many tasks to return (default ${FIND_LIMIT_DEFAULT}, max ${FIND_LIMIT_MAX}).` },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task',
    description: `${TOOL_PREAMBLE} One task in full: the brief, links (Creative Link, Figma, REF) and fields (status, designer, deadline, type, format, hours…).`,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The full task name, a unique part of it such as LO_15945, or the Airtable record id.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'my_tasks',
    description: `${TOOL_PREAMBLE} A designer's open tasks (${OPEN_STATUSES.join(', ')}), soonest deadline first. Without a designer it uses the person set as "I am" in HiggTable.`,
    inputSchema: {
      type: 'object',
      properties: {
        designer: { type: 'string', description: 'Designer name (DES). Omit for the person using this computer.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'workload',
    description: `${TOOL_PREAMBLE} Open tasks (${WORKLOAD_STATUSES.join(' + ')}) and High-priority ones per designer, as in HiggTable's Workload tab.`,
    inputSchema: {
      type: 'object',
      properties: {
        table: TABLE_PROP,
        product: { type: 'string', description: 'Only tasks of this product (the Project field), e.g. OL.' },
      },
      additionalProperties: false,
    },
  },
];

const TOOL_HANDLERS = { find_tasks: findTasks, get_task: getTask, my_tasks: myTasks, workload };

function runTool(name, args, ctx) {
  const handler = Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name) ? TOOL_HANDLERS[name] : null;
  if (!handler) return { isError: true, text: `Unknown tool: ${name}` };
  return handler(ctx, args || {});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STALE_AFTER_MS, OPEN_STATUSES, NO_CACHE_TEXT,
    shortTableName, freshnessText, taskLine, resolveDesigner,
    findTasks, getTask, myTasks, workload, TOOL_DEFINITIONS, runTool,
  };
}
