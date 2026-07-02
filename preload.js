const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airtable', {
  getBases: () => ipcRenderer.invoke('get-bases'),
  getTables: (baseId) => ipcRenderer.invoke('get-tables', baseId),
  getRecords: (baseId, tableId) => ipcRenderer.invoke('get-records', baseId, tableId),
});

contextBridge.exposeInMainWorld('app', {
  getSettings:       ()            => ipcRenderer.invoke('get-settings'),
  saveSettings:      (data)        => ipcRenderer.invoke('save-settings', data),
  hasApiKey:         ()            => ipcRenderer.invoke('has-api-key'),
  openFileDialog:    ()            => ipcRenderer.invoke('open-file-dialog'),
  getFileDimensions: (p)           => ipcRenderer.invoke('get-file-dimensions', p),
  renameFile:        (from, to)    => ipcRenderer.invoke('rename-file', from, to),
});
