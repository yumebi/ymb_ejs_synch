const fs = require('fs');
const path = require('path');

const scanner = require('./scanner');

const FETCH_TIMEOUT_MS = 15000;

// EJSファイルのrelPathから、公開サーバー上のHTML相対パスを組み立てる。
// パス区切りはURL用に常に'/'へ正規化する。
function toRelHtmlPath(ejsPath, ejsRoot) {
  const rel = path.relative(ejsRoot, ejsPath);
  const relHtml = rel.replace(/\.ejs$/, '.html');
  return relHtml.split(path.sep).join('/');
}

// baseUrl配下の1ページ分を取得し、destDir配下へ同じ相対パスで保存する。
// authHeaderが指定されていれば、全リクエストにAuthorizationヘッダとして付与する。
async function fetchOne(baseUrl, relHtmlPath, destDir, authHeader) {
  const url = `${baseUrl.replace(/\/+$/, '')}/${relHtmlPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const fetchOptions = { signal: controller.signal };
    if (authHeader) {
      fetchOptions.headers = { Authorization: authHeader };
    }
    const res = await fetch(url, fetchOptions);
    if (!res.ok) {
      return { relHtmlPath, url, ok: false, status: res.status };
    }
    const text = await res.text();
    const destPath = path.join(destDir, ...relHtmlPath.split('/'));
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, text, 'utf8');
    return { relHtmlPath, url, ok: true, status: res.status };
  } catch (e) {
    const message = e.name === 'AbortError' ? 'タイムアウトしました' : e.message;
    return { relHtmlPath, url, ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

// 簡易ワーカープール: タスク配列をconcurrency個の並列ワーカーで消費する。
async function runPool(tasks, concurrency, worker) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const i = nextIndex++;
      if (i >= tasks.length) return;
      results[i] = await worker(tasks[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

// EJSソース一覧に対応する公開HTMLを、baseUrlから取得してdestDir配下へ保存する。
// scope指定がある場合はejsRoot配下の該当サブディレクトリのみを対象にする。
// basicUser/basicPassが両方とも非空の場合、全リクエストにBasic認証ヘッダを付与する。
async function fetchSite({ ejsRoot, scope, baseUrl, destDir, concurrency = 4, basicUser, basicPass }) {
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error(`URLはhttp/httpsのみ許可されています: ${baseUrl}`);
  }

  const startDir = scope ? path.join(ejsRoot, scope) : ejsRoot;
  if (!fs.existsSync(startDir)) {
    throw new Error(`指定ディレクトリが存在しません: ${startDir}`);
  }

  const authHeader = basicUser && basicPass
    ? 'Basic ' + Buffer.from(`${basicUser}:${basicPass}`).toString('base64')
    : null;

  const ejsFiles = scanner.walkEjsFiles(startDir);
  const relHtmlPaths = ejsFiles.map((ejsPath) => toRelHtmlPath(ejsPath, ejsRoot));

  const results = await runPool(relHtmlPaths, concurrency, (relHtmlPath) =>
    fetchOne(baseUrl, relHtmlPath, destDir, authHeader)
  );

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  const authFailed = results.some((r) => !r.ok && r.status === 401);

  return { results, okCount, failCount, authFailed };
}

module.exports = { fetchSite, toRelHtmlPath };
