// claude-config.js
// Pure helpers for HiggTable's entry in Claude Desktop's config
// (claude_desktop_config.json): build it, add or remove it without touching
// anything else in the file, and tell whether it is there and current.
// No IO and no Electron here; main.js reads and writes the file.

const path = require('path');

const MCP_SERVER_KEY = 'higgtable';

function claudeDesktopConfigPath(platform, env, homedir) {
  if (platform === 'darwin') {
    return path.posix.join(homedir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (platform === 'win32' && env && env.APPDATA) {
    return path.win32.join(env.APPDATA, 'Claude', 'claude_desktop_config.json');
  }
  return null;
}

// Claude launches HiggTable's own executable as plain Node (no window) with the
// server script; the userData path is passed in, since `app` doesn't exist there.
function buildServerEntry({ execPath, scriptPath, userDataPath }) {
  return {
    command: execPath,
    args: [scriptPath],
    env: { ELECTRON_RUN_AS_NODE: '1', HIGGTABLE_USER_DATA: userDataPath },
  };
}

const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

function parseConfig(configText) {
  if (configText === null || configText === undefined || !String(configText).trim()) return {};
  let config;
  try { config = JSON.parse(configText); } catch { throw new Error('Claude config is not valid JSON'); }
  if (!isPlainObject(config)) throw new Error('Claude config is not a JSON object');
  if (config.mcpServers !== undefined && !isPlainObject(config.mcpServers)) {
    throw new Error('Claude config has an mcpServers that is not an object');
  }
  return config;
}

const serialize = config => `${JSON.stringify(config, null, 2)}\n`;

function withServerEntry(configText, entry) {
  const config = parseConfig(configText);
  config.mcpServers = { ...(config.mcpServers || {}), [MCP_SERVER_KEY]: entry };
  return serialize(config);
}

function withoutServerEntry(configText) {
  const config = parseConfig(configText);
  if (config.mcpServers) delete config.mcpServers[MCP_SERVER_KEY];
  return serialize(config);
}

function entryStatus(configText, entry) {
  let config;
  try { config = parseConfig(configText); } catch { return 'invalid'; }
  const current = config.mcpServers && config.mcpServers[MCP_SERVER_KEY];
  if (!current) return 'not-connected';
  const same = current.command === entry.command
    && JSON.stringify(current.args) === JSON.stringify(entry.args)
    && (current.env || {}).HIGGTABLE_USER_DATA === entry.env.HIGGTABLE_USER_DATA;
  return same ? 'connected' : 'outdated';
}

function claudeCodeCommand(entry) {
  return `claude mcp add ${MCP_SERVER_KEY} -s user -e ELECTRON_RUN_AS_NODE=1 `
    + `-e "HIGGTABLE_USER_DATA=${entry.env.HIGGTABLE_USER_DATA}" `
    + `-- "${entry.command}" "${entry.args[0]}"`;
}

// The startup bookkeeping for spotting an update: what to write to settings.json
// (null = nothing) and whether this run follows an update on Windows, where the
// installer most likely closed the server Claude was running. A settings file
// that exists but can't be parsed is never overwritten, since it holds the
// Airtable key and every other setting.
function planRunVersion(settingsText, version, platform) {
  if (settingsText === null || settingsText === undefined) {
    return { updatedSinceLastRun: false, settingsToWrite: { lastRunVersion: version } };
  }
  let settings;
  try { settings = JSON.parse(settingsText); } catch { settings = null; }
  if (!isPlainObject(settings)) return { updatedSinceLastRun: false, settingsToWrite: null };
  const previous = settings.lastRunVersion;
  if (previous === version) return { updatedSinceLastRun: false, settingsToWrite: null };
  return {
    updatedSinceLastRun: platform === 'win32' && !!previous,
    settingsToWrite: { ...settings, lastRunVersion: version },
  };
}

// An app started from the mounted .dmg or moved aside by macOS (App
// Translocation) lives at a path that disappears; Claude must not point there.
function isTransientAppPath(execPath) {
  const p = String(execPath || '');
  return p.startsWith('/Volumes/') || p.includes('/AppTranslocation/');
}

module.exports = {
  MCP_SERVER_KEY, claudeDesktopConfigPath, buildServerEntry, withServerEntry,
  withoutServerEntry, entryStatus, claudeCodeCommand, planRunVersion, isTransientAppPath,
};
