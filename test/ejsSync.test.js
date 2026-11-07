import test from 'node:test';
import assert from 'node:assert/strict';
import { createEjsSync } from '../renderer/core/ejsSync.js';
import { resolveFrom, extname, dirname, sanitizeScope, toHtmlRel } from '../renderer/core/relPath.js';
import * as parser from '../renderer/core/ejsLiteParser.js';

// 偽の入出力。EJS ソースと公開 HTML を、メモリの上に持つ。
function fakeIo({ ejs = {}, html = {}, remote = {} } = {}) {
  const ejsFiles = new Map(Object.entries(ejs));
  const htmlFiles = new Map(Object.entries(html));
  const backups = new Map();
  const calls = { fetch: [], writes: [], roots: [] };
  const isPage = (name) => name.endsWith('.ejs') && !name.split('/').pop().startsWith('_') && !name.split('/').includes('module');
  const under = (k, scope) => !scope || k.startsWith(scope + '/');
  const which = (w) => (w === 'ejs' ? ejsFiles : htmlFiles);
  return {
    ejsFiles, htmlFiles, backups, calls,
    async setRoots(e, h) { calls.roots.push([e, h]); },
    async dirExists(w, rel) { return [...which(w).keys()].some((k) => k.startsWith(rel + '/')); },
    async listEjs(scope) { return [...ejsFiles.keys()].filter((k) => isPage(k) && under(k, scope)).sort(); },
    async listHtml(scope) { return [...htmlFiles.keys()].filter((k) => k.toLowerCase().endsWith('.html') && under(k, scope)).sort(); },
    async absPath(w, rel) { return `/${w}/${rel}`; },
    async pathExists(w, rel) { return which(w).has(rel); },
    async readText(w, rel) {
      if (!which(w).has(rel)) throw new Error('ENOENT: ' + rel);
      return which(w).get(rel);
    },
    async readEjs(rel) {
      if (!ejsFiles.has(rel)) throw new Error('ENOENT: ' + rel);
      return ejsFiles.get(rel);
    },
    async writeEjs(rel, text, backup) {
      calls.writes.push({ rel, backup });
      if (backup && ejsFiles.has(rel) && !backups.has(rel)) backups.set(rel, ejsFiles.get(rel));
      ejsFiles.set(rel, text);
    },
    async restoreEjs(rel) {
      if (!backups.has(rel)) return false;
      ejsFiles.set(rel, backups.get(rel));
      return true;
    },
    async fetchText(url, auth) {
      calls.fetch.push({ url, auth });
      if (url in remote) return remote[url];
      throw { message: 'HTTPステータス 404', status: 404 };
    },
    async openInEditor() { return null; },
    async reveal() {},
  };
}

const ROOTS = { ejsRoot: '/ejs', htmlRoot: '/html', scope: '' };

test('relPath: ルートの外・絶対パスは null', () => {
  assert.equal(resolveFrom('a/b/page.ejs', '../module/_head.ejs'), 'a/module/_head.ejs');
  assert.equal(resolveFrom('page.ejs', 'module/_head.ejs'), 'module/_head.ejs');
  assert.equal(resolveFrom('page.ejs', '../x.ejs'), null);
  assert.equal(resolveFrom('page.ejs', '/etc/x.ejs'), null);
  assert.equal(resolveFrom('page.ejs', 'C:/x.ejs'), null);
  assert.equal(resolveFrom('page.ejs', 'a\\b.ejs'), null);
  assert.equal(extname('a/b.d/c'), '');
  assert.equal(extname('a/_head.ejs'), '.ejs');
  assert.equal(dirname('a/b/c.ejs'), 'a/b');
  assert.equal(toHtmlRel('a/b.ejs'), 'a/b.html');
  assert.equal(sanitizeScope('/a/b/'), 'a/b');
  assert.throws(() => sanitizeScope('a/../b'), /\.\./);
});

test('parser: レガシー・モダンの include を展開し、コメントは読み飛ばす', async () => {
  const io = fakeIo({
    ejs: {
      'p/index.ejs': '<%# メモ %>A<%- include ../module/_head %>B<%- include("../module/_foot.ejs") %>C',
      'module/_head.ejs': '[head]',
      'module/_foot.ejs': '[foot]',
    },
  });
  const chunks = await parser.parseAndExpand(io, 'p/index.ejs');
  assert.deepEqual(chunks.map((c) => c.text), ['A', '[head]', 'B', '[foot]', 'C']);
  assert.deepEqual(chunks.map((c) => c.file), ['p/index.ejs', 'module/_head.ejs', 'p/index.ejs', 'module/_foot.ejs', 'p/index.ejs']);
});

test('parser: 循環参照とルート外の include は、エラー', async () => {
  const io = fakeIo({ ejs: { 'a.ejs': '<%- include b %>', 'b.ejs': '<%- include a %>', 'x.ejs': '<%- include ../outside %>' } });
  await assert.rejects(() => parser.parseAndExpand(io, 'a.ejs'), /循環参照/);
  await assert.rejects(() => parser.parseAndExpand(io, 'x.ejs'), /ルートの外/);
});

test('scan: 一致・差分(自動)・公開HTML無し・公開側にだけある、を分ける。module と _ 始まりはページにしない', async () => {
  const io = fakeIo({
    ejs: {
      'index.ejs': '<p>同じ</p>',
      'news.ejs': '<p>古い</p>',
      'draft.ejs': '<p>未公開</p>',
      'module/_head.ejs': '[h]',
      '_part.ejs': '[p]',
    },
    html: { 'index.html': '<p>同じ</p>', 'news.html': '<p>新しい</p>', 'extra.html': '<p>追加</p>' },
  });
  const sync = createEjsSync(io);
  const pages = await sync.scan(ROOTS);
  const by = Object.fromEntries(pages.map((p) => [p.relPath, p]));
  assert.deepEqual(Object.keys(by).sort(), ['draft.ejs', 'extra.html', 'index.ejs', 'news.ejs']);
  assert.equal(by['index.ejs'].status, 'identical');
  assert.equal(by['news.ejs'].status, 'diff');
  assert.equal(by['draft.ejs'].status, 'missing-html');
  assert.equal(by['extra.html'].status, 'html-only');
  assert.equal(by['news.ejs'].autoCount, 1);
  const p = by['news.ejs'].patches[0];
  assert.equal(p.file, '/ejs/news.ejs');
  assert.equal(p.fileRel, 'news.ejs');
  assert.equal(by['news.ejs'].ejsPath, '/ejs/news.ejs');
  assert.deepEqual(io.calls.roots, [['/ejs', '/html']]);
});

test('scan: scope で絞る。存在しない scope は、エラー', async () => {
  const io = fakeIo({
    ejs: { 'a/x.ejs': '1', 'b/y.ejs': '2' },
    html: { 'a/x.html': '1', 'b/y.html': '2' },
  });
  const sync = createEjsSync(io);
  const pages = await sync.scan({ ...ROOTS, scope: 'a' });
  assert.deepEqual(pages.map((p) => p.relPath), ['a/x.ejs']);
  await assert.rejects(() => sync.scan({ ...ROOTS, scope: 'zzz' }), /存在しません/);
});

test('applyPatch: 書き換えて .bak を初回だけ残し、再スキャンで一致になる', async () => {
  const io = fakeIo({ ejs: { 'news.ejs': '<p>古い</p>' }, html: { 'news.html': '<p>新しい</p>' } });
  const sync = createEjsSync(io);
  const [page] = await sync.scan(ROOTS);
  const r = await sync.applyPatch(page.patches[0].id);
  assert.equal(r.ok, true);
  assert.equal(r.updatedPage.status, 'identical');
  assert.equal(io.ejsFiles.get('news.ejs'), '<p>新しい</p>');
  assert.equal(io.backups.get('news.ejs'), '<p>古い</p>');
  assert.equal((await sync.applyPatch('nothing::0')).ok, false);
});

test('applyPatch: 適用前に、元の文字列が変わっていたら中止(書き込まない)', async () => {
  const io = fakeIo({ ejs: { 'news.ejs': '<p>古い</p>' }, html: { 'news.html': '<p>新しい</p>' } });
  const sync = createEjsSync(io);
  const [page] = await sync.scan(ROOTS);
  io.ejsFiles.set('news.ejs', '<p>誰かが書き換えた</p>');
  const r = await sync.applyPatch(page.patches[0].id);
  assert.equal(r.ok, false);
  assert.match(r.error, /想定と異なる/);
  assert.equal(io.calls.writes.length, 0);
});

test('applyAllAuto / applyAllPages: 自動パッチをまとめて適用する', async () => {
  const io = fakeIo({
    ejs: { 'a.ejs': '<p>A古</p>', 'b.ejs': '<p>B古</p>', 'c.ejs': '<p>同じ</p>' },
    html: { 'a.html': '<p>A新</p>', 'b.html': '<p>B新</p>', 'c.html': '<p>同じ</p>' },
  });
  const sync = createEjsSync(io);
  await sync.scan(ROOTS);
  const one = await sync.applyAllAuto('a.ejs');
  assert.equal(one.ok, true);
  assert.equal(one.updatedPage.status, 'identical');
  const all = await sync.applyAllPages();
  assert.deepEqual(all.summary.map((s) => [s.relPath, s.appliedCount, s.status]), [['b.ejs', 1, 'identical']]);
  assert.equal((await sync.applyAllAuto('missing.ejs')).ok, false);
});

test('restoreBackup: ページと include の全ファイルを .bak から戻す。無ければ失敗', async () => {
  const io = fakeIo({
    ejs: { 'p.ejs': '<%- include module/_h %>'+'\n'+'本文古', 'module/_h.ejs': 'ヘッダ古\n共通1\n共通2\n' },
    html: { 'p.html': 'ヘッダ新\n共通1\n共通2\n\n本文新' },
  });
  const sync = createEjsSync(io);
  await sync.scan(ROOTS);
  assert.equal((await sync.restoreBackup('p.ejs')).ok, false);
  const [page] = await sync.scan(ROOTS);
  const res = await sync.applyAllAuto(page.relPath);
  assert.equal(res.ok, true);
  const r = await sync.restoreBackup('p.ejs');
  assert.equal(r.ok, true);
  assert.ok(r.restoredFiles.length >= 1);
  assert.equal(io.ejsFiles.get('p.ejs'), '<%- include module/_h %>'+'\n'+'本文古');
  assert.equal(io.ejsFiles.get('module/_h.ejs'), 'ヘッダ古\n共通1\n共通2\n');
});

test('scanRemote: サーバーから取得して比べる。失敗・401・新規(sitemap)を、まとめて返す', async () => {
  const B = 'https://x.test/site';
  const io = fakeIo({
    ejs: { 'a.ejs': '<p>古い</p>', 'b.ejs': '<p>B</p>', 'c.ejs': '<p>C</p>' },
    remote: {
      [`${B}/a.html`]: '<p>新しい</p>',
      [`${B}/c.html`]: '<p>C</p>',
      'https://x.test/sitemap.xml': `<loc>${B}/new.html</loc>`,
      [`${B}/new.html`]: '<p>新規</p>',
    },
  });
  const sync = createEjsSync(io);
  const res = await sync.scanRemote({ ejsRoot: '/ejs', baseUrl: B, scope: '', crawl: false });
  assert.equal(res.ok, true);
  const by = Object.fromEntries(res.pages.map((p) => [p.relPath, p]));
  assert.equal(by['a.ejs'].status, 'diff');
  assert.equal(by['b.ejs'].status, 'missing-html');
  assert.equal(by['c.ejs'].status, 'identical');
  assert.equal(by['new.html'].status, 'html-only');
  assert.equal(res.fetchSummary.okCount, 2);
  assert.equal(res.fetchSummary.failCount, 1);
  assert.equal(res.fetchSummary.failures[0].status, 404);
  assert.equal(res.fetchSummary.newPageCount, 1);
  assert.match(res.fetchSummary.note, /sitemapから1件/);
  assert.deepEqual(io.calls.roots, [['/ejs', null]]);
  assert.equal(by['a.ejs'].htmlPath, `${B}/a.html`);
  // 公開サーバーから取った内容でも、EJS の書き換えと再検証が動く
  const applied = await sync.applyPatch(by['a.ejs'].patches[0].id);
  assert.equal(applied.ok, true);
  assert.equal(applied.updatedPage.status, 'identical');
});

test('scanRemote: 401 を検知。http + Basic 認証は拒否。http/https 以外は拒否', async () => {
  const B = 'https://x.test/site';
  const io = fakeIo({ ejs: { 'a.ejs': '1' } });
  io.fetchText = async () => { throw { message: 'HTTPステータス 401', status: 401 }; };
  const res = await createEjsSync(io).scanRemote({ ejsRoot: '/ejs', baseUrl: B, scope: '' });
  assert.equal(res.fetchSummary.authFailed, true);
  const bad1 = await createEjsSync(fakeIo({ ejs: { 'a.ejs': '1' } })).scanRemote({ ejsRoot: '/ejs', baseUrl: 'http://x.test/', basicUser: 'u', basicPass: 'p' });
  assert.equal(bad1.ok, false);
  assert.match(bad1.error, /HTTPS/);
  const bad2 = await createEjsSync(fakeIo({ ejs: { 'a.ejs': '1' } })).scanRemote({ ejsRoot: '/ejs', baseUrl: 'ftp://x.test/' });
  assert.equal(bad2.ok, false);
  assert.match(bad2.error, /http/);
});

test('knownEjsFile / knownPath: スキャン結果にあるものだけ。任意のパスは null', async () => {
  const io = fakeIo({
    ejs: { 'p.ejs': '<%- include module/_h %>本文', 'module/_h.ejs': '古' },
    html: { 'p.html': '新本文' },
  });
  const sync = createEjsSync(io);
  await sync.scan(ROOTS);
  assert.equal(sync.knownEjsFile('/ejs/p.ejs'), 'p.ejs');
  assert.equal(sync.knownEjsFile('/ejs/module/_h.ejs'), 'module/_h.ejs');
  assert.equal(sync.knownEjsFile('/etc/passwd'), null);
  assert.equal(sync.knownEjsFile('/ejs/../secret.ejs'), null);
  assert.deepEqual(sync.knownPath('/html/p.html'), { which: 'html', rel: 'p.html' });
  assert.equal(sync.knownPath('/windows/system32'), null);
});

test('scan: 動的な部分(<%= %>)にかかる差分は、要レビューとして返る(書き換え先のファイルは無い)', async () => {
  const io = fakeIo({ ejs: { 'dyn.ejs': 'A<%= 1 + 1 %>B' }, html: { 'dyn.html': 'A3B' } });
  const [page] = await createEjsSync(io).scan(ROOTS);
  assert.equal(page.status, 'diff');
  assert.equal(page.autoCount, 0);
  assert.equal(page.reviewCount, 1);
  assert.equal(page.patches[0].confidence, 'review');
  assert.equal(page.patches[0].file, undefined);
});

test('Rust のコマンドの失敗(文字列)でも、理由が失われない', async () => {
  const io = fakeIo({ ejs: { 'a.ejs': 'x' }, html: { 'a.html': 'x' } });
  io.readText = async () => { throw 'ファイルが読めません'; };
  const [page] = await createEjsSync(io).scan(ROOTS);
  assert.equal(page.status, 'error');
  assert.equal(page.error, 'ファイルが読めません');
});
