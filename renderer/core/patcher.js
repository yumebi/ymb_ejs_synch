import { errorMessage } from './relPath.js';

// 単一パッチを実ファイルに適用する。安全のため適用直前に oldText が
// まだそこにある事を確認してから書き込む(ズレていたら例外を投げて中断)。
async function applyOne(io, patch, overrideNewText) {
  const newText = overrideNewText !== undefined ? overrideNewText : patch.newText;
  const content = await io.readEjs(patch.fileRel);
  const current = content.slice(patch.srcStart, patch.srcEnd);
  if (current !== patch.oldText) {
    throw new Error(
      `${patch.file} の該当箇所が想定と異なるため適用を中止しました(他のパッチで位置がズレた可能性)。`
    );
  }
  const next = content.slice(0, patch.srcStart) + newText + content.slice(patch.srcEnd);
  // 初回だけ .bak を残して、原子的に書き換える(途中で落ちても、元のファイルは壊れない)
  await io.writeEjs(patch.fileRel, next, true);
}

// 同一ファイルへの複数パッチは srcStart の降順で適用する。
// 末尾側から書き換えれば、まだ書き換えていない手前側のオフセットは崩れない。
async function applyBatch(io, patches) {
  const byFile = new Map();
  for (const p of patches) {
    if (!byFile.has(p.fileRel)) byFile.set(p.fileRel, []);
    byFile.get(p.fileRel).push(p);
  }
  const results = [];
  for (const [file, list] of byFile) {
    list.sort((a, b) => b.srcStart - a.srcStart);
    for (const p of list) {
      try {
        await applyOne(io, p);
        results.push({ patch: p, ok: true });
      } catch (e) {
        results.push({ patch: p, ok: false, error: errorMessage(e) });
      }
    }
  }
  return results;
}

export { applyOne, applyBatch };
