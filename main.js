const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const scanner = require('./src/core/scanner');
const patcher = require('./src/core/patcher');
const ejsLiteParser = require('./src/core/ejsLiteParser');
const remoteFetcher = require('./src/core/remoteFetcher');

const UPDATE_REPO = 'yumebi/ymb_ejs_synch';
const RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases`;

let mainWindow;
let lastPages = [];
let lastScanParams = null; // { ejsRoot, htmlRoot, scope } 最後にscanで使われた引数(再検証用)
const patchIndex = new Map(); // patchId -> { patch, page }

function parseVersion(v) {
  return String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}

function isNewer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

async function checkForUpdateOnStartup() {
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
    if (!res.ok) return;
    const data = await res.json();
    const latest = parseVersion(data.tag_name || '0.0.0');
    const current = parseVersion(app.getVersion());
    if (!isNewer(latest, current)) return;

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '新しいバージョンがあります',
      message: `新しいバージョン ${data.tag_name} が公開されています(現在: v${app.getVersion()})`,
      detail: 'リポジトリのReleasesページからダウンロードできます。',
      buttons: ['リポジトリを開く', '閉じる'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) {
      shell.openExternal(RELEASES_URL);
    }
  } catch {
    // 起動時チェックはネットワーク不通等でも黙って無視する
  }
}

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
  mainWindow.webContents.once('did-finish-load', () => {
    checkForUpdateOnStartup();
  });
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
  lastScanParams = { ejsRoot, htmlRoot, scope };
  rebuildPatchIndex();
  return lastPages.map(toRendererPage);
});

// 公開サーバーから直接HTMLを取得してスキャンする。
// 取得先はOS一時ディレクトリ配下の固定フォルダで、実行のたびに作り直す(古い結果の混入防止)。
ipcMain.handle('scan-remote', async (_evt, { ejsRoot, baseUrl, scope, basicUser, basicPass }) => {
  const destDir = path.join(app.getPath('temp'), 'ejs-html-sync-remote');
  try {
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });

    // basicUser/basicPassは認証情報のためログ等には一切出力しない
    const fetchResult = await remoteFetcher.fetchSite({ ejsRoot, scope, baseUrl, destDir, basicUser, basicPass });

    lastPages = scanner.scanAll({ ejsRoot, htmlRoot: destDir, scope });
    lastScanParams = { ejsRoot, htmlRoot: destDir, scope };
    rebuildPatchIndex();

    const failures = fetchResult.results
      .filter((r) => !r.ok)
      .map((r) => ({ relHtmlPath: r.relHtmlPath, url: r.url, status: r.status, error: r.error }));

    return {
      ok: true,
      pages: lastPages.map(toRendererPage),
      fetchSummary: {
        okCount: fetchResult.okCount,
        failCount: fetchResult.failCount,
        failures,
        authFailed: fetchResult.authFailed,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// パッチ適用後、該当ページだけを再スキャンしてlastPages/patchIndexを最新化する。
// 直近のscanパラメータが無い(scan未実行)場合は再検証をスキップする。
function reScanPage(page) {
  if (!lastScanParams) return null;
  const updated = scanner.scanPage(page.ejsPath, page.htmlPath, page.relPath);
  const idx = lastPages.findIndex((p) => p.relPath === updated.relPath);
  if (idx !== -1) {
    lastPages[idx] = updated;
  } else {
    lastPages.push(updated);
  }
  rebuildPatchIndex();
  return updated;
}

ipcMain.handle('apply-patch', async (_evt, { patchId, editedNewText }) => {
  const entry = patchIndex.get(patchId);
  if (!entry) return { ok: false, error: 'パッチが見つかりません(再スキャンが必要かもしれません)' };
  try {
    patcher.applyOne(entry.patch, editedNewText);
    const updatedPage = reScanPage(entry.page);
    return { ok: true, updatedPage };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('apply-all-auto', async (_evt, { relPath }) => {
  const page = lastPages.find((p) => p.relPath === relPath);
  if (!page || !page.patches) return { ok: false, error: 'ページが見つかりません' };
  const autoPatches = page.patches.filter((p) => p.confidence === 'auto');
  const results = patcher.applyBatch(autoPatches);
  const updatedPage = reScanPage(page);
  return {
    ok: true,
    results: results.map((r) => ({ id: r.patch.id, ok: r.ok, error: r.error })),
    updatedPage,
  };
});

ipcMain.handle('open-path', async (_evt, targetPath) => {
  shell.showItemInFolder(targetPath);
});

// 差分のある全ページについて、autoパッチを一括適用し、それぞれ再検証する。
ipcMain.handle('apply-all-pages', async () => {
  const targetPages = lastPages.filter((p) => p.status === 'diff');
  const summary = [];
  for (const page of targetPages) {
    const autoPatches = (page.patches || []).filter((p) => p.confidence === 'auto');
    const results = patcher.applyBatch(autoPatches);
    const appliedCount = results.filter((r) => r.ok).length;
    const failedCount = results.filter((r) => !r.ok).length;
    const updatedPage = reScanPage(page);
    summary.push({
      relPath: page.relPath,
      appliedCount,
      failedCount,
      status: updatedPage ? updatedPage.status : page.status,
    });
  }
  return { ok: true, summary, pages: lastPages };
});

// srcStart(ファイル内の文字位置)から1始まりの行番号を算出する
function calcLineNumber(fileContent, srcStart) {
  const upto = fileContent.slice(0, srcStart);
  const newlineCount = (upto.match(/\n/g) || []).length;
  return newlineCount + 1;
}

// rendererから渡ってきたfileパスが、直近のスキャン結果に含まれる
// 正当なファイル(page.ejsPathまたはpatches[].file)かどうかを検証する。
// 任意ファイルパスでのコマンド実行を防ぐための安全策。
function isKnownFile(file) {
  for (const page of lastPages) {
    if (page.ejsPath === file) return true;
    if (page.patches) {
      for (const p of page.patches) {
        if (p.file === file) return true;
      }
    }
  }
  return false;
}

ipcMain.handle('open-in-editor', async (_evt, { file, srcStart }) => {
  if (!isKnownFile(file)) {
    return { ok: false, error: '許可されていないファイルです' };
  }
  if (!fs.existsSync(file)) {
    return { ok: false, error: 'ファイルが見つかりません' };
  }

  let line = 1;
  try {
    const content = fs.readFileSync(file, 'utf8');
    line = calcLineNumber(content, srcStart || 0);
  } catch {
    // 行番号の算出に失敗しても1行目としてエディタは開く
  }

  return new Promise((resolve) => {
    try {
      // Windowsでは code は .cmd のため shell 経由での実行が必要
      const child = spawn('code', ['-g', `${file}:${line}`], { shell: true });
      let settled = false;
      const fallback = (error) => {
        if (settled) return;
        settled = true;
        shell.showItemInFolder(file);
        resolve({ ok: false, error });
      };
      child.on('error', () => {
        fallback('VSCodeの起動に失敗したためフォルダを開きました');
      });
      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        if (code === 0 || code === null) {
          resolve({ ok: true });
        } else {
          shell.showItemInFolder(file);
          resolve({ ok: false, error: 'VSCodeの起動に失敗したためフォルダを開きました' });
        }
      });
    } catch (e) {
      shell.showItemInFolder(file);
      resolve({ ok: false, error: e.message });
    }
  });
});

// バックアップ(.bak)からの復元。page.ejsPathとそのincludeで使われる全ファイルを対象にする。
ipcMain.handle('restore-backup', async (_evt, { relPath }) => {
  const page = lastPages.find((p) => p.relPath === relPath);
  if (!page) return { ok: false, error: 'ページが見つかりません' };

  let targetFiles;
  try {
    const chunks = ejsLiteParser.parseAndExpand(page.ejsPath);
    targetFiles = new Set(chunks.map((c) => c.file));
    targetFiles.add(page.ejsPath);
  } catch (e) {
    return { ok: false, error: `対象ファイルの解析に失敗しました: ${e.message}` };
  }

  const restoredFiles = [];
  for (const file of targetFiles) {
    const bak = `${file}.bak`;
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, file);
      restoredFiles.push(file);
    }
  }

  if (restoredFiles.length === 0) {
    return { ok: false, error: 'バックアップが見つかりません' };
  }

  const updatedPage = reScanPage(page);
  return { ok: true, restoredFiles, updatedPage };
});
