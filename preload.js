const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFolder: (defaultPath) => ipcRenderer.invoke('select-folder', defaultPath),
  scan: (args) => ipcRenderer.invoke('scan', args),
  applyPatch: (patchId, editedNewText) => ipcRenderer.invoke('apply-patch', { patchId, editedNewText }),
  applyAllAuto: (relPath) => ipcRenderer.invoke('apply-all-auto', { relPath }),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
});

contextBridge.exposeInMainWorld('appInfo', {
  // sandbox化されたpreloadではローカルファイルのrequireが使えないため、
  // バージョンはIPC経由でメインプロセス(app.getVersion())から取得する
  getVersion: () => ipcRenderer.invoke('get-version'),
  // GitHub公開後、"owner/repo" 形式で設定すると更新確認が動くようになる
  updateRepo: '',
});
