# HiggTable for Claude (read-only MCP server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Desktop (and Claude Code) read HiggTable's tasks through a local, read-only stdio MCP server, so designers no longer need the Airtable connector.

**Architecture:** `mcp-server.js` is launched by Claude Desktop as HiggTable's own executable in `ELECTRON_RUN_AS_NODE` mode. It reads the on-disk records cache in `HIGGTABLE_USER_DATA/records-cache/`, and answers four tools whose logic lives in the pure module `renderer/mcp-tools.js`. HiggTable's Settings gets a "Claude" section that writes or removes HiggTable's own entry in Claude Desktop's config, using the pure module `claude-config.js`.

**Tech Stack:** Plain JS, Electron 28 (Node 18 in run-as-node mode), Jest. No new dependencies. The MCP protocol is hand-rolled: newline-delimited JSON-RPC 2.0 over stdio, with the methods `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`. That was the builder's call in the spec; it avoids pulling an ESM SDK and its dependencies into `app.asar`.

**Spec:** `docs/superpowers/specs/2026-11-27-claude-mcp-server-design.md`. Read it first; this plan argues from it.

## Global Constraints

- Read-only: no tool writes to Airtable, and `mcp-server.js` makes **no network requests** and writes nothing except log lines.
- `mcp-server.js` reads `settings.json` for the key `selectedDesigner` **only**; it never reads, logs or returns `apiKey` or any other setting.
- Nothing but JSON-RPC may be written to stdout by `mcp-server.js`. Logs go to `<HIGGTABLE_USER_DATA>/higgtable.log` with the prefix `[mcp]`; fatal errors go to stderr too.
- Connect/Disconnect touch only `mcpServers.higgtable` in Claude's config. Every other key is kept. A config that isn't valid JSON is never overwritten. Writes go through a temp file + rename.
- Server entry: `command` = `process.execPath`, `args` = [absolute `mcp-server.js` path], `env` = `{ "ELECTRON_RUN_AS_NODE": "1", "HIGGTABLE_USER_DATA": <app.getPath('userData')> }`.
- Claude config path: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows `%APPDATA%\Claude\claude_desktop_config.json`.
- Open statuses for `my_tasks`: `Rework`, `Ready for Design`, `In work`. Workload statuses: those of `workload-data.js` (`Ready for Design`, `In work`).
- `find_tasks` `limit` defaults to 20, max 50. Stale after 24 h (`STALE_AFTER_MS = 86400000`).
- Freshness copy: `From HiggTable · VCP synced 27 Nov 14:32`. Stale copy: `VCP was last synced 3 days ago; open HiggTable to refresh it.` No cache: `No HiggTable data found. Open HiggTable once and let it load the tables.`
- Toasts: `Connected. Quit and reopen Claude to use it.` and (Windows, after an update, when connected) `HiggTable was updated. Quit and reopen Claude to reconnect.`
- Project conventions (CLAUDE.md): work on `main`; commit only what each task changed, and only if the owner has asked for commits during this run (otherwise skip the Commit steps); one imperative sentence per commit message; never push. After editing `app.js`, check that every `getElementById(...)` you wire up exists in `index.html`, run `node --check renderer/app.js main.js preload.js mcp-server.js claude-config.js`, and run `npm test`.

## Review Focus

1. **The cache file being replaced while the server reads it.** The server must never read `*.tmp` or `*.meta.json` as a table. If one table file fails to parse, the server keeps that table's last good copy, or skips the table with a log line; the server itself doesn't fail. Test in Task 3.
2. **No cache at all** (fresh install, never loaded, wrong `HIGGTABLE_USER_DATA`): every tool returns the no-cache message and doesn't throw. Tests in Tasks 1 and 3.
3. **Claude's config is hand-edited or broken** (trailing comma, empty file, `mcpServers` missing or not an object): connecting must refuse invalid JSON, and must work on an empty or missing file. Test in Task 4.
4. **Messy designer data:** names in a different case or with extra spaces, tasks without `DES`, without `Deadline`, or without `Name`. Matching is case- and space-insensitive. Undated tasks sort last. Tasks without a name are skipped. Tests in Tasks 1 and 2.
5. **Paths with spaces** (`C:\Users\Ivan Petrenko\AppData\...`, `/Applications/HiggTable.app/...`): the Claude Code command must quote them, and the JSON entry must keep them intact. Test in Task 4.

---

## File Structure

- Create `renderer/mcp-tools.js`: pure. It turns cached records into tool answers (text), defines the tools and their input schemas, and dispatches `runTool`. It isn't loaded by `index.html`.
- Create `mcp-server.js` (repo root): the stdio JSON-RPC loop, loading the cache from disk with mtime caching, reading `selectedDesigner`, and logging.
- Create `claude-config.js` (repo root): pure. It builds the server entry, merges it into or removes it from Claude's config text, reports status, and builds the Claude Code command.
- Modify `main.js`: Claude IPC handlers, startup path repair, update detection, and the `records-cache-touch` IPC.
- Modify `preload.js`: bridge entries.
- Modify `renderer/app.js`: `tableName` in the cache payload; a sync-time sidecar for incremental syncs with no changes; the Settings Claude section; the update toast.
- Modify `renderer/index.html`: the Settings "Claude" section markup.
- Modify `CLAUDE.md`: the feature, the new files and settings keys, and the Windows limitation.
- Tests: `tests/mcp-tools.test.js`, `tests/mcp-server.test.js`, `tests/claude-config.test.js`.

Shared data shape, used by Tasks 1–3 (the server builds it, the tools read it):

```js
// Source = { tableName: 'VCP Creatives', syncedAt: <ms>, records: [{ id, createdTime?, fields: {...} }] }
// ctx    = { sources: Source[], defaultDesigner: string, now: Date }
```

---

### Task 1: Tool answers for finding and reading tasks (`renderer/mcp-tools.js`)

**Files:**
- Create: `renderer/mcp-tools.js`
- Test: `tests/mcp-tools.test.js`

**Interfaces:**
- Consumes: `searchTasks`, `normalizeForSearch`, `compareTaskNames` from `renderer/task-search.js`; `briefFromDescription` from `renderer/markdown-data.js`; `resolveFieldName` from `renderer/task-refs.js`. Load them with plain `require('./task-search.js')` etc. at the top: this module runs only under Node (server and Jest), never in the browser.
- Produces:
  - `STALE_AFTER_MS` (86400000), `OPEN_STATUSES` (`['Rework','Ready for Design','In work']`)
  - `shortTableName(tableName: string) -> string` (`'VCP Creatives'` → `'VCP'`; anything without the ` Creatives` suffix is returned unchanged)
  - `freshnessText(sources: Source[], now: Date) -> string`: one `From HiggTable · VCP synced 27 Nov 14:32, PLM synced …` line, then one stale line per table older than `STALE_AFTER_MS`. If `sources` is empty, it returns the no-cache message.
  - `taskLine(rec, tableName: string, now: Date) -> string`: `<Name> · <Status> · <DES> · due 29 Nov (in 2 days) · <Priority> · VCP`. Empty parts are left out. Overdue is shown as `(3 days late)`, today as `(today)`.
  - `findTasks(ctx, { query, table?, status?, designer?, limit? }) -> { text, isError }`
  - `getTask(ctx, { task }) -> { text, isError }`
  - `resolveDesigner(sources, name: string) -> { name } | { error: string }`: matching is case-insensitive with whitespace collapsed, against all `DES` values. The error text lists the known names, sorted.

- [ ] **Step 1: Write the failing tests** in `tests/mcp-tools.test.js`. Use a helper `rec(id, fields, createdTime)` and a fixture with three sources: `VCP Creatives` (synced `new Date(2026,10,27,14,32)`), `PLM Creatives` (synced 3 days earlier), and `LB Creatives` (synced at the same time as VCP, with one Stat task whose Figma field is `Figmа Link`). Designers are `Olena` and `Ivan`. Olena has 2 open workload tasks, 1 of them High. Use `now = new Date(2026,10,27,15,0)`. Task 2 reuses this fixture.
  - `shortTableName('VCP Creatives') === 'VCP'`; `shortTableName('tblX') === 'tblX'`
  - `freshnessText` contains `'VCP synced 27 Nov 14:32'` and `'PLM was last synced 3 days ago; open HiggTable to refresh it.'`; `freshnessText([], now)` equals the no-cache message.
  - `findTasks(ctx, { query: 'LO_15945' })`: the text's first task line starts with `LO_15945_13140_`, and the text ends with the freshness text.
  - `findTasks(ctx, { query: 'cat intro' })`: there are no name hits. The text contains the heading `Brief mentions it:` followed by the task whose `Description` is `Make the cat intro\_v2 shorter`.
  - `findTasks` with `designer: '  olena '` returns only Olena's tasks. With `status: 'In work'` it returns only In work. With `table: 'PLM'` it returns only PLM.
  - `findTasks(ctx, { query: 'x' })` → `isError: true`, and the text mentions at least 2 characters.
  - `findTasks(ctx, { query: 'LO', limit: 500 })` returns at most 50 task lines.
  - A record without `Name` never appears.
  - `getTask(ctx, { task: 'LO_15945_13140_M0_S0_GR_usr_ARI_ILU_Video_VAR_Mix_9x16' })`: the text contains `Brief:\nMake the cat intro_v2 shorter` (unescaped), `Creative Link: https://drive.google.com/drive/folders/abc`, `REF: https://ref.example/1`, and `Table: VCP`.
  - `getTask` on an LB record whose Figma field is `Figmа Link` (Cyrillic `а`, `\u0430`) → the text contains `Figma: https://figma.com/file/lb`.
  - `getTask(ctx, { task: 'rec00000000000001' })` resolves by record id.
  - `getTask(ctx, { task: 'LO_159' })` with two matches → `isError: false`, the text starts with `Several tasks match` and lists both names.
  - `getTask(ctx, { task: 'NOPE_1' })` → `isError: true`, the text contains `No task matches`.
  - `findTasks({ sources: [], defaultDesigner: '', now }, { query: 'LO' })` → the text equals the no-cache message.
  - `resolveDesigner(sources, 'Nobody')` → its `error` lists `Ivan, Olena` (sorted).

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx jest tests/mcp-tools.test.js`
Expected: FAIL with `Cannot find module '../renderer/mcp-tools.js'`

- [ ] **Step 3: Implement the functions above in `renderer/mcp-tools.js`**, following the pure-module pattern (top-level functions, `module.exports` guard at the end).
  - Name hits: `searchTasks(query, flatRecords, { limit: Infinity })`, where each flat record is `{ id, name: fields.Name, table, rec }`. Apply the filters, then cut to `limit`.
  - Brief hits: `normalizeForSearch(briefFromDescription(fields.Description)).includes(normalizeForSearch(query))`, leaving out name hits. Sort by `createdTime` descending, falling back to source order. These share the same `limit`, applied after the name hits.
  - Figma field: `resolveFieldName(keys, 'Figma/Canvas link') || keys.find(n => /^fig/i.test(n) && /link/i.test(n))`, over the union of that table's record field keys. Creative Link and REF resolve the same way with `resolveFieldName`.
  - Date formatting uses local time: `27 Nov 14:32`, with English month abbreviations, no year, and a zero-padded 24 h clock.
  - `getTask` fields, in this order, empty ones left out: `Table`, `Status`, `Designer` (DES), `Priority`, `Deadline` (with days left), `Type`, `Format`, `Project`, `Date`, `Date Done`, `Hours`, `Timing`, `Old ID`, `New ID`, `Creative Link`, `Figma`, `REF`, then `Brief:` and the brief, then the freshness text.

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx jest tests/mcp-tools.test.js`
Expected: PASS

- [ ] **Step 5: Commit** (if commits were asked for)

```bash
git add renderer/mcp-tools.js tests/mcp-tools.test.js
git commit -m "Add pure answers for finding and reading tasks for the Claude server"
```

---

### Task 2: My tasks, workload, tool definitions and dispatch (`renderer/mcp-tools.js`)

**Files:**
- Modify: `renderer/mcp-tools.js`
- Test: `tests/mcp-tools.test.js`

**Interfaces:**
- Consumes: Task 1's functions; `computeWorkload` and `WORKLOAD_STATUSES` from `renderer/workload-data.js`.
- Produces:
  - `myTasks(ctx, { designer? }) -> { text, isError }`
  - `workload(ctx, { table?, product? }) -> { text, isError }`
  - `TOOL_DEFINITIONS: Array<{ name, description, inputSchema }>`, for exactly `find_tasks`, `get_task`, `my_tasks` and `workload`. Each `inputSchema` is JSON Schema with `type: 'object'` and `additionalProperties: false`. `find_tasks` requires `query`; `get_task` requires `task`. Every description starts with `Read-only. UT Marketing Team Airtable tasks as last synced by HiggTable on this computer.`
  - `runTool(name: string, args: object, ctx) -> { text, isError }`. An unknown tool returns `{ isError: true, text: 'Unknown tool: <name>' }`.

- [ ] **Step 1: Write the failing tests** (same fixture as Task 1)
  - `myTasks(ctx, {})` with `defaultDesigner: 'Olena'` lists only Olena's Rework / Ready for Design / In work tasks. They're ordered by `Deadline` ascending, and tasks without a deadline come last. To Accept and Done tasks are left out.
  - `myTasks` with `designer: 'ivan'` overrides the default.
  - `myTasks` with no designer and an empty `defaultDesigner` → `isError: true`. The text says no designer is set in HiggTable's Settings → Claude → "I am", and lists the known names.
  - `workload(ctx, {})`: the text contains `Olena: 2 open (1 High)`, and the per-status counts match `computeWorkload` on the same fixture.
  - `workload(ctx, { table: 'XYZ' })` → `isError: true`. The text lists `LB, PLM, VCP`.
  - `TOOL_DEFINITIONS.map(t => t.name)` equals `['find_tasks','get_task','my_tasks','workload']`.
  - `runTool('get_task', { task: 'rec00000000000001' }, ctx).text` equals `getTask(ctx, …).text`. `runTool('drop_table', {}, ctx).isError === true`.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx jest tests/mcp-tools.test.js`
Expected: FAIL (`myTasks is not a function`)

- [ ] **Step 3: Implement `myTasks`, `workload`, `TOOL_DEFINITIONS` and `runTool`.** `workload` maps `table` through `shortTableName` matching, then calls `computeWorkload(sources.map(s => ({ tableName: s.tableName, records: s.records })), { table: fullName, product })`. Every answer ends with `freshnessText`.

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx jest tests/mcp-tools.test.js`
Expected: PASS

- [ ] **Step 5: Commit** (if asked): `Add my_tasks, workload and tool definitions for the Claude server`

---

### Task 3: The stdio server (`mcp-server.js`)

**Files:**
- Create: `mcp-server.js`
- Test: `tests/mcp-server.test.js`

**Interfaces:**
- Consumes: `TOOL_DEFINITIONS` and `runTool` from `./renderer/mcp-tools.js`; `usableCache`-style validity (check `Array.isArray(records)` and `syncedAt > 0`; the `tableId` check doesn't apply here).
- Produces (exported for tests when `require`d; it runs the loop only when `require.main === module`):
  - `loadSources(userDataPath: string) -> Source[]`: reads `records-cache/*.json`, leaving out `*.tmp` and `*.meta.json`. Each file is cached in memory by path + mtime. `syncedAt` is `max(payload.syncedAt, <key>.meta.json's syncedAt)`. `tableName` comes from `payload.tableName`, falling back to `payload.tableId`. A file that fails to parse keeps its previous good copy, or is skipped; either way the server logs `[mcp] cache read failed: <file>: <message>`.
  - `readDefaultDesigner(userDataPath: string) -> string`: `settings.json` → `selectedDesigner`, or `''`.
  - `handleMessage(msg: object, getCtx: () => ctx) -> object | null`. `initialize` → `{ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'higgtable', version: <package.json version> } }`. `ping` → `{}`. `tools/list` → `{ tools: TOOL_DEFINITIONS }`. `tools/call` → `{ content: [{ type: 'text', text }], isError }`. Notifications (no `id`) → `null`. An unknown method with an `id` → JSON-RPC error `-32601`. A thrown handler → JSON-RPC error `-32603`, and the message is logged.

- [ ] **Step 1: Write the failing tests** in `tests/mcp-server.test.js`. Build a fixture `userData` directory under `os.tmpdir()` (`fs.mkdtempSync`) containing `records-cache/appX_tblA.json` (`{ v:1, tableId:'tblA', tableName:'VCP Creatives', syncedAt, fullSyncedAt, records:[…] }`), `records-cache/appX_tblA.json.tmp` (garbage), `records-cache/appX_tblA.meta.json` (`{ syncedAt: later }`), and `settings.json` (`{ "apiKey": "patSECRET", "selectedDesigner": "Olena" }`).
  - `loadSources(dir)` returns one source. Its `tableName` is `'VCP Creatives'` and its `syncedAt` is the meta file's value.
  - After the table file is overwritten with `{not json`, `loadSources(dir)` still returns the previous records.
  - `loadSources(<empty dir>)` → `[]`.
  - `readDefaultDesigner(dir) === 'Olena'`.
  - **Round trip:** `child_process.spawn(process.execPath, ['mcp-server.js'], { env: { ...process.env, HIGGTABLE_USER_DATA: dir } })`. Write `initialize`, `notifications/initialized`, `tools/list`, and `tools/call my_tasks {}` as newline-delimited JSON. Then:
    - Every stdout line `JSON.parse`s, and has `jsonrpc: '2.0'` and an `id`.
    - The `initialize` result echoes the protocol version you sent.
    - `tools/list` has 4 tools.
    - The `my_tasks` text contains Olena's task.
    - `patSECRET` appears nowhere in stdout.
  - An unknown method → `error.code === -32601`.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx jest tests/mcp-server.test.js`
Expected: FAIL with `Cannot find module '../mcp-server.js'`

- [ ] **Step 3: Implement `mcp-server.js`.** Read stdin with `readline` (one JSON object per line; skip blank lines; a line that isn't valid JSON gets error `-32700`). Write each response as `JSON.stringify(obj) + '\n'`. `getCtx` returns `{ sources: loadSources(dir), defaultDesigner: readDefaultDesigner(dir), now: new Date() }` on each `tools/call`. If `HIGGTABLE_USER_DATA` is missing, write the error to stderr and exit with code 1. Exit when stdin ends. Log start and stop, but not each call.

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx jest tests/mcp-server.test.js && node --check mcp-server.js`
Expected: PASS

- [ ] **Step 5: Commit** (if asked): `Add a read-only stdio MCP server that answers from HiggTable's cache`

---

### Task 4: Claude config helpers (`claude-config.js`)

**Files:**
- Create: `claude-config.js`
- Test: `tests/claude-config.test.js`

**Interfaces:**
- Produces:
  - `MCP_SERVER_KEY = 'higgtable'`
  - `claudeDesktopConfigPath(platform: string, env: object, homedir: string) -> string | null`: `darwin` → `<homedir>/Library/Application Support/Claude/claude_desktop_config.json`; `win32` → `<env.APPDATA>\Claude\claude_desktop_config.json` (use `path.win32.join`); otherwise `null`.
  - `buildServerEntry({ execPath, scriptPath, userDataPath }) -> { command, args, env }`
  - `withServerEntry(configText: string | null, entry) -> string`: `null` or whitespace-only input starts from `{}`. Anything else must `JSON.parse`; if it doesn't, it throws `Error('Claude config is not valid JSON')`. It creates `mcpServers` if that's missing, and throws if `mcpServers` isn't a plain object. The result is pretty-printed with 2 spaces plus a trailing newline.
  - `withoutServerEntry(configText: string) -> string`: removes only `mcpServers.higgtable`. Invalid JSON throws.
  - `entryStatus(configText: string | null, entry) -> 'not-connected' | 'connected' | 'outdated' | 'invalid'`. `outdated` means an entry exists but its `command`, `args` or `env.HIGGTABLE_USER_DATA` differ.
  - `claudeCodeCommand(entry) -> string`: `claude mcp add higgtable -s user -e ELECTRON_RUN_AS_NODE=1 -e "HIGGTABLE_USER_DATA=<path>" -- "<command>" "<script>"`

- [ ] **Step 1: Write the failing tests**
  - `withServerEntry('{"mcpServers":{"supabase":{"command":"npx","args":["x"]}},"preferences":{"a":1}}', entry)` keeps `supabase` and `preferences` deep-equal, and adds `higgtable` deep-equal to `entry`.
  - `withServerEntry(null, entry)` and `withServerEntry('  ', entry)` → `{ mcpServers: { higgtable: entry } }`.
  - `withServerEntry('{"mcpServers":{},}', entry)` throws `/not valid JSON/`. `withServerEntry('{"mcpServers":[]}', entry)` throws.
  - `withoutServerEntry` keeps `supabase` and removes `higgtable`.
  - `entryStatus`: there's one case for each of the 4 results. Changing only `env.HIGGTABLE_USER_DATA` → `'outdated'`.
  - `claudeDesktopConfigPath('win32', { APPDATA: 'C:\\Users\\Ivan Petrenko\\AppData\\Roaming' }, 'x')` equals `'C:\\Users\\Ivan Petrenko\\AppData\\Roaming\\Claude\\claude_desktop_config.json'`. `claudeDesktopConfigPath('linux', {}, '/h') === null`.
  - With `command: 'C:\\Program Files\\HiggTable\\HiggTable.exe'`, `claudeCodeCommand(entry)` contains `-- "C:\\Program Files\\HiggTable\\HiggTable.exe" "`.

- [ ] **Step 2: Run the tests and check they fail**

Run: `npx jest tests/claude-config.test.js`
Expected: FAIL with `Cannot find module '../claude-config.js'`

- [ ] **Step 3: Implement `claude-config.js`** (a plain CommonJS module at the repo root, like `airtable.js`; no Electron imports).

- [ ] **Step 4: Run the tests and check they pass**

Run: `npx jest tests/claude-config.test.js`
Expected: PASS

- [ ] **Step 5: Commit** (if asked): `Add helpers that add or remove HiggTable in Claude Desktop's config`

---

### Task 5: Main-process wiring (`main.js`, `preload.js`)

**Files:**
- Modify: `main.js` (near the records-cache IPC, around lines 394–410; the settings helpers at 62–74; `initAutoUpdate` at around 194)
- Modify: `preload.js`

**Interfaces:**
- Consumes: Task 4's module.
- Produces (in `preload.js` under `window.app`):
  - `claudeStatus() -> Promise<{ status, configPath, updatedSinceLastRun: boolean }>`
  - `claudeConnect(selectedDesigner: string) -> Promise<{ status }>`: saves `selectedDesigner` (merging into settings), then writes the entry.
  - `claudeDisconnect() -> Promise<{ status }>`
  - `claudeCodeCommand() -> Promise<string>`
  - `touchRecordsCache(key: string, syncedAt: number) -> Promise<void>`: writes `<key>.meta.json` = `{ syncedAt }` (temp + rename; the key is sanitised like `cacheFile`).

- [ ] **Step 1: Add `serverEntry()` in `main.js`.** It returns `buildServerEntry({ execPath: process.execPath, scriptPath: path.join(app.getAppPath(), 'mcp-server.js'), userDataPath: app.getPath('userData') })`. When `app.getAppPath()` ends in `app.asar` and Task 7's check finds that run-as-node can't load the script from the asar, use the `app.asar.unpacked` path instead. Leave a `// see Task 7` comment until that's settled.

- [ ] **Step 2: Add the five IPC handlers and the preload entries.** Config read errors (`ENOENT`) count as `null`. `claude-connect` and `claude-disconnect` write through `<configPath>.higgtable.tmp` + rename. An invalid config is reported to the renderer as `status: 'invalid'` and is never written. Create the `Claude` folder with `mkdirSync({ recursive: true })` before writing. A `null` config path (Linux) → `status: 'unsupported'`.

- [ ] **Step 3: Add startup path repair and update detection** in the `app.whenReady` path.
  - If `entryStatus` is `'outdated'`, rewrite the entry and log `claude: repaired MCP entry path`. Never add the entry if it's missing.
  - Compare `settings.lastRunVersion` with `app.getVersion()`. `updatedSinceLastRun` is true when a previous version is recorded, it differs from the current one, and `process.platform === 'win32'`. Then save the new `lastRunVersion`.

- [ ] **Step 4: Verify**

Run: `node --check main.js preload.js && npm test`
Expected: no syntax errors; all suites pass.

- [ ] **Step 5: Commit** (if asked): `Let HiggTable connect itself to Claude Desktop from the main process`

---

### Task 6: Renderer: cache metadata, the Settings "Claude" section, the update toast

**Files:**
- Modify: `renderer/app.js` (`storeTable` around line 282; the Settings modal code next to the Drive connect handlers around line 5367; startup)
- Modify: `renderer/index.html` (Settings modal, before `.modal-actions`, around line 253)
- Modify: `renderer/styles.css` if the new row needs layout. Reuse `#drive-connect-row`'s styles.

**Interfaces:**
- Consumes: Task 5's `window.app.claude*` and `touchRecordsCache`.

- [ ] **Step 1: Cache metadata.** In `storeTable`, add `tableName: name` to the payload. When `persist` is false but `meta.fullSyncedAt` is set, call `window.app.touchRecordsCache(recordsCacheKey(name), meta.syncedAt)`, catching and logging errors as the write does.

- [ ] **Step 2: Settings markup.** Add a `<h2>Claude</h2>` section with:
  - a `<p>`: `Lets the Claude desktop app read your tasks from HiggTable, without the Airtable connector. Read only.`
  - `<select id="claude-designer-select">` (the "I am" picker, with a first option `— choose —` whose value is `''`)
  - `<div id="claude-connect-row">` with `<button id="claude-connect-btn">`, `<button id="claude-disconnect-btn">`, `<span id="claude-connect-status">`
  - `<button id="claude-code-copy-btn">Copy command for Claude Code</button>`

- [ ] **Step 3: Settings behaviour.**
  - When Settings opens, fill the select with the sorted unique `DES` values across `recordsCache`. Preselect `settings.selectedDesigner`, or else `state.selectedDES`. Show `claudeStatus()` as `Connected`, `Not connected`, `Connected to an old location (reconnect)`, `Claude's config file is not valid JSON; fix or remove it first`, or `Only on macOS and Windows`.
  - Connect: calls `claudeConnect(select.value)` and shows the toast `Connected. Quit and reopen Claude to use it.`; errors go through `toastError`.
  - Disconnect: calls `claudeDisconnect()`.
  - Copy: copies `claudeCodeCommand()` through `copyToClipboard` and flashes via `flashCopied`.
  - The existing Save also saves `selectedDesigner` from the select.

- [ ] **Step 4: Update toast.** At startup, if `(await window.app.claudeStatus())` has `updatedSinceLastRun` and its status is `connected`, show the info toast `HiggTable was updated. Quit and reopen Claude to reconnect.`

- [ ] **Step 5: Verify**

Run: `node --check renderer/app.js && grep -o "getElementById('claude-[a-z-]*')" renderer/app.js | sort -u` and confirm that each id exists in `renderer/index.html`. Then run `npm test`.
Expected: no syntax errors; every id is present; all suites pass.

- [ ] **Step 6: Manual check with `npm start`.** Open Settings → Claude, choose "I am", and press Connect. Check that `~/Library/Application Support/Claude/claude_desktop_config.json` still has the owner's `supabase` entry, now with `higgtable` added. Press Disconnect and check that only `higgtable` is gone. Then reconnect, so Task 7 can use it.

- [ ] **Step 7: Commit** (if asked): `Add a Claude section to Settings that connects HiggTable to Claude Desktop`

---

### Task 7: Packaged-build verification and docs

**Files:**
- Modify (only if needed): `package.json` `build.asarUnpack`
- Modify: `main.js` `serverEntry()` (settle the `// see Task 7` comment)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Build a packaged app** with `npm run dist` (or the mac-only build script in `package.json`; check which one exists). Run it from `dist/`.

- [ ] **Step 2: Check run-as-node from inside the asar.**

Run: `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"my_tasks","arguments":{}}}' | ELECTRON_RUN_AS_NODE=1 HIGGTABLE_USER_DATA="$HOME/Library/Application Support/HiggTable" "dist/mac-arm64/HiggTable.app/Contents/MacOS/HiggTable" "dist/mac-arm64/HiggTable.app/Contents/Resources/app.asar/mcp-server.js"`
Expected: two JSON lines; the second lists the owner's open tasks with a freshness line.
If it fails to load the script or its `require`s: add `"asarUnpack": ["mcp-server.js", "renderer/mcp-tools.js", "renderer/task-search.js", "renderer/workload-data.js", "renderer/markdown-data.js", "renderer/task-refs.js", "package.json"]`, point `serverEntry()` at `app.asar.unpacked`, rebuild, and re-run the check.

- [ ] **Step 3: End to end in Claude Desktop** (the owner does this). In the packaged app, Settings → Claude → Connect, then quit and reopen Claude. Ask: "what are my open tasks", "give me the brief for LO_<number>", "workload in VCP". Every answer should end with the synced-at line. Then quit HiggTable and ask again: it should still answer.

- [ ] **Step 4: Windows check** (before release, on a Windows PC). Repeat Step 3. Then install the next version while Claude is running, and write down what the installer does to the running `HiggTable.exe` (killed? a dialog?) and whether the toast appears. If Claude Desktop on that PC is the Microsoft Store build and Connect wrote to `%APPDATA%\Claude` without effect, find where that build keeps `claude_desktop_config.json`, and add that location to `claudeDesktopConfigPath` with a test.

- [ ] **Step 5: Update `CLAUDE.md`**:
  - a "Claude (MCP server)" feature entry: the files, the four tools, read-only, how it launches, the `selectedDesigner` and `lastRunVersion` settings keys, the `tableName` payload field and the `*.meta.json` sidecar;
  - `mcp-tools.js` in the pure-module list, noting that it isn't in `index.html`;
  - the Windows update limitation and what Step 4 found.

- [ ] **Step 6: Final check**

Run: `node --check renderer/app.js main.js preload.js mcp-server.js claude-config.js && npm test`
Expected: all pass.

- [ ] **Step 7: Commit** (if asked): `Document the Claude MCP server and settle how it ships in the asar`
