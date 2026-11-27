# HiggTable for Claude: a read-only MCP server

Status: draft for the owner's approval (2026-11-27).

## Why

The team reads its Airtable tasks from Claude (the Claude desktop app) through
the Airtable connector. The shared Airtable account allows only **10
connections**, and the team has more people than that, so some designers
cannot connect Claude at all.

Every designer already runs HiggTable, which holds an Airtable token and keeps
a full copy of the base on disk (`userData/records-cache/<baseId>_<tableId>.json`,
kept fresh by incremental sync). If Claude reads tasks from HiggTable instead,
it needs **no Airtable connection of its own**, for any number of people, and
most questions cost zero Airtable API calls.

What people ask Claude is mostly reading: their tasks and the briefs. They use
the Claude desktop app.

## Goals

- A designer's Claude Desktop can find tasks, read a task's brief and fields,
  list a designer's open tasks, and see the workload per designer, without
  the Airtable connector.
- Works on macOS and Windows, with HiggTable open **or closed**.
- One-button setup in HiggTable's Settings. No terminal, no Node install, no
  token to copy.
- Every answer says how fresh the data is.

## Non-goals

- Writing to Airtable (status, Hours, links…). Not in this version; see
  "Later".
- Dashboard numbers (done work, hours). The owner said there is no need.
- Working-folder readiness (which files exist), preview images.
- The claude.ai website: it cannot reach a server on the designer's computer.

## Anti-goals (would be a failure even if it works)

- The Airtable token reaches Claude, Claude's config file, or a tool result.
- A network listener (any port) is opened on the designer's machine.
- Claude can change Airtable data through this, even by mistake.
- Claude presents old data as current without saying so.
- Connecting to Claude damages the designer's existing Claude config (other
  MCP servers, preferences).

## Approaches considered

1. **A read-only stdio server shipped inside HiggTable, started by Claude
   Desktop (chosen).** Claude Desktop launches HiggTable's own executable with
   `ELECTRON_RUN_AS_NODE=1` and a server script; the script reads the
   on-disk records cache. Works with the app closed, no network, no token.
   Downside: data is as fresh as that designer's last HiggTable sync.
2. **The running HiggTable answers over a localhost port** (with a stdio
   bridge for Claude Desktop). Always live, and writes would be easy, but it
   only works while HiggTable is open and adds a port and an access key to
   secure. Not worth it for reading. Can be added on top of (1) later.
3. **A community Airtable MCP server with a personal token per person.** Also
   avoids the 10-connection limit, but every question becomes Airtable API
   calls with bulky answers, each machine needs Node, and the token sits in
   plain text in Claude's config. Rejected.

(A shared export file read by Claude was dropped early: it goes stale and
needs yet another connector.)

The owner picked approach 1.

## Design

### How it runs

- New file `mcp-server.js` at the repo root (packaged like `main.js`; the
  `build.files` glob already includes it). It is a stdio MCP server: JSON-RPC
  on stdin/stdout, **nothing else may be written to stdout**. Diagnostics go
  to `higgtable.log` with an `[mcp]` prefix (append), and fatal errors also to
  stderr.
- Claude Desktop starts it as:
  - `command`: HiggTable's executable (`process.execPath` of the installed
    app: `/Applications/HiggTable.app/Contents/MacOS/HiggTable` on macOS, the
    NSIS install's `HiggTable.exe` on Windows)
  - `args`: [absolute path to `mcp-server.js` inside the app's resources]
  - `env`: `ELECTRON_RUN_AS_NODE=1`, `HIGGTABLE_USER_DATA=<app.getPath('userData')>`
- In this mode Electron behaves as plain Node (Electron 28 → Node 18): no
  window, no Dock icon, no `app` module. That is why the userData path is
  passed in `env` rather than computed.
- The server reads every `*.json` in `<HIGGTABLE_USER_DATA>/records-cache/`
  that passes the same validity check as `usableCache` (records-sync.js),
  keeps the parsed records in memory, and re-reads a file only when its
  mtime changes (VCP is ~34 MB, ~12k records; parse it once, not per call).
- It also reads `settings.json` for **one key only**, `selectedDesigner` (see
  below). It never reads, logs or returns any other setting; in particular
  never `apiKey`.
- It makes **no network requests** and writes nothing except log lines.

### Tools

All read-only. Results are compact plain text (not raw Airtable JSON), to
keep Claude's answers short. Each result ends with a freshness line, e.g.
`From HiggTable · VCP synced 27 Nov 14:32`. If a table's `syncedAt` is older
than 24 h the line becomes a warning: `VCP was last synced 3 days ago; open
HiggTable to refresh it.` If there is no cache at all: a clear message to open
HiggTable once and let it load.

1. **find_tasks**: `query` (name, number like `LO_15945`, or free text),
   optional `table` (VCP/PLM/CMC/LB/OMGF), `status`, `designer`, `limit`
   (default 20, max 50). Name and number matches come first, via
   `searchTasks` (task-search.js, which matches names only); then, in a
   separate "brief mentions it" section, tasks whose cleaned brief contains
   the query (normalised with `normalizeForSearch`, newest first). Filters
   apply to both. One line per task: name, status, designer, deadline,
   priority, table. *(Brief search: Claude's call after review: a
   name-only search would miss "the task about the cat intro".)*
2. **get_task**: `task` (name, number or record id). Returns: name, table,
   status, designer, priority, deadline, Type, Format, Project, Date, Date
   Done, Hours, Timing, Old ID / New ID, links (Creative Link, Figma/Canvas
   link incl. LB's Cyrillic spelling via the same fallback the panel uses,
   REF), and the brief: `Description` passed through `briefFromDescription`
   (markdown-data.js). Several matches → the list, with a note to pick one.
3. **my_tasks**: optional `designer`. Open tasks (Rework, Ready for Design,
   In work), soonest deadline first, tasks without a deadline last; same line
   format as find_tasks plus days left. Without `designer` it uses
   `selectedDesigner`; if that is empty too, it says so and lists the
   designer names it knows.
4. **workload**: optional `table`, `product` (Project). Open (Ready for
   Design + In work) and High tasks per designer: `computeWorkload`
   (workload-data.js) on the cached records, so the numbers match the
   Workload tab.

Designer names match case-insensitively against `DES`; an unknown name
returns the list of known names instead of an empty result.

Tool descriptions should say plainly that this is the UT Marketing Team
Airtable data as last synced by HiggTable, so Claude picks these tools for
task questions.

### Logic placement (the pure-module pattern)

The filtering and formatting live in a new pure module
`renderer/mcp-tools.js` (no IO, no DOM, `module.exports`), required by
`mcp-server.js` together with `task-search.js`, `workload-data.js`,
`markdown-data.js` and `records-sync.js` (all already export for Node).
`mcp-server.js` holds only the stdio protocol, file reading and caching.
`mcp-tools.js` is not loaded by `index.html`.

### Changes inside the app

- **Table names in the cache.** The cache payload carries `tableId` but not
  the table's name, which the server needs (`VCP Creatives` → `VCP`).
  `storeTable` (app.js) adds `tableName: name` to the payload. Older files
  without it are rewritten at the next sync; until then the server shows
  the table id.
- **Who "me" is.** The "You:" picker is also a table filter: a designer may
  set it to everyone, and a manager browses other people with it, so it
  can't be trusted as "me" on every change. Instead the Claude section in
  Settings has an **"I am"** designer dropdown, saved as
  `selectedDesigner`. It is prefilled from the current "You:" pick the first
  time Connect is pressed, and after that changes only when the user changes
  it there. *(Claude's call after review.)*
- **Freshness on disk.** An incremental sync that finds no changes currently
  skips the disk write (`persist: false`), so the file's `syncedAt` can lag
  the real last sync by up to 6 h, and the freshness line would be wrong.
  Persist the new `syncedAt` on every successful sync (rewrite the file, or a
  small sidecar such as `<key>.meta.json` if rewriting 34 MB every 5 min is
  too heavy; builder's call).
- **Settings → "Claude" section:**
  - **Connect to Claude Desktop**: IPC `claude-connect` in main.js. Finds
    Claude Desktop's config (`~/Library/Application Support/Claude/claude_desktop_config.json`
    on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows),
    creates it if missing, and sets **only** `mcpServers.higgtable`; every
    other key and server is kept as is. Written temp + rename. A config
    that isn't valid JSON is left untouched and the error is shown. After
    success: toast "Connected. Quit and reopen Claude to use it."
  - **Disconnect**: removes only `mcpServers.higgtable`.
  - Status line: connected / not connected / connected to an old path.
  - The **"I am"** dropdown (see above).
  - **Copy command for Claude Code**: copies
    `claude mcp add higgtable -s user -e ELECTRON_RUN_AS_NODE=1 -e HIGGTABLE_USER_DATA=<path> -- "<exe>" "<mcp-server.js>"`
    via the `copy-to-clipboard` IPC.
- **Path repair at startup.** If `mcpServers.higgtable` exists but points at
  a different executable or script (the app was moved), main.js updates
  that one entry and logs it. It never adds the entry on its own.

### Windows updates (accepted limitation, owner's decision)

On Windows, Claude Desktop keeps a `HiggTable.exe` (run-as-node) process
alive for the server. The NSIS installer that applies an update most likely
closes every process with that name, so Claude's HiggTable tools stop until
the person quits and reopens Claude; a manual install from GitHub may also
report "HiggTable is running" while the window is closed. The owner accepted
this rather than shipping a separately named launcher. Cost to pay: after
an update, if `mcpServers.higgtable` is set, HiggTable shows a toast once:
"HiggTable was updated. Quit and reopen Claude to reconnect." Check the
actual installer behaviour on a Windows PC during verification and note it
in CLAUDE.md. macOS is not affected (a running process keeps its old
files when the .app is replaced).

## Constraints

- Plain JS, no bundler; Electron 28 (Node 18 in run-as-node mode).
- The renderer's process boundary stays as is: new capability = IPC in
  main.js + bridge in preload.js.
- Windows build is x64 only.
- `npm test` must stay green; `node --check` on changed files.

## Verification

- Jest: `tests/mcp-tools.test.js` for search filters, designer resolution,
  sorting, freshness and stale warnings, the brief cleanup, the LB Figma
  fallback, unknown-designer and no-cache messages.
- Jest: a stdio round-trip test that spawns `mcp-server.js` with plain
  `node` and a fixture `HIGGTABLE_USER_DATA`, sends `initialize`,
  `tools/list` and a `tools/call`, and checks stdout carries only JSON-RPC.
- Jest: the config merge (keeps other servers and keys, refuses invalid
  JSON, disconnect removes only its entry), as a pure function.
- By hand on the owner's Mac **from a packaged build** (`npm run dist` or the
  release build), not only `npm start`: Connect, restart Claude Desktop, ask
  "what are my open tasks", "brief for LO_…", "workload in VCP". Same on a
  Windows PC before release.

## Left to the builder

- Use the official `@modelcontextprotocol/sdk` for the protocol unless it
  fails to load under Electron 28's run-as-node mode; then hand-roll the
  handful of methods needed (`initialize`, `tools/list`, `tools/call`,
  notifications). Builder's call either way.
- Confirm that a script inside `app.asar` runs under `ELECTRON_RUN_AS_NODE`
  and can `require` the renderer modules; if not, add `mcp-server.js` and
  the modules it needs to `asarUnpack`.
- Exact tool parameter schemas and wording of results.
- Whether Claude Desktop's Microsoft Store build on Windows keeps its config
  elsewhere; if so, look there too.

## Later (not now)

- Write tools (status, Hours, Creative Link) through the running HiggTable
  (approach 2), with confirmation.
- Working-folder readiness in `get_task`.
