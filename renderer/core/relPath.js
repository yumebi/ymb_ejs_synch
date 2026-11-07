// ルートからの相対パス(`/` 区切り)を扱う小さな道具。Electron 版の Node の `path` の代わり。
// ルートの外に出るパスは、null(または例外)にする。

// 'a/b/c.ejs' -> 'a/b'、'c.ejs' -> ''
// 失敗の理由を文字にする。Rust のコマンドの失敗は、Error ではなく文字列で届く。
export function errorMessage(e) {
  if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;
  return String(e);
}

export function dirname(rel) {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

// 拡張子(ドット込み)。無ければ ''。'a/b.d/c' のようにディレクトリ名のドットは、見ない。
export function extname(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}

// base(ルートからの相対パス)のあるフォルダを起点に、target を解決する。
// 絶対パス・ドライブ指定・`\` を含むもの・ルートの外に出るものは、null。
export function resolveFrom(baseRel, target) {
  if (typeof target !== 'string' || target === '') return null;
  if (target.startsWith('/') || /^[a-zA-Z]:/.test(target) || target.includes('\\')) return null;
  const parts = baseRel === '' ? [] : dirname(baseRel).split('/').filter((s) => s !== '');
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null; // ルートの外
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.length === 0 ? null : parts.join('/');
}

// 'a/b/c.ejs' -> 'a/b/c.html'
export function toHtmlRel(ejsRel) {
  return ejsRel.replace(/\.ejs$/, '.html');
}

// scope を安全な相対パスにする。`..` を含むものは例外。
export function sanitizeScope(scope) {
  if (!scope) return '';
  const cleaned = String(scope).replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
  if (!cleaned) return '';
  const raw = cleaned.split(/[\\/]+/).filter((s) => s);
  if (raw.some((s) => s === '..')) {
    throw new Error('対象サブディレクトリに親ディレクトリ参照(..)は指定できません');
  }
  return raw.filter((s) => s !== '.').join('/');
}
