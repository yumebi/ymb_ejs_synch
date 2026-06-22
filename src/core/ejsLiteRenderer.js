// 展開済みチャンク列(ejsLiteParser.parseAndExpand の出力)を実際にJSとして実行し、
// 1) 最終HTML文字列
// 2) 各リテラルチャンクの「出力文字列中の開始/終了位置」と「ソースファイル上の位置」の対応表
// を同時に得る。出力バッファへの push 呼び出しは1チャンク=1pushに対応させているので、
// 文字列検索のような曖昧さなしに正確な位置が分かる。

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildFunctionBody(chunks, segMeta) {
  const lines = [];
  lines.push('"use strict";');
  for (const chunk of chunks) {
    if (chunk.type === 'literal') {
      const idx = segMeta.length;
      segMeta.push({ file: chunk.file, srcStart: chunk.srcStart, srcEnd: chunk.srcEnd, text: chunk.text });
      lines.push(`__push(${JSON.stringify(chunk.text)}, ${idx});`);
    } else if (chunk.tagType === 'scriptlet') {
      lines.push(chunk.code);
    } else if (chunk.tagType === 'output-raw') {
      lines.push(`__push(String((${chunk.code})), -1);`);
    } else if (chunk.tagType === 'output-escaped') {
      lines.push(`__push(__esc((${chunk.code})), -1);`);
    }
  }
  return lines.join('\n');
}

function render(chunks, locals = {}) {
  const segMeta = [];
  const body = buildFunctionBody(chunks, segMeta);

  const buf = [];
  const __push = (s, idx) => buf.push({ s, idx });
  const __esc = escapeHtml;

  const argNames = Object.keys(locals);
  const argValues = argNames.map((k) => locals[k]);

  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function('__push', '__esc', ...argNames, body);
  } catch (e) {
    throw new Error(`EJSテンプレートのコンパイルに失敗: ${e.message}\n--- 生成コード ---\n${body}`);
  }

  try {
    fn(__push, __esc, ...argValues);
  } catch (e) {
    throw new Error(`EJSテンプレートの実行に失敗: ${e.message}`);
  }

  let pos = 0;
  let html = '';
  const segments = [];
  for (const item of buf) {
    const start = pos;
    html += item.s;
    pos += item.s.length;
    if (item.idx >= 0) {
      const meta = segMeta[item.idx];
      segments.push({
        outputStart: start,
        outputEnd: pos,
        file: meta.file,
        srcStart: meta.srcStart,
        srcEnd: meta.srcEnd,
        text: meta.text,
      });
    }
  }

  return { html, segments };
}

module.exports = { render, escapeHtml };
