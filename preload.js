const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airtable', {
  getBases: () => ipcRenderer.invoke('get-bases'),
  getTables: (baseId) => ipcRenderer.invoke('get-tables', baseId),
  getRecords: (baseId, tableId, requestId) => ipcRenderer.invoke('get-records', baseId, tableId, requestId),
  onRecordsProgress: (callback) => {
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on('records-progress', listener);
    return () => ipcRenderer.removeListener('records-progress', listener);
  },
});

contextBridge.exposeInMainWorld('app', {
  getSettings:       ()            => ipcRenderer.invoke('get-settings'),
  saveSettings:      (data)        => ipcRenderer.invoke('save-settings', data),
  hasApiKey:         ()            => ipcRenderer.invoke('has-api-key'),
  openFileDialog:    ()            => ipcRenderer.invoke('open-file-dialog'),
  getFileDimensions: (p)           => ipcRenderer.invoke('get-file-dimensions', p),
  renameFile:        (from, to)    => ipcRenderer.invoke('rename-file', from, to),
  log:               (msg)         => ipcRenderer.invoke('log', msg),
  getLogPath:        ()            => ipcRenderer.invoke('get-log-path'),
});
