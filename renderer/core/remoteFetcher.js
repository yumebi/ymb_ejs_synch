// 公開サーバーから、EJS に対応する HTML(と、EJS 由来に無い新規ページ)を取得する。
// 取得した HTML は、ファイルに保存せず、メモリ(`store`: 相対パス -> テキスト)に持つ。
// 通信は `io.fetchText(url, auth, timeoutMs, maxBytes)`(Tauri では Rust のコマンド、テストでは偽物)で行う。

import { sanitizeScope, toHtmlRel } from './relPath.js';

const FETCH_TIMEOUT_MS = 15000;
const MAX_REMOTE_BYTES = 8 * 1024 * 1024; // リモートから取得する1レスポンスのサイズ上限
const CRAWL_DEFAULT_LIMIT = 200; // リンククロールで新たにfetchするページ数の上限
const SITEMAPINDEX_MAX_CHILDREN = 10; // sitemapindexから辿る子sitemapの上限
const SITEMAPINDEX_MAX_DEPTH = 3; // 子sitemapがさらにsitemapindexだった場合の再帰上限

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
// フラグメント(#)・クエリ(?)はURL解決の時点で自動的に無視される(pathnameのみ使うため)。
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

// 2つのURLが同一オリジン(scheme+host+port)かどうかを判定する。不正なURLはfalse。
function isSameOrigin(urlStr, referenceUrl) {
  try {
    return new URL(urlStr).origin === new URL(referenceUrl).origin;
  } catch (e) {
    return false;
  }
}

// Basic認証で資格情報を送る場合、HTTPS(またはローカルホスト)に限定する。平文HTTPへの資格情報送信を防ぐ。
function isSecureTransport(baseUrl) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch (e) {
    return false;
  }
  if (u.protocol === 'https:') return true;
  const host = u.hostname.toLowerCase();
  return u.protocol === 'http:' &&
    (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1');
}

// UTF-8 の文字列を Base64 にする(ブラウザの btoa は Latin-1 だけなので、先にバイト列にする)。
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function errorMessage(e) {
  if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;
  return String(e);
}

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

/**
 * 取得処理を、`io` を閉じ込めた形で作る。
 * store: 取得できた HTML を入れるメモリ(Map)。relHtmlPath -> text。
 */
export function createRemoteFetcher(io, store) {
  // 1ページ取得して、できたら store に入れる。失敗は、{ ok: false, status?, error? } で返す(例外にしない)。
  async function fetchOne(baseUrl, relHtmlPath, authHeader) {
    const url = joinUrl(baseUrl, relHtmlPath);
    try {
      const text = await io.fetchText(url, authHeader, FETCH_TIMEOUT_MS, MAX_REMOTE_BYTES);
      store.set(relHtmlPath, text);
      return { relHtmlPath, url, ok: true, status: 200, text };
    } catch (e) {
      const status = e && typeof e === 'object' && e.status !== undefined && e.status !== null ? e.status : undefined;
      if (status !== undefined) return { relHtmlPath, url, ok: false, status };
      return { relHtmlPath, url, ok: false, error: errorMessage(e) };
    }
  }

  async function fetchTextOnly(url, authHeader, timeoutMs = FETCH_TIMEOUT_MS) {
    try {
      return await io.fetchText(url, authHeader, timeoutMs, MAX_REMOTE_BYTES);
    } catch (e) {
      const err = new Error(errorMessage(e));
      if (e && typeof e === 'object' && e.status !== undefined) err.status = e.status;
      throw err;
    }
  }

  // origin直下のrobots.txtを取得し、"Sitemap:"行(大文字小文字無視)のURLを一覧で返す。失敗したら空配列。
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

  // sitemap XMLを1件取得して<loc>一覧を返す。<sitemapindex>形式の場合は子sitemapを順に辿って集約する。
  // SSRF対策として、<loc>・子sitemapのURLは、同一オリジンのものだけ採用する(Basic認証情報の外部送信も防ぐ)。
  async function fetchSitemapLocsFromXml(url, authHeader, depth = 0, rootOrigin = null) {
    const text = await fetchTextOnly(url, authHeader);
    const allowed = rootOrigin ?? url;
    const locs = [];
    const re = /<loc>(.*?)<\/loc>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const loc = m[1].trim();
      if (loc && isSameOrigin(loc, allowed)) locs.push(loc);
    }
    if (/<sitemapindex[\s>]/i.test(text) && depth < SITEMAPINDEX_MAX_DEPTH) {
      const childUrls = locs.slice(0, SITEMAPINDEX_MAX_CHILDREN);
      const aggregated = [];
      for (const childUrl of childUrls) {
        try {
          const childLocs = await fetchSitemapLocsFromXml(childUrl, authHeader, depth + 1, allowed);
          aggregated.push(...childLocs);
        } catch (e) {
          // 子sitemapの取得失敗は無視して他の子を続行する
        }
      }
      return aggregated;
    }
    return locs;
  }

  // sitemap候補(robots.txtのSitemap:行 → origin直下 → baseUrl直下)を順に試す。すべて失敗したらnull。
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
        return await fetchSitemapLocsFromXml(url, authHeader, 0, origin);
      } catch (e) {
        // 次の候補を試す
      }
    }
    return null;
  }

  // リンクを辿って新規ページ(EJS由来に無いページ)を検出する(BFS)。
  async function crawlForNewPages({ baseUrl, authHeader, knownPathSet, foundPathSet, seedTexts, crawlLimit = CRAWL_DEFAULT_LIMIT, concurrency = 4 }) {
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

      const results = await runPool(batch, concurrency, (rel) => fetchOne(baseUrl, rel, authHeader));

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

  // EJSに対応する全ページを取得する(失敗したページも、結果に含めて返す)。さらに sitemap.xml と、
  // crawl:true ならリンククロールで、EJS由来に無い新規ページも取得する。
  async function fetchSite({ scope, baseUrl, concurrency = 4, basicUser, basicPass, crawl, crawlLimit }) {
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error(`URLはhttp/httpsのみ許可されています: ${baseUrl}`);
    }
    // Basic認証を使う場合はHTTPS(またはローカルホスト)を強制する。
    if ((basicUser || basicPass) && !isSecureTransport(baseUrl)) {
      throw new Error('Basic認証を使う場合はHTTPS(またはローカルホスト)のサーバーを指定してください');
    }

    const normalizedScope = sanitizeScope(scope);
    if (normalizedScope && !(await io.dirExists('ejs', normalizedScope))) {
      throw new Error(`指定ディレクトリが存在しません: ${normalizedScope}`);
    }

    const authHeader = basicUser && basicPass ? 'Basic ' + toBase64(`${basicUser}:${basicPass}`) : null;

    const ejsFiles = await io.listEjs(normalizedScope);
    const relHtmlPaths = ejsFiles.map((ejsRel) => toHtmlRel(ejsRel));

    const results = await runPool(relHtmlPaths, concurrency, (relHtmlPath) => fetchOne(baseUrl, relHtmlPath, authHeader));

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
          const r = await fetchOne(baseUrl, rel, authHeader);
          if (r.ok) {
            foundPathSet.add(rel);
            sitemapNewCount++;
            if (r.text !== undefined) seedTexts.push({ relPath: rel, text: r.text });
          }
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

  return { fetchSite, fetchOne, fetchRobotsSitemaps, fetchSitemapLocsFromXml, fetchSitemapLocs, crawlForNewPages };
}

export { joinUrl, sitemapUrlToRelPath, extractHrefs, resolveCrawlRelPath, isSecureTransport };
