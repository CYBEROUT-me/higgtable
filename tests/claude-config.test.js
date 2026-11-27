const {
  MCP_SERVER_KEY, claudeDesktopConfigPath, buildServerEntry, withServerEntry,
  withoutServerEntry, entryStatus, claudeCodeCommand, planRunVersion, isTransientAppPath,
} = require('../claude-config');

const entry = buildServerEntry({
  execPath: '/Applications/HiggTable.app/Contents/MacOS/HiggTable',
  scriptPath: '/Applications/HiggTable.app/Contents/Resources/app.asar/mcp-server.js',
  userDataPath: '/Users/a/Library/Application Support/HiggTable',
});

const existing = JSON.stringify({
  mcpServers: { supabase: { command: 'npx', args: ['x'] } },
  preferences: { a: 1 },
});

test('the entry launches HiggTable as plain Node with its data folder', () => {
  expect(MCP_SERVER_KEY).toBe('higgtable');
  expect(entry).toEqual({
    command: '/Applications/HiggTable.app/Contents/MacOS/HiggTable',
    args: ['/Applications/HiggTable.app/Contents/Resources/app.asar/mcp-server.js'],
    env: { ELECTRON_RUN_AS_NODE: '1', HIGGTABLE_USER_DATA: '/Users/a/Library/Application Support/HiggTable' },
  });
});

describe('withServerEntry', () => {
  test('adds HiggTable and keeps every other server and setting', () => {
    const out = JSON.parse(withServerEntry(existing, entry));
    expect(out.mcpServers.supabase).toEqual({ command: 'npx', args: ['x'] });
    expect(out.preferences).toEqual({ a: 1 });
    expect(out.mcpServers.higgtable).toEqual(entry);
  });
  test('starts a missing or empty config from scratch', () => {
    expect(JSON.parse(withServerEntry(null, entry))).toEqual({ mcpServers: { higgtable: entry } });
    expect(JSON.parse(withServerEntry('  ', entry))).toEqual({ mcpServers: { higgtable: entry } });
  });
  test('ends with a newline', () => {
    expect(withServerEntry(null, entry).endsWith('}\n')).toBe(true);
  });
  test('refuses a config that is not valid JSON', () => {
    expect(() => withServerEntry('{"mcpServers":{},}', entry)).toThrow(/not valid JSON/);
  });
  test('refuses an mcpServers that is not an object', () => {
    expect(() => withServerEntry('{"mcpServers":[]}', entry)).toThrow();
  });
});

describe('withoutServerEntry', () => {
  test('removes only HiggTable', () => {
    const out = JSON.parse(withoutServerEntry(withServerEntry(existing, entry)));
    expect(out.mcpServers).toEqual({ supabase: { command: 'npx', args: ['x'] } });
    expect(out.preferences).toEqual({ a: 1 });
  });
  test('refuses invalid JSON', () => {
    expect(() => withoutServerEntry('{oops')).toThrow(/not valid JSON/);
  });
});

describe('entryStatus', () => {
  test('not connected', () => {
    expect(entryStatus(existing, entry)).toBe('not-connected');
    expect(entryStatus(null, entry)).toBe('not-connected');
  });
  test('connected', () => {
    expect(entryStatus(withServerEntry(existing, entry), entry)).toBe('connected');
  });
  test('outdated when only the data folder differs', () => {
    const moved = { ...entry, env: { ...entry.env, HIGGTABLE_USER_DATA: '/elsewhere' } };
    expect(entryStatus(withServerEntry(existing, moved), entry)).toBe('outdated');
  });
  test('invalid', () => {
    expect(entryStatus('{"mcpServers":{},}', entry)).toBe('invalid');
  });
});

describe('claudeDesktopConfigPath', () => {
  test('macOS', () => {
    expect(claudeDesktopConfigPath('darwin', {}, '/Users/a'))
      .toBe('/Users/a/Library/Application Support/Claude/claude_desktop_config.json');
  });
  test('Windows, with spaces in the user name', () => {
    expect(claudeDesktopConfigPath('win32', { APPDATA: 'C:\\Users\\Ivan Petrenko\\AppData\\Roaming' }, 'x'))
      .toBe('C:\\Users\\Ivan Petrenko\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
  });
  test('other systems are not supported', () => {
    expect(claudeDesktopConfigPath('linux', {}, '/h')).toBeNull();
  });
});

describe('claudeCodeCommand', () => {
  test('quotes paths with spaces', () => {
    const win = buildServerEntry({
      execPath: 'C:\\Program Files\\HiggTable\\HiggTable.exe',
      scriptPath: 'C:\\Program Files\\HiggTable\\resources\\app.asar\\mcp-server.js',
      userDataPath: 'C:\\Users\\Ivan Petrenko\\AppData\\Roaming\\HiggTable',
    });
    expect(claudeCodeCommand(win)).toBe(
      'claude mcp add higgtable -s user -e ELECTRON_RUN_AS_NODE=1 '
      + '-e "HIGGTABLE_USER_DATA=C:\\Users\\Ivan Petrenko\\AppData\\Roaming\\HiggTable" '
      + '-- "C:\\Program Files\\HiggTable\\HiggTable.exe" "C:\\Program Files\\HiggTable\\resources\\app.asar\\mcp-server.js"');
  });
});

describe('planRunVersion', () => {
  test('records the version on a first run without a settings file', () => {
    expect(planRunVersion(null, '1.11.0', 'win32')).toEqual({ updatedSinceLastRun: false, settingsToWrite: { lastRunVersion: '1.11.0' } });
  });
  test('spots an update on Windows and keeps every other setting', () => {
    const text = JSON.stringify({ apiKey: 'pat1', lastRunVersion: '1.10.0' });
    expect(planRunVersion(text, '1.11.0', 'win32')).toEqual({
      updatedSinceLastRun: true, settingsToWrite: { apiKey: 'pat1', lastRunVersion: '1.11.0' },
    });
  });
  test('an update on macOS is recorded but not flagged', () => {
    const text = JSON.stringify({ lastRunVersion: '1.10.0' });
    expect(planRunVersion(text, '1.11.0', 'darwin').updatedSinceLastRun).toBe(false);
  });
  test('writes nothing when the version is unchanged', () => {
    expect(planRunVersion(JSON.stringify({ lastRunVersion: '1.11.0' }), '1.11.0', 'win32'))
      .toEqual({ updatedSinceLastRun: false, settingsToWrite: null });
  });
  test('never overwrites a settings file it cannot read', () => {
    expect(planRunVersion('{"apiKey": "pat1",', '1.11.0', 'win32'))
      .toEqual({ updatedSinceLastRun: false, settingsToWrite: null });
  });
});

describe('isTransientAppPath', () => {
  test('an app running from a mounted DMG', () => {
    expect(isTransientAppPath('/Volumes/HiggTable 1.11.0/HiggTable.app/Contents/MacOS/HiggTable')).toBe(true);
  });
  test('an app moved aside by macOS App Translocation', () => {
    expect(isTransientAppPath('/private/var/folders/xy/T/AppTranslocation/ABC/d/HiggTable.app/Contents/MacOS/HiggTable')).toBe(true);
  });
  test('an installed app', () => {
    expect(isTransientAppPath('/Applications/HiggTable.app/Contents/MacOS/HiggTable')).toBe(false);
    expect(isTransientAppPath('C:\\Users\\a\\AppData\\Local\\Programs\\higgtable\\HiggTable.exe')).toBe(false);
  });
});
