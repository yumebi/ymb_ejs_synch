const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: (defaultPath) => ipcRenderer.invoke('select-folder', defaultPath),
  scan: (args) => ipcRenderer.invoke('scan', args),
  scanRemote: (args) => ipcRenderer.invoke('scan-remote', args),
  applyPatch: (patchId, editedNewText) => ipcRenderer.invoke('apply-patch', { patchId, editedNewText }),
  applyAllAuto: (relPath) => ipcRenderer.invoke('apply-all-auto', { relPath }),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  applyAllPages: () => ipcRenderer.invoke('apply-all-pages'),
  openInEditor: (file, srcStart) => ipcRenderer.invoke('open-in-editor', { file, srcStart }),
  restoreBackup: (relPath) => ipcRenderer.invoke('restore-backup', { relPath }),
});

contextBridge.exposeInMainWorld('appInfo', {
  // sandbox化されたpreloadではローカルファイルのrequireが使えないため、
  // バージョンはIPC経由でメインプロセス(app.getVersion())から取得する
  getVersion: () => ipcRenderer.invoke('get-version'),
  updateRepo: 'yumebi/ymb_ejs_synch',
});
