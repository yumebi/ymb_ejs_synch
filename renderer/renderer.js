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

el('pickEjsRoot').addEventListener('click', async () => {
  const p = await window.api.selectFolder(el('ejsRoot').value);
  if (p) el('ejsRoot').value = p;
});
el('pickHtmlRoot').addEventListener('click', async () => {
  const p = await window.api.selectFolder(el('htmlRoot').value);
  if (p) el('htmlRoot').value = p;
});

el('runScan').addEventListener('click', async () => {
  const ejsRoot = el('ejsRoot').value.trim();
  const htmlRoot = el('htmlRoot').value.trim();
  const scope = el('scope').value.trim();
  if (!ejsRoot || !htmlRoot) {
    el('scanStatus').textContent = 'EJSルートと公開HTMLルートを指定してください';
    return;
  }
  el('scanStatus').textContent = 'スキャン中…';
  try {
    const pages = await window.api.scan({ ejsRoot, htmlRoot, scope });
    state.pages = pages;
    state.selected = null;
    renderPageList();
    renderDetail(null);
    el('scanStatus').textContent = `完了: ${pages.length}ページ`;
  } catch (e) {
    el('scanStatus').textContent = `エラー: ${e.message}`;
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
    detail.innerHTML = `<h2>${escapeForDisplay(page.relPath)}</h2><p>EJSと公開HTMLに差分はありません。</p>`;
    return;
  }

  const autoPatches = page.patches.filter((p) => p.confidence === 'auto');
  const reviewPatches = page.patches.filter((p) => p.confidence === 'review');

  detail.innerHTML = `
    <h2>${escapeForDisplay(page.relPath)}</h2>
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
  });

  const list = el('patchList');
  for (const patch of [...autoPatches, ...reviewPatches]) {
    list.appendChild(renderPatchCard(patch));
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

function renderPatchCard(patch) {
  const card = document.createElement('div');
  card.className = `patch-card ${patch.confidence}`;
  card.dataset.patchId = patch.id || '';

  const tagLabel = patch.confidence === 'auto' ? '自動反映可能' : '要レビュー';
  const fileLine = patch.file ? `<div class="reason">${escapeForDisplay(patch.file)}${patch.srcStart != null ? ` (位置 ${patch.srcStart}-${patch.srcEnd})` : ''}</div>` : '';
  const reasonLine = patch.reason ? `<div class="reason">${escapeForDisplay(patch.reason)}</div>` : '';

  card.innerHTML = `
    <div class="tag">${tagLabel}</div>
    ${fileLine}
    ${reasonLine}
    <div class="diff-cols">
      <div class="diff-col">
        <div class="diff-col-label">公開HTML(編集後)</div>
        <pre class="new">${escapeForDisplay(patch.newHtml || '')}</pre>
      </div>
      <div class="diff-arrow" title="左の内容をEJSへ書き込みます">EJSへ →</div>
      <div class="diff-col">
        <div class="diff-col-label">EJS(現状/反映前)</div>
        <pre class="old">${escapeForDisplay(patch.oldHtml || '')}</pre>
      </div>
    </div>
    ${patch.confidence === 'review' && patch.file ? `<textarea class="editBox">${escapeForDisplay(patch.newText || patch.newHtml || '')}</textarea>` : ''}
    <div class="row-actions">
      ${patch.file ? '<button class="applyBtn">適用</button>' : ''}
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
    });
  }
  card.querySelector('.skipBtn').addEventListener('click', () => {
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    card.querySelector('.result').textContent = 'スキップしました';
  });

  return card;
}
