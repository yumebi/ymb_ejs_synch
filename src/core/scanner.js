const fs = require('fs');
const path = require('path');

const parser = require('./ejsLiteParser');
const renderer = require('./ejsLiteRenderer');
const diffMapper = require('./diffMapper');

function walkEjsFiles(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name === 'module') continue; // 共通パーツ置き場はページ単体としては対象外
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walkEjsFiles(full));
    } else if (ent.isFile() && ent.name.endsWith('.ejs') && !ent.name.startsWith('_')) {
      out.push(full);
    }
  }
  return out;
}

function toHtmlPath(ejsPath, ejsRoot, htmlRoot) {
  const rel = path.relative(ejsRoot, ejsPath);
  const relHtml = rel.replace(/\.ejs$/, '.html');
  return path.join(htmlRoot, relHtml);
}

// EJS1ファイル分のスキャンを行う。scanAllからも、パッチ適用後の再検証(main.js)からも使う。
function scanPage(ejsPath, htmlPath, relPath) {
  if (!fs.existsSync(htmlPath)) {
    return { relPath, ejsPath, htmlPath, status: 'missing-html' };
  }

  try {
    const chunks = parser.parseAndExpand(ejsPath);
    const { html, segments } = renderer.render(chunks, {});
    const deployedHtml = fs.readFileSync(htmlPath, 'utf8');

    if (html === deployedHtml) {
      return { relPath, ejsPath, htmlPath, status: 'identical' };
    }

    const rawPatches = diffMapper.computePatches(html, segments, deployedHtml);
    const patches = rawPatches.map((p, i) => ({ ...p, id: `${relPath}::${i}` }));

    return {
      relPath,
      ejsPath,
      htmlPath,
      status: 'diff',
      autoCount: patches.filter((p) => p.confidence === 'auto').length,
      reviewCount: patches.filter((p) => p.confidence === 'review').length,
      patches,
    };
  } catch (e) {
    return { relPath, ejsPath, htmlPath, status: 'error', error: e.message };
  }
}

function scanAll({ ejsRoot, htmlRoot, scope }) {
  const startDir = scope ? path.join(ejsRoot, scope) : ejsRoot;
  if (!fs.existsSync(startDir)) {
    throw new Error(`指定ディレクトリが存在しません: ${startDir}`);
  }
  const ejsFiles = walkEjsFiles(startDir);
  const pages = [];

  for (const ejsPath of ejsFiles) {
    const htmlPath = toHtmlPath(ejsPath, ejsRoot, htmlRoot);
    const relPath = path.relative(ejsRoot, ejsPath);
    pages.push(scanPage(ejsPath, htmlPath, relPath));
  }

  return pages;
}

module.exports = { scanAll, scanPage, walkEjsFiles, toHtmlPath };
