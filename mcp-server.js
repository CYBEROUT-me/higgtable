// mcp-server.js
// HiggTable's read-only MCP server for Claude Desktop / Claude Code.
//
// Claude starts it as HiggTable's own executable in plain-Node mode:
//   command: <HiggTable executable>   args: [<this file>]
//   env:     ELECTRON_RUN_AS_NODE=1, HIGGTABLE_USER_DATA=<HiggTable's userData folder>
// (the entry is written by Settings → Claude → Connect, see claude-config.js).
//
// It answers from the records cache HiggTable keeps on disk
// (<userData>/records-cache/*.json), so it works with HiggTable closed and
// makes no network requests at all. The Airtable token never reaches it: of
// settings.json it reads only `selectedDesigner`.
//
// Protocol: JSON-RPC 2.0, one message per line on stdin/stdout. stdout carries
// protocol messages ONLY; diagnostics go to higgtable.log (prefix [mcp]).

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { TOOL_DEFINITIONS, runTool } = require('./renderer/mcp-tools.js');

const SERVER_NAME = 'higgtable';
const SERVER_VERSION = (() => {
  try { return require('./package.json').version; } catch { return '0.0.0'; }
})();

let logFile = null;
function log(message) {
  if (!logFile) return;
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] [mcp] ${message}\n`); } catch { /* logging must never break the server */ }
}

// Parsed table files, by path: { mtimeMs, source }. A file is parsed again only
// when its mtime changes (VCP is ~34 MB), and a file that fails to parse keeps
// its last good copy, since HiggTable may be mid-way through replacing it.
const parsedFiles = new Map();

// <key>.meta.json: { syncedAt, tableName } from syncs that found nothing new,
// which don't rewrite the table file itself.
function readSidecar(file) {
  try {
    const meta = JSON.parse(fs.readFileSync(file.replace(/\.json$/, '.meta.json'), 'utf8'));
    return { syncedAt: Number(meta.syncedAt) || 0, tableName: typeof meta.tableName === 'string' ? meta.tableName : '' };
  } catch { return { syncedAt: 0, tableName: '' }; }
}

function isTableFile(name) {
  return name.endsWith('.json') && !name.endsWith('.meta.json');
}

function loadSources(userDataPath) {
  const dir = path.join(userDataPath, 'records-cache');
  let names;
  try { names = fs.readdirSync(dir).filter(isTableFile).sort(); } catch { return []; }
  const sources = [];
  names.forEach(name => {
    const file = path.join(dir, name);
    let entry = parsedFiles.get(file);
    try {
      const { mtimeMs } = fs.statSync(file);
      if (!entry || entry.mtimeMs !== mtimeMs) {
        const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!payload || !Array.isArray(payload.records) || !(payload.syncedAt > 0)) {
          throw new Error('not a HiggTable records cache');
        }
        entry = {
          mtimeMs,
          source: { tableName: payload.tableName || '', tableId: payload.tableId || name, syncedAt: payload.syncedAt, records: payload.records },
        };
        parsedFiles.set(file, entry);
      }
    } catch (err) {
      log(`cache read failed: ${name}: ${err.message}`);
    }
    if (!entry) return;
    const sidecar = readSidecar(file);
    const { tableId, ...source } = entry.source;
    sources.push({
      ...source,
      tableName: source.tableName || sidecar.tableName || tableId,
      syncedAt: Math.max(source.syncedAt, sidecar.syncedAt),
    });
  });
  return sources.sort((a, b) => String(a.tableName).localeCompare(String(b.tableName)));
}

function readDefaultDesigner(userDataPath) {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(userDataPath, 'settings.json'), 'utf8'));
    return typeof settings.selectedDesigner === 'string' ? settings.selectedDesigner : '';
  } catch { return ''; }
}

const reply = (id, resultValue) => ({ jsonrpc: '2.0', id, result: resultValue });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// One JSON-RPC message in, one response (or null for a notification) out.
function handleMessage(msg, getCtx) {
  const isRequest = msg && msg.id !== undefined && msg.id !== null;
  if (!isRequest) return null;
  const { id, method, params = {} } = msg;
  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOL_DEFINITIONS });
      case 'tools/call': {
        const { text, isError } = runTool(params.name, params.arguments || {}, getCtx());
        return reply(id, { content: [{ type: 'text', text }], isError });
      }
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    log(`${method} failed: ${err.stack || err.message}`);
    return fail(id, -32603, `Internal error: ${err.message}`);
  }
}

function main() {
  const userDataPath = process.env.HIGGTABLE_USER_DATA;
  if (!userDataPath) {
    process.stderr.write('HIGGTABLE_USER_DATA is not set; reconnect from HiggTable → Settings → Claude.\n');
    process.exit(1);
  }
  logFile = path.join(userDataPath, 'higgtable.log');
  process.on('uncaughtException', err => {
    log(`fatal: ${err.stack || err.message}`);
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
  log(`started (v${SERVER_VERSION}, pid ${process.pid})`);

  const getCtx = () => ({
    sources: loadSources(userDataPath),
    defaultDesigner: readDefaultDesigner(userDataPath),
    now: new Date(),
  });
  const write = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      write(fail(null, -32700, 'Parse error'));
      return;
    }
    const response = handleMessage(msg, getCtx);
    if (response) write(response);
  });
  rl.on('close', () => log('stopped (stdin closed)'));
}

if (require.main === module) main();

module.exports = { loadSources, readDefaultDesigner, handleMessage };
