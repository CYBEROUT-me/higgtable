const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { loadSources, readDefaultDesigner, handleMessage } = require('../mcp-server');

const SYNCED = Date.UTC(2026, 10, 27, 12, 0);
const META_SYNCED = SYNCED + 60 * 60 * 1000;

const records = [
  { id: 'rec00000000000001', fields: { Name: 'LO_15945_13140_M0_S0_GR_usr_ARI_ILU_Video_VAR_Mix_9x16', Status: 'In work', DES: 'Olena' } },
  { id: 'rec00000000000002', fields: { Name: 'LO_15946_13140_M0_S0_DE_usr_ARI_ILU_Video_VAR_Mix_9x16', Status: 'Done', DES: 'Ivan' } },
];

function makeUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'higgtable-mcp-'));
  const cache = path.join(dir, 'records-cache');
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(cache, 'appX_tblA.json'), JSON.stringify({
    v: 1, tableId: 'tblA', tableName: 'VCP Creatives', syncedAt: SYNCED, fullSyncedAt: SYNCED, records,
  }));
  fs.writeFileSync(path.join(cache, 'appX_tblA.json.tmp'), '{garbage');
  fs.writeFileSync(path.join(cache, 'appX_tblA.meta.json'), JSON.stringify({ syncedAt: META_SYNCED }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ apiKey: 'patSECRET', selectedDesigner: 'Olena' }));
  return dir;
}

describe('loadSources', () => {
  test('reads table files only, with the later sidecar sync time', () => {
    const sources = loadSources(makeUserData());
    expect(sources).toHaveLength(1);
    expect(sources[0].tableName).toBe('VCP Creatives');
    expect(sources[0].syncedAt).toBe(META_SYNCED);
    expect(sources[0].records).toHaveLength(2);
  });

  test('keeps the last good copy when a table file turns unreadable', () => {
    const dir = makeUserData();
    loadSources(dir);
    const file = path.join(dir, 'records-cache', 'appX_tblA.json');
    fs.writeFileSync(file, '{not json');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const sources = loadSources(dir);
    expect(sources).toHaveLength(1);
    expect(sources[0].records).toHaveLength(2);
  });

  test('falls back to the table id when the payload has no table name', () => {
    const dir = makeUserData();
    fs.writeFileSync(path.join(dir, 'records-cache', 'appX_tblB.json'), JSON.stringify({
      v: 1, tableId: 'tblB', syncedAt: SYNCED, fullSyncedAt: SYNCED, records: [],
    }));
    expect(loadSources(dir).map(s => s.tableName).sort()).toEqual(['VCP Creatives', 'tblB']);
  });

  test('takes the table name from the sidecar when the table file has none yet', () => {
    const dir = makeUserData();
    fs.writeFileSync(path.join(dir, 'records-cache', 'appX_tblC.json'), JSON.stringify({
      v: 1, tableId: 'tblC', syncedAt: SYNCED, fullSyncedAt: SYNCED, records: [],
    }));
    fs.writeFileSync(path.join(dir, 'records-cache', 'appX_tblC.meta.json'), JSON.stringify({ syncedAt: META_SYNCED, tableName: 'PLM Creatives' }));
    expect(loadSources(dir).map(s => s.tableName)).toContain('PLM Creatives');
  });

  test('returns nothing when there is no cache', () => {
    expect(loadSources(fs.mkdtempSync(path.join(os.tmpdir(), 'higgtable-mcp-empty-')))).toEqual([]);
  });
});

describe('readDefaultDesigner', () => {
  test('reads selectedDesigner', () => {
    expect(readDefaultDesigner(makeUserData())).toBe('Olena');
  });
  test('is empty without a settings file', () => {
    expect(readDefaultDesigner(fs.mkdtempSync(path.join(os.tmpdir(), 'higgtable-mcp-empty-')))).toBe('');
  });
});

describe('handleMessage', () => {
  const getCtx = () => ({ sources: [], defaultDesigner: '', now: new Date() });
  test('answers notifications with nothing', () => {
    expect(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, getCtx)).toBeNull();
  });
  test('reports an unknown method', () => {
    expect(handleMessage({ jsonrpc: '2.0', id: 9, method: 'resources/list' }, getCtx).error.code).toBe(-32601);
  });
  test('answers ping', () => {
    expect(handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }, getCtx)).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });
});

describe('stdio round trip', () => {
  test('speaks JSON-RPC only and never leaks the token', async () => {
    const dir = makeUserData();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js')], {
      env: { ...process.env, HIGGTABLE_USER_DATA: dir },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    const send = obj => child.stdin.write(`${JSON.stringify(obj)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'my_tasks', arguments: {} } });
    send({ jsonrpc: '2.0', id: 4, method: 'nope' });
    child.stdin.end();
    const code = await new Promise(resolve => child.on('close', resolve));
    expect(code).toBe(0);

    const lines = out.trim().split('\n');
    const msgs = lines.map(l => JSON.parse(l));
    msgs.forEach(m => { expect(m.jsonrpc).toBe('2.0'); expect(m.id).toBeDefined(); });
    const byId = Object.fromEntries(msgs.map(m => [m.id, m]));
    expect(byId[1].result.protocolVersion).toBe('2025-06-18');
    expect(byId[1].result.serverInfo.name).toBe('higgtable');
    expect(byId[2].result.tools).toHaveLength(4);
    expect(byId[3].result.isError).toBe(false);
    expect(byId[3].result.content[0].type).toBe('text');
    expect(byId[3].result.content[0].text).toContain('LO_15945_13140_M0_S0_GR_usr_ARI_ILU_Video_VAR_Mix_9x16');
    expect(byId[4].error.code).toBe(-32601);
    expect(out).not.toContain('patSECRET');
  });
});
