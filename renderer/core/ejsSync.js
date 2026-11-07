/* =========================================================================
 * ejsSync.js
 * EJS 差分同期の手順(スキャン・パッチ適用・一括適用・復元)。Electron 版の main.js の IPC ハンドラに相当する。
 * ファイルや通信といった入出力は、`io` として外から渡す(Tauri では Rust のコマンド、テストでは偽物)。
 *
 * io の形:
 *   setRoots(ejsRoot, htmlRoot|null)
 *   dirExists(which, rel) / listEjs(scopeRel) / listHtml(scopeRel)
 *   absPath(which, rel) / pathExists(which, rel) / readText(which, rel)
 *   readEjs(rel) / writeEjs(rel, text, backup) / restoreEjs(rel) -> 復元したら true
 *   fetchText(url, auth, timeoutMs, maxBytes)
 *   openInEditor(rel, srcStart) -> エラーの文(開けたら null)
 *   reveal(which, rel)
 * ========================================================================= */

import * as scanner from './scanner.js';
import * as patcher from './patcher.js';
import * as parser from './ejsLiteParser.js';
import { createRemoteFetcher, joinUrl } from './remoteFetcher.js';

function errorMessage(e) {
  if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;
  return String(e);
}

// 手元の公開HTMLフォルダを、公開HTMLの置き場として使う。
function localHtmlSource(io) {
  return {
    exists: (rel) => io.pathExists('html', rel),
    read: (rel) => io.readText('html', rel),
    list: (scope) => io.listHtml(scope),
    absPath: (rel) => io.absPath('html', rel),
  };
}

// 公開サーバーから取得して、メモリに持っている HTML を、公開HTMLの置き場として使う。
function memoryHtmlSource(store, baseUrl) {
  return {
    exists: async (rel) => store.has(rel),
    read: async (rel) => store.get(rel),
    list: async (scope) => {
      const prefix = scope ? scope + '/' : '';
      return [...store.keys()].filter((k) => k.toLowerCase().endsWith('.html') && (!prefix || k.startsWith(prefix))).sort();
    },
    // 画面に出す「公開HTMLの場所」。取得元の URL を見せる(フォルダは無い)。
    absPath: async (rel) => joinUrl(baseUrl, rel),
  };
}

export function createEjsSync(io) {
  let lastPages = [];
  let lastScan = null; // { htmlSource } 最後のスキャンで使った、公開HTMLの置き場(再検証用)
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

  // ローカルの公開HTMLフォルダと比べるスキャン。
  async function scan({ ejsRoot, htmlRoot, scope }) {
    await io.setRoots(ejsRoot, htmlRoot);
    const htmlSource = localHtmlSource(io);
    lastPages = await scanner.scanAll(io, htmlSource, { scope });
    lastScan = { htmlSource };
    rebuildPatchIndex();
    return lastPages;
  }

  // 公開サーバーから直接HTMLを取得してスキャンする。取得したHTMLはメモリに持つ(一時ファイルは作らない)。
  async function scanRemote({ ejsRoot, baseUrl, scope, basicUser, basicPass, crawl, crawlLimit }) {
    try {
      await io.setRoots(ejsRoot, null);
      const store = new Map();
      const fetcher = createRemoteFetcher(io, store);
      // basicUser/basicPassは認証情報のためログ等には一切出力しない
      const fetchResult = await fetcher.fetchSite({ scope, baseUrl, basicUser, basicPass, crawl, crawlLimit });

      // 取得したHTMLの中の「EJS由来に無い新規ページ」は、scanAllの新規ページ検出(html-only)が、そのまま拾う。
      const htmlSource = memoryHtmlSource(store, baseUrl);
      lastPages = await scanner.scanAll(io, htmlSource, { scope });
      lastScan = { htmlSource };
      rebuildPatchIndex();

      const failures = fetchResult.results
        .filter((r) => !r.ok)
        .map((r) => ({ relHtmlPath: r.relHtmlPath, url: r.url, status: r.status, error: r.error }));

      return {
        ok: true,
        pages: lastPages,
        fetchSummary: {
          okCount: fetchResult.okCount,
          failCount: fetchResult.failCount,
          failures,
          authFailed: fetchResult.authFailed,
          newPageCount: fetchResult.newPageCount,
          note: fetchResult.note,
        },
      };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }

  // パッチ適用後、該当ページだけを再スキャンして lastPages / patchIndex を最新化する。
  // 直近のスキャン(scan 未実行)が無い場合は再検証をスキップする。
  async function reScanPage(page) {
    if (!lastScan) return null;
    const updated = await scanner.scanPage(io, lastScan.htmlSource, page.ejsRel, page.htmlRel, page.relPath);
    const idx = lastPages.findIndex((p) => p.relPath === updated.relPath);
    if (idx !== -1) {
      lastPages[idx] = updated;
    } else {
      lastPages.push(updated);
    }
    rebuildPatchIndex();
    return updated;
  }

  async function applyPatch(patchId, editedNewText) {
    const entry = patchIndex.get(patchId);
    if (!entry) return { ok: false, error: 'パッチが見つかりません(再スキャンが必要かもしれません)' };
    try {
      await patcher.applyOne(io, entry.patch, editedNewText);
      const updatedPage = await reScanPage(entry.page);
      return { ok: true, updatedPage };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }

  async function applyAllAuto(relPath) {
    const page = lastPages.find((p) => p.relPath === relPath);
    if (!page || !page.patches) return { ok: false, error: 'ページが見つかりません' };
    const autoPatches = page.patches.filter((p) => p.confidence === 'auto');
    const results = await patcher.applyBatch(io, autoPatches);
    const updatedPage = await reScanPage(page);
    return {
      ok: true,
      results: results.map((r) => ({ id: r.patch.id, ok: r.ok, error: r.error })),
      updatedPage,
    };
  }

  // 差分のある全ページについて、autoパッチを一括適用し、それぞれ再検証する。
  async function applyAllPages() {
    const targetPages = lastPages.filter((p) => p.status === 'diff');
    const summary = [];
    for (const page of targetPages) {
      const autoPatches = (page.patches || []).filter((p) => p.confidence === 'auto');
      const results = await patcher.applyBatch(io, autoPatches);
      const appliedCount = results.filter((r) => r.ok).length;
      const failedCount = results.filter((r) => !r.ok).length;
      const updatedPage = await reScanPage(page);
      summary.push({
        relPath: page.relPath,
        appliedCount,
        failedCount,
        status: updatedPage ? updatedPage.status : page.status,
      });
    }
    return { ok: true, summary, pages: lastPages };
  }

  // バックアップ(.bak)からの復元。page の EJS と、その include で使われる全ファイルが対象。
  async function restoreBackup(relPath) {
    const page = lastPages.find((p) => p.relPath === relPath);
    if (!page) return { ok: false, error: 'ページが見つかりません' };

    let targetFiles;
    try {
      const chunks = await parser.parseAndExpand(io, page.ejsRel);
      targetFiles = new Set(chunks.map((c) => c.file));
      targetFiles.add(page.ejsRel);
    } catch (e) {
      return { ok: false, error: `対象ファイルの解析に失敗しました: ${errorMessage(e)}` };
    }

    const restoredFiles = [];
    for (const rel of targetFiles) {
      if (await io.restoreEjs(rel)) restoredFiles.push(await io.absPath('ejs', rel));
    }

    if (restoredFiles.length === 0) {
      return { ok: false, error: 'バックアップが見つかりません' };
    }

    const updatedPage = await reScanPage(page);
    return { ok: true, restoredFiles, updatedPage };
  }

  // 画面から渡ってきた絶対パスが、直近のスキャン結果に含まれる正当なファイルかを調べて、ルートからの相対パスにする。
  // 任意のパスでの操作(エディタの起動・フォルダを開く)を防ぐための安全策。
  function knownEjsFile(absPath) {
    for (const page of lastPages) {
      if (page.ejsPath === absPath) return page.ejsRel;
      if (page.patches) {
        for (const p of page.patches) {
          if (p.file === absPath) return p.fileRel;
        }
      }
    }
    return null;
  }

  function knownPath(absPath) {
    const ejsRel = knownEjsFile(absPath);
    if (ejsRel) return { which: 'ejs', rel: ejsRel };
    for (const page of lastPages) {
      // 公開サーバーから取得した HTML は、手元のフォルダではないので、フォルダを開く対象にしない
      if (page.htmlPath === absPath && page.htmlRel && !/^https?:\/\//i.test(absPath)) {
        return { which: 'html', rel: page.htmlRel };
      }
    }
    return null;
  }

  return {
    scan,
    scanRemote,
    applyPatch,
    applyAllAuto,
    applyAllPages,
    restoreBackup,
    knownEjsFile,
    knownPath,
    getPages: () => lastPages,
  };
}
