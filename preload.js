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
  uploadAttachment: (baseId, recordId, fieldName, filePath) =>
    ipcRenderer.invoke('upload-attachment', baseId, recordId, fieldName, filePath),
  updateRecord: (baseId, tableId, recordId, fields) =>
    ipcRenderer.invoke('update-record', baseId, tableId, recordId, fields),
  updateRecords: (baseId, tableId, records) =>
    ipcRenderer.invoke('update-records', baseId, tableId, records),
});

contextBridge.exposeInMainWorld('app', {
  getSettings:       ()            => ipcRenderer.invoke('get-settings'),
  saveSettings:      (data)        => ipcRenderer.invoke('save-settings', data),
  hasApiKey:         ()            => ipcRenderer.invoke('has-api-key'),
  openFileDialog:    ()            => ipcRenderer.invoke('open-file-dialog'),
  pickDirectory:     ()            => ipcRenderer.invoke('pick-directory'),
  findAssetFiles:    (dir, names)  => ipcRenderer.invoke('find-asset-files', dir, names),
  readImageDataUrl:  (p)           => ipcRenderer.invoke('read-image-data-url', p),
  getVideoDuration:  (p)           => ipcRenderer.invoke('get-video-duration', p),
  getFileDimensions: (p)           => ipcRenderer.invoke('get-file-dimensions', p),
  renameFile:        (from, to)    => ipcRenderer.invoke('rename-file', from, to),
  log:               (msg)         => ipcRenderer.invoke('log', msg),
  getLogPath:        ()            => ipcRenderer.invoke('get-log-path'),
});
