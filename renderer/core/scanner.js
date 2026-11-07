import * as parser from './ejsLiteParser.js';
import * as renderer from './ejsLiteRenderer.js';
import * as diffMapper from './diffMapper.js';
import { toHtmlRel, sanitizeScope, errorMessage } from './relPath.js';

// 入出力は `io`(Tauri では Rust のコマンド、テストでは偽物)と、`htmlSource`(公開 HTML の置き場)で行う。
// パスは、すべて「ルートからの相対パス(/ 区切り)」。画面に見せる絶対パスは、`io.absPath` で作る。
//
// io:
//   readEjs(rel) / listEjs(scopeRel) / dirExists(which, rel) / absPath(which, rel)
// htmlSource:
//   exists(rel) -> bool / read(rel) -> text / list(scopeRel) -> 相対パスの配列 / absPath(rel) -> 表示用のパス

// EJS1ファイル分のスキャンを行う。scanAllからも、パッチ適用後の再検証(ejsSync.js)からも使う。
async function scanPage(io, htmlSource, ejsRel, htmlRel, relPath) {
  const ejsPath = await io.absPath('ejs', ejsRel);
  const htmlPath = await htmlSource.absPath(htmlRel);
  if (!(await htmlSource.exists(htmlRel))) {
    return { relPath, ejsPath, ejsRel, htmlPath, htmlRel, status: 'missing-html' };
  }

  try {
    const chunks = await parser.parseAndExpand(io, ejsRel);
    const { html, segments } = await renderer.render(chunks, {}, io.runTemplate);
    const deployedHtml = await htmlSource.read(htmlRel);

    if (html === deployedHtml) {
      return { relPath, ejsPath, ejsRel, htmlPath, htmlRel, status: 'identical' };
    }

    const rawPatches = diffMapper.computePatches(html, segments, deployedHtml);
    const patches = [];
    for (let i = 0; i < rawPatches.length; i++) {
      const p = rawPatches[i];
      // file: 画面に出す絶対パス / fileRel: EJS ルートからの相対パス(書き換えや「エディタで開く」に使う)
      patches.push({ ...p, id: `${relPath}::${i}`, fileRel: p.file, file: p.file ? await io.absPath('ejs', p.file) : undefined });
    }

    return {
      relPath,
      ejsPath,
      ejsRel,
      htmlPath,
      htmlRel,
      status: 'diff',
      autoCount: patches.filter((p) => p.confidence === 'auto').length,
      reviewCount: patches.filter((p) => p.confidence === 'review').length,
      patches,
    };
  } catch (e) {
    return { relPath, ejsPath, ejsRel, htmlPath, htmlRel, status: 'error', error: errorMessage(e) };
  }
}

async function scanAll(io, htmlSource, { scope }) {
  const normalizedScope = sanitizeScope(scope);
  if (normalizedScope && !(await io.dirExists('ejs', normalizedScope))) {
    throw new Error(`指定ディレクトリが存在しません: ${normalizedScope}`);
  }
  const ejsFiles = await io.listEjs(normalizedScope);
  const pages = [];
  const knownHtmlRels = new Set(); // EJS起点で導出済みのhtmlRel(新規ページ検出の除外用)

  for (const ejsRel of ejsFiles) {
    const htmlRel = toHtmlRel(ejsRel);
    pages.push(await scanPage(io, htmlSource, ejsRel, htmlRel, ejsRel));
    knownHtmlRels.add(htmlRel);
  }

  // 新規ページ検出: 公開HTML側(+scope配下)にはあるが、EJS起点では見つからなかった公開HTML。
  // クライアントが本番へ直接追加した可能性があるページを 'html-only' として一覧に加える。
  const htmlFiles = await htmlSource.list(normalizedScope);
  for (const htmlRel of htmlFiles) {
    if (knownHtmlRels.has(htmlRel)) continue;
    pages.push({ relPath: htmlRel, htmlPath: await htmlSource.absPath(htmlRel), htmlRel, status: 'html-only' });
  }

  return pages;
}

export { scanAll, scanPage };
