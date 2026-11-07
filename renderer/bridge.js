// Tauri の画面側の橋渡し。Electron 版の preload.js(window.api / window.appInfo)と、同じ形で提供する。
// 画面(renderer.js)は、Electron 版のまま(確認ダイアログの呼び方だけ変えて)動く。
// 重い処理(解析・差分・パッチの手順)は、必要になったときに、ES モジュールを読み込む。
(function () {
  const { invoke } = window.__TAURI__.core;
  const UPDATE_REPO = 'yumebi/ymb_ejs_synch';
  const RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases`;

  // Rust のコマンドを、コア処理の `io` の形にする。
  const io = {
    setRoots: (ejsRoot, htmlRoot) => invoke('set_roots', { ejs: ejsRoot, html: htmlRoot || null }),
    dirExists: (which, rel) => invoke('dir_exists', { which, rel }),
    listEjs: (scope) => invoke('list_ejs', { scope }),
    listHtml: (scope) => invoke('list_html', { scope }),
    absPath: (which, rel) => invoke('abs_path', { which, rel }),
    pathExists: (which, rel) => invoke('path_exists', { which, rel }),
    readText: (which, rel) => invoke('read_text', { which, rel }),
    readEjs: (rel) => invoke('read_text', { which: 'ejs', rel }),
    writeEjs: (rel, text, backup) => invoke('write_ejs', { rel, text, backup }),
    restoreEjs: (rel) => invoke('restore_ejs', { rel }),
    fetchText: (url, auth, timeoutMs, maxBytes) =>
      invoke('fetch_text', { url, auth: auth || null, timeoutMs, maxBytes }),
    openInEditor: (rel, srcStart) => invoke('open_in_editor', { rel, srcStart: srcStart == null ? null : srcStart }),
    reveal: (which, rel) => invoke('reveal', { which, rel }),
  };

  // EJS テンプレートの JavaScript は、隔離した枠(専用スキーム ymbsandbox の枠: 別の出所・通信なし・Tauri に触れない)の中で実行する。
  let sandboxReady = null;
  let sandboxFrame = null;
  let runSeq = 0;
  const runWaiters = new Map();
  window.addEventListener('message', (e) => {
    if (!sandboxFrame || e.source !== sandboxFrame.contentWindow) return;
    const msg = e.data;
    if (msg && typeof msg.id === 'number' && runWaiters.has(msg.id)) {
      const w = runWaiters.get(msg.id);
      runWaiters.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error));
      else w.resolve(msg.buf);
    }
  });
  function ensureSandbox() {
    if (!sandboxReady) {
      sandboxReady = new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.style.display = 'none';
        const onReady = (e) => {
          if (e.source === frame.contentWindow && e.data && e.data.ready) {
            window.removeEventListener('message', onReady);
            resolve();
          }
        };
        window.addEventListener('message', onReady);
        frame.addEventListener('error', () => reject(new Error('テンプレート実行用の枠を開けませんでした')));
        sandboxFrame = frame;
        // 専用のスキーム。Windows の WebView2 では、http://<スキーム>.localhost/ の形になる。
        frame.src = /windows/i.test(navigator.userAgent) ? 'http://ymbsandbox.localhost/' : 'ymbsandbox://localhost/';
        document.body.appendChild(frame);
      });
    }
    return sandboxReady;
  }
  io.runTemplate = async (body, argNames, argValues) => {
    await ensureSandbox();
    const id = ++runSeq;
    return new Promise((resolve, reject) => {
      runWaiters.set(id, { resolve, reject });
      sandboxFrame.contentWindow.postMessage({ id, body, argNames, argValues }, '*');
    });
  };

  let syncPromise = null;
  function getSync() {
    if (!syncPromise) {
      syncPromise = import('./core/ejsSync.js').then((m) => m.createEjsSync(io));
    }
    return syncPromise;
  }

  window.api = {
    selectFolder: async (defaultPath) => {
      const picked = await window.__TAURI__.dialog.open({
        directory: true,
        multiple: false,
        defaultPath: defaultPath || undefined,
      });
      return typeof picked === 'string' ? picked : null;
    },
    scan: async (args) => (await getSync()).scan(args),
    scanRemote: async (args) => (await getSync()).scanRemote(args),
    applyPatch: async (patchId, editedNewText) => (await getSync()).applyPatch(patchId, editedNewText),
    applyAllAuto: async (relPath) => (await getSync()).applyAllAuto(relPath),
    applyAllPages: async () => (await getSync()).applyAllPages(),
    restoreBackup: async (relPath) => (await getSync()).restoreBackup(relPath),
    // 引数は、スキャン結果の絶対パス。直近のスキャン結果にあるものだけを、ルートの中の相対パスに直して、Rust に渡す。
    openPath: async (absPath) => {
      const target = (await getSync()).knownPath(absPath);
      if (target) await invoke('reveal', { which: target.which, rel: target.rel });
    },
    openInEditor: async (file, srcStart) => {
      const rel = (await getSync()).knownEjsFile(file);
      if (!rel) return { ok: false, error: '許可されていないファイルです' };
      try {
        const message = await invoke('open_in_editor', { rel, srcStart: srcStart == null ? null : srcStart });
        return message ? { ok: false, error: message } : { ok: true };
      } catch (e) {
        return { ok: false, error: typeof e === 'string' ? e : (e && e.message) || String(e) };
      }
    },
  };

  // 確認・警告のダイアログ。ブラウザ標準の confirm / alert は、macOS の WKWebView では動かないことがあるため、
  // OS 標準のダイアログ(Tauri の dialog プラグイン)を使う。どの OS でも、同じように動く。
  window.ymbDialog = {
    confirm: (message) =>
      window.__TAURI__.dialog.ask(message, {
        title: 'YMB EJS差分同期ツール',
        kind: 'warning',
        okLabel: 'はい',
        cancelLabel: 'いいえ',
      }),
    alert: (message) =>
      window.__TAURI__.dialog.message(message, { title: 'YMB EJS差分同期ツール', kind: 'error' }),
  };

  window.appInfo = {
    getVersion: () => invoke('app_version'),
    updateRepo: UPDATE_REPO,
  };

  // 起動時の更新確認。ネットワーク不通などでは、黙って何もしない。
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
      const current = await invoke('app_version');
      if (!isNewer(parseVersion(data.tag_name || '0.0.0'), parseVersion(current))) return;
      const open = await window.__TAURI__.dialog.ask(
        `新しいバージョン ${data.tag_name} が公開されています(現在: v${current})\nリポジトリのReleasesページからダウンロードできます。`,
        { title: '新しいバージョンがあります', kind: 'info', okLabel: 'リポジトリを開く', cancelLabel: '閉じる' },
      );
      if (open) await window.__TAURI__.opener.openUrl(RELEASES_URL);
    } catch (e) {
      // 起動時チェックは、失敗しても黙って無視する
    }
  }
  window.addEventListener('load', () => {
    checkForUpdateOnStartup();
  });
})();
