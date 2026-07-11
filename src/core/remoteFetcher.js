const fs = require('fs');
const path = require('path');

const scanner = require('./scanner');

const FETCH_TIMEOUT_MS = 15000;
const CRAWL_DEFAULT_LIMIT = 200; // リンククロールで新たにfetchするページ数の上限
const SITEMAPINDEX_MAX_CHILDREN = 10; // sitemapindexから辿る子sitemapの上限
const SITEMAPINDEX_MAX_DEPTH = 3; // 子sitemapがさらにsitemapindexだった場合の再帰上限

// EJSファイルのrelPathから、公開サーバー上のHTML相対パスを組み立てる。
// パス区切りはURL用に常に'/'へ正規化する。
function toRelHtmlPath(ejsPath, ejsRoot) {
  const rel = path.relative(ejsRoot, ejsPath);
  const relHtml = rel.replace(/\.ejs$/, '.html');
  return relHtml.split(path.sep).join('/');
}

// baseUrlとrelPathを二重スラッシュにならないように結合する。
function joinUrl(base, relPath) {
  const b = String(base).replace(/\/+$/, '');
  const r = String(relPath).replace(/^\/+/, '');
  return b + '/' + r;
}

// sitemap.xmlの<loc>URLを、baseUrl配下のローカル相対パスに変換する。
// baseUrl外のURLはnullを返す(呼び出し側で除外する)。
// 末尾が'/'の場合は'index.html'を補い、'.html'で終わらないパスには'/index.html'を補う。
function sitemapUrlToRelPath(locUrl, baseUrl) {
  let u;
  let b;
  try {
    u = new URL(locUrl);
    b = new URL(baseUrl);
  } catch (e) {
    return null;
  }
  if (u.origin !== b.origin) return null;

  let basePath = b.pathname;
  if (!basePath.endsWith('/')) basePath += '/';

  if (!u.pathname.startsWith(basePath)) return null;

  let rel = u.pathname.slice(basePath.length);
  if (rel === '' || rel.endsWith('/')) {
    rel += 'index.html';
  } else if (!rel.toLowerCase().endsWith('.html')) {
    rel += '/index.html';
  }
  return rel;
}

// HTML文字列から<a href="...">のhref値を全部抜き出す(href='...'/href="..."両対応、大文字小文字無視)。
function extractHrefs(html) {
  const hrefs = [];
  const re = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1] !== undefined ? m[1] : m[2];
    if (href) hrefs.push(href);
  }
  return hrefs;
}

// リンククロール用: hrefをpageUrl基準で解決し、baseUrl配下のローカル相対パスに変換する。
// mailto:/tel:/javascript:、外部オリジン、baseUrl配下でないパスはnullを返す。
// 末尾'/' -> 'index.html'補完、'.html'終わり -> そのまま、拡張子無し -> '/index.html'補完、
// それ以外の拡張子(.jpg/.css/.js/.pdf等) -> null(対象外)。
function resolveCrawlRelPath(href, pageUrl, baseUrl) {
  const trimmed = String(href || '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('mailto:') || lower.startsWith('tel:') || lower.startsWith('javascript:')) return null;

  let resolved;
  let base;
  try {
    resolved = new URL(trimmed, pageUrl);
    base = new URL(baseUrl);
  } catch (e) {
    return null;
  }
  if (resolved.origin !== base.origin) return null;

  let basePath = base.pathname;
  if (!basePath.endsWith('/')) basePath += '/';
  if (!resolved.pathname.startsWith(basePath)) return null;

  let rel = resolved.pathname.slice(basePath.length);
  if (rel === '' || rel.endsWith('/')) {
    rel += 'index.html';
  } else if (rel.toLowerCase().endsWith('.html')) {
    // そのまま
  } else if (/\.[a-z0-9]+$/i.test(rel)) {
    return null; // .html以外の拡張子は対象外
  } else {
    rel += '/index.html';
  }
  return rel;
}

// baseUrl配下の1ページ分を取得し、destDir配下へ同じ相対パスで保存する。
// authHeaderが指定されていれば、全リクエストにAuthorizationヘッダとして付与する。
// 成功時はtextも返す(sitemap/クロール処理でリンク抽出のシードとして使うため)。
async function fetchOne(baseUrl, relHtmlPath, destDir, authHeader) {
  const url = joinUrl(baseUrl, relHtmlPath);
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
    return { relHtmlPath, url, ok: true, status: res.status, text };
  } catch (e) {
    const message = e.name === 'AbortError' ? 'タイムアウトしました' : e.message;
    return { relHtmlPath, url, ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

// robots.txt/sitemap.xml確認用: 取得のみ行い、保存はしない。
async function fetchTextOnly(url, authHeader, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchOptions = { signal: controller.signal };
    if (authHeader) fetchOptions.headers = { Authorization: authHeader };
    const res = await fetch(url, fetchOptions);
    if (!res.ok) {
      const err = new Error(`HTTPステータス ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('タイムアウトしました');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// origin直下のrobots.txtを取得し、"Sitemap:"行(大文字小文字無視)のURLを一覧で返す。
// 取得に失敗した場合は空配列を返す(呼び出し側で無視する)。
async function fetchRobotsSitemaps(origin, authHeader) {
  try {
    const text = await fetchTextOnly(origin + '/robots.txt', authHeader);
    const urls = [];
    const re = /^\s*sitemap\s*:\s*(\S+)\s*$/gim;
    let m;
    while ((m = re.exec(text)) !== null) {
      const url = m[1].trim();
      if (url) urls.push(url);
    }
    return urls;
  } catch (e) {
    return [];
  }
}

// sitemap XMLを1件取得して<loc>一覧を返す。<sitemapindex>形式の場合は子sitemapを
// 順に辿って(最大SITEMAPINDEX_MAX_CHILDREN個、再帰深さSITEMAPINDEX_MAX_DEPTHまで)
// 集約した<loc>一覧を返す。子sitemapの取得失敗は無視して他の子を続行する。
async function fetchSitemapLocsFromXml(url, authHeader, depth = 0) {
  const text = await fetchTextOnly(url, authHeader);
  const locs = [];
  const re = /<loc>(.*?)<\/loc>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const loc = m[1].trim();
    if (loc) locs.push(loc);
  }
  if (/<sitemapindex[\s>]/i.test(text) && depth < SITEMAPINDEX_MAX_DEPTH) {
    const childUrls = locs.slice(0, SITEMAPINDEX_MAX_CHILDREN);
    const aggregated = [];
    for (const childUrl of childUrls) {
      try {
        const childLocs = await fetchSitemapLocsFromXml(childUrl, authHeader, depth + 1);
        aggregated.push(...childLocs);
      } catch (e) {
        // 子sitemapの取得失敗は無視して他の子を続行する
      }
    }
    return aggregated;
  }
  return locs;
}

// sitemap候補を順に試して<loc>のURL一覧を返す。
// 候補は「robots.txtのSitemap:行のURL」を先頭に、次いでorigin直下・baseUrl直下のsitemap.xmlを試す。
// 最初に成功した候補の結果を採用する(sitemapindexなら子sitemapも辿った上で集約済み)。
// すべて失敗したらnullを返す(呼び出し側でスキップ扱いにする)。
async function fetchSitemapLocs(baseUrl, authHeader) {
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch (e) {
    return null;
  }
  const robotsSitemaps = await fetchRobotsSitemaps(origin, authHeader);
  const candidates = Array.from(new Set([
    ...robotsSitemaps,
    origin + '/sitemap.xml',
    joinUrl(baseUrl, 'sitemap.xml'),
  ]));
  for (const url of candidates) {
    try {
      return await fetchSitemapLocsFromXml(url, authHeader);
    } catch (e) {
      // 次の候補を試す
    }
  }
  return null;
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

// リンクを辿って新規ページ(EJS由来一覧にもsitemapにも無いページ)を検出する(BFS)。
// シード(seedTexts: 取得済みHTML群)と baseUrl自体から<a href>を抽出し、baseUrl配下かつ
// 未知のページのみfetch+保存する(同時concurrency件)。取得できたHTMLもさらにクロール対象に加える。
// fetch試行数がcrawlLimitに達したら打ち切る(limitReached=trueを返す)。404等の失敗URLは結果に含めない。
async function crawlForNewPages({ baseUrl, destDir, authHeader, knownPathSet, foundPathSet, seedTexts, crawlLimit = CRAWL_DEFAULT_LIMIT, concurrency = 4 }) {
  const queue = [];
  const queued = new Set(); // キュー投入済みrelPath(重複fetch防止)
  const newPages = [];
  let fetchCount = 0;
  let limitReached = false;

  function enqueueFromHtml(html, pageUrl) {
    for (const href of extractHrefs(html)) {
      const rel = resolveCrawlRelPath(href, pageUrl, baseUrl);
      if (!rel) continue;
      if (knownPathSet.has(rel) || foundPathSet.has(rel) || queued.has(rel)) continue;
      queued.add(rel);
      queue.push(rel);
    }
  }

  for (const seed of seedTexts) {
    enqueueFromHtml(seed.text, joinUrl(baseUrl, seed.relPath));
  }
  try {
    const baseHtml = await fetchTextOnly(baseUrl, authHeader);
    enqueueFromHtml(baseHtml, baseUrl);
  } catch (e) {
    // baseUrl自体が取得できなくても、既知ページのリンクだけで探索を続ける
  }

  while (queue.length > 0) {
    if (fetchCount >= crawlLimit) {
      limitReached = true;
      break;
    }
    const remaining = crawlLimit - fetchCount;
    const batch = queue.splice(0, Math.min(concurrency, remaining));
    fetchCount += batch.length;

    const results = await runPool(batch, concurrency, (rel) => fetchOne(baseUrl, rel, destDir, authHeader));

    for (const r of results) {
      if (!r.ok) continue; // 404等の失敗はノイズにしないため黙って除外
      foundPathSet.add(r.relHtmlPath);
      newPages.push(r);
      if (r.text !== undefined) enqueueFromHtml(r.text, r.url);
    }
  }
  if (queue.length > 0 && fetchCount >= crawlLimit) limitReached = true;

  return { newPages, limitReached };
}

// EJSソース一覧に対応する公開HTMLを、baseUrlから取得してdestDir配下へ保存する。
// scope指定がある場合はejsRoot配下の該当サブディレクトリのみを対象にする。
// basicUser/basicPassが両方とも非空の場合、全リクエストにBasic認証ヘッダを付与する。
// crawl:trueの場合、sitemap.xml/robots.txtに加えリンククロールでも新規ページ(EJS由来に無いページ)を
// 探し、見つかったページもdestDir配下へ保存する(scanAllの新規ページ検出がそのまま拾えるように)。
async function fetchSite({ ejsRoot, scope, baseUrl, destDir, concurrency = 4, basicUser, basicPass, crawl, crawlLimit }) {
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

  const knownPathSet = new Set(relHtmlPaths);
  const foundPathSet = new Set(); // sitemap・クロールの両方を通じて既に発見済みのrelPath(重複検出防止に共用)
  const seedTexts = [];
  for (const r of results) {
    if (r.ok && r.text !== undefined) seedTexts.push({ relPath: r.relHtmlPath, text: r.text });
  }

  // sitemap.xml(robots.txt由来の候補・sitemapindex対応)による新規ページ検出
  let sitemapNewCount = 0;
  let sitemapUnavailable = false;
  let sitemapError = false;
  try {
    const locs = await fetchSitemapLocs(baseUrl, authHeader);
    if (locs) {
      for (const loc of locs) {
        const rel = sitemapUrlToRelPath(loc, baseUrl);
        if (!rel || knownPathSet.has(rel) || foundPathSet.has(rel)) continue;
        const r = await fetchOne(baseUrl, rel, destDir, authHeader);
        if (r.ok) {
          foundPathSet.add(rel);
          sitemapNewCount++;
          if (r.text !== undefined) seedTexts.push({ relPath: rel, text: r.text });
        }
        // 取得失敗(404等)は一覧に含めない(サーバー側のエラーとして黙って除外する)
      }
    } else {
      sitemapUnavailable = true;
    }
  } catch (e) {
    sitemapError = true;
  }

  // リンククロールによる新規ページ検出(オプション、crawl:trueの場合のみ)
  let crawlNewCount = 0;
  let crawlLimitReached = false;
  if (crawl) {
    try {
      const { newPages, limitReached } = await crawlForNewPages({
        baseUrl,
        destDir,
        authHeader,
        knownPathSet,
        foundPathSet,
        seedTexts,
        crawlLimit: crawlLimit || CRAWL_DEFAULT_LIMIT,
        concurrency,
      });
      crawlLimitReached = limitReached;
      crawlNewCount = newPages.length;
    } catch (e) {
      // クロール全体の予期しない失敗は、それまでに見つかった分を活かして黙って打ち切る
    }
  }

  // noteの組み立て: sitemap未検出/エラーの案内 + 検出手段別の件数内訳 + 上限到達の案内
  const noteParts = [];
  if (sitemapUnavailable) {
    noteParts.push('sitemap.xml が見つからないため、sitemapからの新規ページ検出はスキップしました。');
  } else if (sitemapError) {
    noteParts.push('sitemap.xml の確認中にエラーが発生したため、sitemapからの新規ページ検出はスキップしました。');
  }
  if (sitemapNewCount > 0 || crawlNewCount > 0) {
    const breakdown = [];
    if (sitemapNewCount > 0) breakdown.push(`sitemapから${sitemapNewCount}件`);
    if (crawlNewCount > 0) breakdown.push(`リンククロールから${crawlNewCount}件`);
    noteParts.push(`新規ページ: ${breakdown.join('、')}`);
  }
  if (crawlLimitReached) {
    noteParts.push(`リンククロールの取得上限(${crawlLimit || CRAWL_DEFAULT_LIMIT}件)に達したため、途中で打ち切りました。`);
  }
  const note = noteParts.join(' ');

  return {
    results,
    okCount,
    failCount,
    authFailed,
    newPageCount: sitemapNewCount + crawlNewCount,
    note,
  };
}

module.exports = {
  fetchSite,
  toRelHtmlPath,
  joinUrl,
  sitemapUrlToRelPath,
  extractHrefs,
  resolveCrawlRelPath,
  fetchRobotsSitemaps,
  fetchSitemapLocsFromXml,
  fetchSitemapLocs,
  crawlForNewPages,
};
