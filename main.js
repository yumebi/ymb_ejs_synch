const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');

const scanner = require('./src/core/scanner');
const patcher = require('./src/core/patcher');

let mainWindow;
let lastPages = [];
const patchIndex = new Map(); // patchId -> { patch, page }

function rebuildPatchIndex() {
  patchIndex.clear();
  for (const page of lastPages) {
    if (!page.patches) continue;
    for (const patch of page.patches) {
      patchIndex.set(patch.id, { patch, page });
    }
  }
}

function toRendererPage(page) {
  // 関数を含まない、レンダラーへ渡せる形にする(patchesはそのままJSON化可能)
  return page;
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-version', () => app.getVersion());

ipcMain.handle('select-folder', async (_evt, defaultPath) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: defaultPath || undefined,
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle('scan', async (_evt, { ejsRoot, htmlRoot, scope }) => {
  lastPages = scanner.scanAll({ ejsRoot, htmlRoot, scope });
  rebuildPatchIndex();
  return lastPages.map(toRendererPage);
});

ipcMain.handle('apply-patch', async (_evt, { patchId, editedNewText }) => {
  const entry = patchIndex.get(patchId);
  if (!entry) return { ok: false, error: 'パッチが見つかりません(再スキャンが必要かもしれません)' };
  try {
    patcher.applyOne(entry.patch, editedNewText);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('apply-all-auto', async (_evt, { relPath }) => {
  const page = lastPages.find((p) => p.relPath === relPath);
  if (!page || !page.patches) return { ok: false, error: 'ページが見つかりません' };
  const autoPatches = page.patches.filter((p) => p.confidence === 'auto');
  const results = patcher.applyBatch(autoPatches);
  return { ok: true, results: results.map((r) => ({ id: r.patch.id, ok: r.ok, error: r.error })) };
});

ipcMain.handle('open-path', async (_evt, targetPath) => {
  shell.showItemInFolder(targetPath);
});
