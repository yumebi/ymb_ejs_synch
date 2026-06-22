const fs = require('fs');

function ensureBackup(file) {
  const bak = `${file}.bak`;
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(file, bak);
  }
}

// 単一パッチを実ファイルに適用する。安全のため適用直前に oldText が
// まだそこにある事を確認してから書き込む(ズレていたら例外を投げて中断)。
function applyOne(patch, overrideNewText) {
  const newText = overrideNewText !== undefined ? overrideNewText : patch.newText;
  ensureBackup(patch.file);
  const content = fs.readFileSync(patch.file, 'utf8');
  const current = content.slice(patch.srcStart, patch.srcEnd);
  if (current !== patch.oldText) {
    throw new Error(
      `${patch.file} の該当箇所が想定と異なるため適用を中止しました(他のパッチで位置がズレた可能性)。`
    );
  }
  const next = content.slice(0, patch.srcStart) + newText + content.slice(patch.srcEnd);
  fs.writeFileSync(patch.file, next, 'utf8');
}

// 同一ファイルへの複数パッチは srcStart の降順で適用する。
// 末尾側から書き換えれば、まだ書き換えていない手前側のオフセットは崩れない。
function applyBatch(patches) {
  const byFile = new Map();
  for (const p of patches) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
  }
  const results = [];
  for (const [file, list] of byFile) {
    list.sort((a, b) => b.srcStart - a.srcStart);
    for (const p of list) {
      try {
        applyOne(p);
        results.push({ patch: p, ok: true });
      } catch (e) {
        results.push({ patch: p, ok: false, error: e.message });
      }
    }
  }
  return results;
}

module.exports = { applyOne, applyBatch, ensureBackup };
