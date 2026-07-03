const state = { pages: [], selected: null };

const el = (id) => document.getElementById(id);

// --- バージョン表示 / テーマ / 更新確認 ---
let currentVersion = '0.0.0';
window.appInfo.getVersion().then((v) => {
  currentVersion = v;
  el('versionInfo').textContent = `v${v}`;
});

const THEME_KEY = 'ejs-html-sync-theme';
function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  el('themeToggle').checked = dark;
}
applyTheme(localStorage.getItem(THEME_KEY) === 'dark');
el('themeToggle').addEventListener('change', (e) => {
  applyTheme(e.target.checked);
  localStorage.setItem(THEME_KEY, e.target.checked ? 'dark' : 'light');
});

function parseVersion(v) {
  return v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}
function isNewer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

el('checkUpdateBtn').addEventListener('click', async () => {
  const result = el('updateResult');
  if (!window.appInfo.updateRepo) {
    result.textContent = 'リポジトリ未設定(GitHub公開後に設定します)';
    return;
  }
  result.textContent = '確認中…';
  try {
    const res = await fetch(`https://api.github.com/repos/${window.appInfo.updateRepo}/releases/latest`);
    if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
    const data = await res.json();
    const latest = parseVersion(data.tag_name || '0.0.0');
    const current = parseVersion(currentVersion);
    if (isNewer(latest, current)) {
      result.textContent = `新しいバージョンあります: ${data.tag_name}(現在: v${currentVersion})`;
    } else {
      result.textContent = '最新版です';
    }
  } catch (e) {
    result.textContent = `確認失敗: ${e.message}`;
  }
});

// --- 左一覧の幅をドラッグで可変に ---
const LIST_WIDTH_KEY = 'ejs-html-sync-list-width';
const LIST_WIDTH_DEFAULT = 420;
const LIST_WIDTH_MIN = 240;
function clampListWidth(width) {
  const max = Math.max(LIST_WIDTH_MIN, window.innerWidth - 400);
  return Math.min(Math.max(width, LIST_WIDTH_MIN), max);
}
function setListWidth(width) {
  el('pageList').style.width = `${clampListWidth(width)}px`;
}
function restoreListWidth() {
  const saved = parseInt(localStorage.getItem(LIST_WIDTH_KEY), 10);
  setListWidth(Number.isFinite(saved) && saved > 0 ? saved : LIST_WIDTH_DEFAULT);
}
restoreListWidth();

(() => {
  const splitter = el('splitter');
  let dragging = false;

  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    splitter.classList.add('dragging');
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const listRect = el('pageList').getBoundingClientRect();
    setListWidth(e.clientX - listRect.left);
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.userSelect = '';
    const width = parseInt(el('pageList').style.width, 10);
    if (Number.isFinite(width)) localStorage.setItem(LIST_WIDTH_KEY, String(width));
  });

  splitter.addEventListener('dblclick', () => {
    setListWidth(LIST_WIDTH_DEFAULT);
    localStorage.setItem(LIST_WIDTH_KEY, String(LIST_WIDTH_DEFAULT));
  });
})();

// --- 入力パスの記憶(EJSルート/公開HTMLルート/対象サブディレクトリ/取得元切替/URL) ---
const PATHS_KEY = 'ejs-html-sync-paths';
function restorePaths() {
  try {
    const saved = JSON.parse(localStorage.getItem(PATHS_KEY) || '{}');
    if (saved.ejsRoot) el('ejsRoot').value = saved.ejsRoot;
    if (saved.htmlRoot) el('htmlRoot').value = saved.htmlRoot;
    if (saved.scope) el('scope').value = saved.scope;
    if (saved.htmlSource) el('htmlSource').value = saved.htmlSource;
    if (saved.baseUrl) el('baseUrl').value = saved.baseUrl;
    if (saved.basicUser) el('basicUser').value = saved.basicUser;
    // basicPassは平文保存を避けるため復元しない(セッション中の入力のみ有効)
  } catch {
    // 保存値が壊れている場合は無視して初期状態のまま
  }
}
function savePaths(ejsRoot, htmlRoot, scope) {
  localStorage.setItem(PATHS_KEY, JSON.stringify({
    ejsRoot,
    htmlRoot,
    scope,
    htmlSource: el('htmlSource').value,
    baseUrl: el('baseUrl').value.trim(),
    basicUser: el('basicUser').value.trim(),
    // basicPassは絶対に保存しない(平文保存を避ける)
  }));
}
restorePaths();

el('pickEjsRoot').addEventListener('click', async () => {
  const p = await window.api.selectFolder(el('ejsRoot').value);
  if (p) el('ejsRoot').value = p;
});
el('pickHtmlRoot').addEventListener('click', async () => {
  const p = await window.api.selectFolder(el('htmlRoot').value);
  if (p) el('htmlRoot').value = p;
});

// --- 公開HTML取得元切替(ローカルフォルダ / URLから取得) ---
function updateHtmlSourceUI() {
  const isUrl = el('htmlSource').value === 'url';
  el('htmlRootField').hidden = isUrl;
  el('baseUrlField').hidden = !isUrl;
  el('basicAuthField').hidden = !isUrl;
}
el('htmlSource').addEventListener('change', updateHtmlSourceUI);
updateHtmlSourceUI();

function updateApplyAllPagesBtn() {
  const btn = el('applyAllPagesBtn');
  const diffCount = state.pages.filter((p) => p.status === 'diff').length;
  btn.disabled = diffCount === 0;
}

el('runScan').addEventListener('click', async () => {
  const ejsRoot = el('ejsRoot').value.trim();
  const htmlRoot = el('htmlRoot').value.trim();
  const baseUrl = el('baseUrl').value.trim();
  const scope = el('scope').value.trim();
  const basicUser = el('basicUser').value.trim();
  const basicPass = el('basicPass').value;
  const isUrlMode = el('htmlSource').value === 'url';

  if (!ejsRoot || (isUrlMode ? !baseUrl : !htmlRoot)) {
    el('scanStatus').textContent = isUrlMode
      ? 'EJSルートと公開サーバーURLを指定してください'
      : 'EJSルートと公開HTMLルートを指定してください';
    return;
  }

  el('scanStatus').textContent = isUrlMode ? '公開HTMLを取得中…' : 'スキャン中…';
  try {
    if (isUrlMode) {
      const res = await window.api.scanRemote({ ejsRoot, baseUrl, scope, basicUser, basicPass });
      savePaths(ejsRoot, htmlRoot, scope);
      if (!res.ok) {
        el('scanStatus').textContent = `エラー: ${res.error}`;
        return;
      }
      state.pages = res.pages;
      state.selected = null;
      renderPageList();
      renderDetail(null);
      updateApplyAllPagesBtn();

      const { fetchSummary } = res;
      if (fetchSummary.failCount > 0) {
        const authNote = fetchSummary.authFailed
          ? ' / 取得失敗: Basic認証エラーの可能性(ID/パスワードを確認)'
          : '';
        el('scanStatus').textContent = `完了: ${res.pages.length}ページ(取得失敗${fetchSummary.failCount}件)${authNote}`;
        console.warn('公開HTML取得に失敗したページ:', fetchSummary.failures);
      } else {
        el('scanStatus').textContent = `完了: ${res.pages.length}ページ`;
      }
    } else {
      const pages = await window.api.scan({ ejsRoot, htmlRoot, scope });
      savePaths(ejsRoot, htmlRoot, scope);
      state.pages = pages;
      state.selected = null;
      renderPageList();
      renderDetail(null);
      updateApplyAllPagesBtn();
      el('scanStatus').textContent = `完了: ${pages.length}ページ`;
    }
  } catch (e) {
    el('scanStatus').textContent = `エラー: ${e.message}`;
  }
});

el('applyAllPagesBtn').addEventListener('click', async () => {
  const diffCount = state.pages.filter((p) => p.status === 'diff').length;
  if (diffCount === 0) return;
  if (!window.confirm(`差分のある${diffCount}ページに自動反映可能なパッチを一括適用します。よろしいですか?`)) {
    return;
  }
  el('scanStatus').textContent = '一括適用中…';
  try {
    const res = await window.api.applyAllPages();
    if (!res.ok) {
      el('scanStatus').textContent = `一括適用エラー: ${res.error || ''}`;
      return;
    }
    state.pages = res.pages;
    renderPageList();
    updateApplyAllPagesBtn();

    const appliedTotal = res.summary.reduce((sum, s) => sum + s.appliedCount, 0);
    const failedTotal = res.summary.reduce((sum, s) => sum + s.failedCount, 0);
    el('scanStatus').textContent = `一括適用完了: ${res.summary.length}ページ / 適用${appliedTotal}件 / 失敗${failedTotal}件`;

    if (state.selected) {
      const selectedPage = state.pages.find((p) => p.relPath === state.selected);
      if (selectedPage) renderDetail(selectedPage);
    }
  } catch (e) {
    el('scanStatus').textContent = `一括適用エラー: ${e.message}`;
  }
});

function statusBadge(page) {
  if (page.status === 'identical') return '<span class="badge identical">差分なし</span>';
  if (page.status === 'missing-html') return '<span class="badge missing">公開HTML無し</span>';
  if (page.status === 'error') return '<span class="badge error">解析失敗</span>';
  return '<span class="badge diff">差分あり</span>';
}

function renderPageList() {
  const body = el('pageListBody');
  body.innerHTML = '';
  for (const page of state.pages) {
    const tr = document.createElement('tr');
    tr.className = 'row' + (state.selected === page.relPath ? ' selected' : '');
    tr.innerHTML = `
      <td>${escapeForDisplay(page.relPath)}</td>
      <td>${statusBadge(page)}</td>
      <td class="count auto">${page.autoCount ?? ''}</td>
      <td class="count review">${page.reviewCount ?? ''}</td>
    `;
    tr.addEventListener('click', () => {
      state.selected = page.relPath;
      renderPageList();
      renderDetail(page);
    });
    body.appendChild(tr);
  }
}

// innerHTML / 属性へ差し込む文字列は全部これを通す。
// ファイル名やパスはユーザーが選んだディレクトリ配下の値なので通常は安全だが、
// 万一クォートやタグを含む名前があってもDOM注入(→window.api経由の任意ファイル操作)に
// つながらないよう常にエスケープする。
function escapeForDisplay(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderDetail(page) {
  const detail = el('detail');
  if (!page) {
    detail.innerHTML = '<p class="placeholder">左の一覧からページを選択してください。</p>';
    return;
  }
  if (page.status === 'missing-html') {
    detail.innerHTML = `<h2>${escapeForDisplay(page.relPath)}</h2><p>対応する公開HTMLが見つかりません: ${escapeForDisplay(page.htmlPath)}</p>`;
    return;
  }
  if (page.status === 'error') {
    detail.innerHTML = `<h2>${escapeForDisplay(page.relPath)}</h2><p class="failed">解析エラー: ${escapeForDisplay(page.error)}</p>`;
    return;
  }
  if (page.status === 'identical') {
    detail.innerHTML = `<h2>${escapeForDisplay(page.relPath)}</h2><div id="verifyResult"></div><p>EJSと公開HTMLに差分はありません。</p>`;
    return;
  }

  const autoPatches = page.patches.filter((p) => p.confidence === 'auto');
  const reviewPatches = page.patches.filter((p) => p.confidence === 'review');

  detail.innerHTML = `
    <h2>${escapeForDisplay(page.relPath)}</h2>
    <div id="verifyResult"></div>
    <div class="path-pair">
      <div class="path-box html">
        <div class="path-label">公開HTML(クライアント編集後)</div>
        <div class="path-value">${escapeForDisplay(page.htmlPath)}</div>
        <button class="openBtn" data-path="${escapeForDisplay(page.htmlPath)}">フォルダを開く</button>
      </div>
      <div class="path-arrow" title="この内容をEJSソースへ反映します">反映 →</div>
      <div class="path-box ejs">
        <div class="path-label">EJSソース(反映先)</div>
        <div class="path-value">${escapeForDisplay(page.ejsPath)}</div>
        <button class="openBtn" data-path="${escapeForDisplay(page.ejsPath)}">フォルダを開く</button>
        <button id="restoreBackupBtn">バックアップから復元</button>
      </div>
    </div>
    <div class="actions">
      <button id="applyAllAutoBtn">自動反映可能(${autoPatches.length}件)を一括適用</button>
    </div>
    <div id="patchList"></div>
  `;

  detail.querySelectorAll('.openBtn').forEach((btn) => {
    btn.addEventListener('click', () => window.api.openPath(btn.dataset.path));
  });

  el('applyAllAutoBtn').addEventListener('click', async () => {
    const res = await window.api.applyAllAuto(page.relPath);
    if (!res.ok) {
      alert(`適用失敗: ${res.error}`);
      return;
    }
    for (const r of res.results) {
      const card = document.querySelector(`[data-patch-id="${r.id}"]`);
      if (!card) continue;
      markCardResult(card, r);
    }
    applyUpdatedPage(res.updatedPage);
  });

  el('restoreBackupBtn').addEventListener('click', async () => {
    if (!window.confirm(`${page.relPath} をバックアップ(.bak)から復元します。適用済みのパッチは取り消されます。よろしいですか?`)) {
      return;
    }
    const res = await window.api.restoreBackup(page.relPath);
    if (!res.ok) {
      alert(`復元失敗: ${res.error}`);
      return;
    }
    applyUpdatedPage(res.updatedPage);
    renderDetail(res.updatedPage);
    const verifyEl = el('verifyResult');
    if (verifyEl) {
      verifyEl.innerHTML = `<p class="verify-ok">復元完了: ${res.restoredFiles.length} ファイル</p>`;
    }
  });

  const list = el('patchList');
  for (const patch of [...autoPatches, ...reviewPatches]) {
    list.appendChild(renderPatchCard(patch));
  }
}

// パッチ適用後の再検証結果(updatedPage)をページ一覧・詳細パネル上部へ反映する。
// 詳細パネル全体は再描画しない(レビュー中の他カードが消えてしまうため)。
function applyUpdatedPage(updatedPage) {
  if (!updatedPage) return;

  const idx = state.pages.findIndex((p) => p.relPath === updatedPage.relPath);
  if (idx !== -1) {
    state.pages[idx] = updatedPage;
  } else {
    state.pages.push(updatedPage);
  }
  renderPageList();
  updateApplyAllPagesBtn();

  if (state.selected !== updatedPage.relPath) return;
  const verifyEl = el('verifyResult');
  if (!verifyEl) return;
  if (updatedPage.status === 'identical') {
    verifyEl.innerHTML = '<p class="verify-ok">適用済み・再ビルド結果は公開HTMLと完全一致</p>';
  } else if (updatedPage.status === 'diff') {
    verifyEl.innerHTML = `<p class="verify-remain">適用済み・残り差分 auto=${updatedPage.autoCount} / review=${updatedPage.reviewCount} 件</p>`;
  } else {
    verifyEl.innerHTML = '';
  }
}

function markCardResult(card, result) {
  const statusEl = card.querySelector('.result');
  if (result.ok) {
    statusEl.innerHTML = '<span class="applied">適用済み</span>';
  } else {
    statusEl.innerHTML = `<span class="failed">適用失敗: ${escapeForDisplay(result.error || '')}</span>`;
  }
  card.querySelectorAll('button').forEach((b) => (b.disabled = true));
}

// charDiff([{value, added, removed}, ...])から、公開HTML側(removedを保持しaddedを強調)
// またはEJS側(addedを保持しremovedを強調)いずれかの表示用HTML文字列を組み立てる。
// escapeForDisplayでエスケープした後の文字列だけを連結するため、値そのものにHTMLタグは混入しない。
function buildCharDiffHtml(charDiff, side) {
  let out = '';
  for (const part of charDiff) {
    if (side === 'deployed') {
      // 公開HTML側: EJSへの反映で消える(removed)分は表示せず、追加分(added)を強調
      if (part.removed) continue;
      out += part.added ? `<span class="diff-add">${escapeForDisplay(part.value)}</span>` : escapeForDisplay(part.value);
    } else {
      // EJS側: 公開HTML側にしかない(added)分は表示せず、削除される分(removed)を強調
      if (part.added) continue;
      out += part.removed ? `<span class="diff-del">${escapeForDisplay(part.value)}</span>` : escapeForDisplay(part.value);
    }
  }
  return out;
}

function renderPatchCard(patch) {
  const card = document.createElement('div');
  card.className = `patch-card ${patch.confidence}`;
  card.dataset.patchId = patch.id || '';

  const tagLabel = patch.confidence === 'auto' ? '自動反映可能' : '要レビュー';
  const fileLine = patch.file ? `<div class="reason">${escapeForDisplay(patch.file)}${patch.srcStart != null ? ` (位置 ${patch.srcStart}-${patch.srcEnd})` : ''}</div>` : '';
  const reasonLine = patch.reason ? `<div class="reason">${escapeForDisplay(patch.reason)}</div>` : '';

  const newHtmlDisplay = patch.charDiff ? buildCharDiffHtml(patch.charDiff, 'deployed') : escapeForDisplay(patch.newHtml || '');
  const oldHtmlDisplay = patch.charDiff ? buildCharDiffHtml(patch.charDiff, 'ejs') : escapeForDisplay(patch.oldHtml || '');

  card.innerHTML = `
    <div class="tag">${tagLabel}</div>
    ${fileLine}
    ${reasonLine}
    <div class="diff-cols">
      <div class="diff-col">
        <div class="diff-col-label">公開HTML(編集後)</div>
        <pre class="new">${newHtmlDisplay}</pre>
      </div>
      <div class="diff-arrow" title="左の内容をEJSへ書き込みます">EJSへ →</div>
      <div class="diff-col">
        <div class="diff-col-label">EJS(現状/反映前)</div>
        <pre class="old">${oldHtmlDisplay}</pre>
      </div>
    </div>
    ${patch.confidence === 'review' && patch.file ? `<textarea class="editBox">${escapeForDisplay(patch.newText || patch.newHtml || '')}</textarea>` : ''}
    <div class="row-actions">
      ${patch.file ? '<button class="applyBtn">適用</button>' : ''}
      ${patch.file ? '<button class="editorBtn">エディタで開く</button>' : ''}
      <button class="skipBtn">スキップ</button>
      <span class="result"></span>
    </div>
  `;

  const applyBtn = card.querySelector('.applyBtn');
  if (applyBtn) {
    applyBtn.addEventListener('click', async () => {
      const editBox = card.querySelector('.editBox');
      const editedNewText = editBox ? editBox.value : undefined;
      const res = await window.api.applyPatch(patch.id, patch.confidence === 'review' ? editedNewText : undefined);
      markCardResult(card, res.ok ? { ok: true } : { ok: false, error: res.error });
      if (res.ok) applyUpdatedPage(res.updatedPage);
    });
  }
  const editorBtn = card.querySelector('.editorBtn');
  if (editorBtn) {
    editorBtn.addEventListener('click', async () => {
      const res = await window.api.openInEditor(patch.file, patch.srcStart);
      if (!res.ok) alert(`エディタで開けませんでした: ${res.error || ''}`);
    });
  }
  card.querySelector('.skipBtn').addEventListener('click', () => {
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    card.querySelector('.result').textContent = 'スキップしました';
  });

  return card;
}
