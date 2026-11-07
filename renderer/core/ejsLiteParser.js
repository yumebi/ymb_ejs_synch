import { dirname, extname, resolveFrom } from './relPath.js';

// EJS(レガシー include 構文込み)を 静的リテラル / 出力タグ / スクリプトレット に分割する。
// io.readEjs(相対パス)でファイルを読む(Tauri では Rust のコマンド、テストでは偽物)。
// file は、EJS ルートからの相対パス(`/` 区切り)。
// 各チャンクは file + srcStart + srcEnd (そのファイル内のバイト位置=文字位置) を持つ。
const TAG_RE = /<%([-=#_]?)([\s\S]*?)([-_]?)%>/g;

async function parseFileToChunks(io, absPath) {
  const text = await io.readEjs(absPath);
  const chunks = [];
  let cursor = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text))) {
    const [whole, prefix, inner, suffix] = m;
    const start = m.index;
    if (start > cursor) {
      chunks.push({
        type: 'literal',
        file: absPath,
        srcStart: cursor,
        srcEnd: start,
        text: text.slice(cursor, start),
      });
    }
    if (prefix === '#') {
      // コメント <%# ... %> は出力に影響しないので読み飛ばす
    } else {
      let tagType = 'scriptlet';
      if (prefix === '-') tagType = 'output-raw';
      else if (prefix === '=') tagType = 'output-escaped';
      chunks.push({
        type: 'tag',
        tagType,
        file: absPath,
        srcStart: start,
        srcEnd: start + whole.length,
        innerStart: m.index + 2 + prefix.length,
        innerEnd: m.index + whole.length - 2 - suffix.length,
        code: inner,
      });
    }
    cursor = start + whole.length;
  }
  if (cursor < text.length) {
    chunks.push({
      type: 'literal',
      file: absPath,
      srcStart: cursor,
      srcEnd: text.length,
      text: text.slice(cursor),
    });
  }
  return chunks;
}

// `<%- include ../module/_head %>` (レガシー, 括弧無し) と
// `<%- include('path') %>` / `<%- include("path") %>` (モダン) の両方を拾う
const INCLUDE_LEGACY_RE = /^\s*include\s+([^\s(]+)\s*$/;
const INCLUDE_MODERN_RE = /^\s*include\s*\(\s*['"]([^'"]+)['"]\s*(?:,[\s\S]*)?\)\s*$/;

function matchInclude(code) {
  const legacy = INCLUDE_LEGACY_RE.exec(code);
  if (legacy) return legacy[1];
  const modern = INCLUDE_MODERN_RE.exec(code);
  if (modern) return modern[1];
  return null;
}

// include の指す先を、EJS ルートからの相対パスで返す。ルートの外・絶対パスは、例外にする。
function resolveIncludePath(baseFile, rawTarget) {
  let p = rawTarget;
  if (!extname(p)) p += '.ejs';
  const resolved = resolveFrom(baseFile, p);
  if (resolved === null) {
    throw new Error(`include がEJSルートの外を指しているため読み込めません: ${rawTarget}(${baseFile})`);
  }
  return resolved;
}

// includeを再帰的に展開し、フラットなチャンク列を返す
async function parseAndExpand(io, absPath, seen = new Set()) {
  const real = absPath;
  if (seen.has(real)) {
    throw new Error(`include の循環参照を検出: ${real}`);
  }
  seen.add(real);

  const rawChunks = await parseFileToChunks(io, real);
  const expanded = [];
  for (const chunk of rawChunks) {
    if (chunk.type === 'tag' && chunk.tagType === 'output-raw') {
      const target = matchInclude(chunk.code);
      if (target) {
        const includedAbs = resolveIncludePath(real, target);
        const nested = await parseAndExpand(io, includedAbs, new Set(seen));
        expanded.push(...nested);
        continue;
      }
    }
    expanded.push(chunk);
  }
  return expanded;
}

export { parseFileToChunks, parseAndExpand, matchInclude, resolveIncludePath };
