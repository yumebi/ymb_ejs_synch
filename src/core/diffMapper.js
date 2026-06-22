const { diffLines } = require('diff');

// removed側とadded側に共通する先頭/末尾を取り除き、実際に変化した中心部分だけを残す。
// これをやらないと、同じ行に空文字を出すだけの動的タグ(<%- path %> 等)が混在するだけで
// 行全体が「動的部分に重なる」と誤判定されて要レビューに落ちてしまう。
function trimCommon(oldVal, newVal) {
  const maxLen = Math.min(oldVal.length, newVal.length);
  let prefix = 0;
  while (prefix < maxLen && oldVal[prefix] === newVal[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = maxLen - prefix;
  while (suffix < maxSuffix && oldVal[oldVal.length - 1 - suffix] === newVal[newVal.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

// baselineHtml(現EJSを再ビルドした想定HTML) と deployedHtml(クライアントが直接編集した公開HTML)
// を行単位で比較し、各変更を baseline 上の文字位置レンジに変換する。
function computeRawOps(baselineHtml, deployedHtml) {
  const parts = diffLines(baselineHtml, deployedHtml);
  const ops = [];
  let oldPos = 0;
  let newPos = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      oldPos += part.value.length;
      newPos += part.value.length;
      continue;
    }
    if (part.removed && parts[i + 1] && parts[i + 1].added) {
      const next = parts[i + 1];
      const { prefix, suffix } = trimCommon(part.value, next.value);
      ops.push({
        oldStart: oldPos + prefix,
        oldEnd: oldPos + part.value.length - suffix,
        newStart: newPos + prefix,
        newEnd: newPos + next.value.length - suffix,
      });
      oldPos += part.value.length;
      newPos += next.value.length;
      i++; // 対になった added 側を消費済みにする
      continue;
    }
    if (part.removed) {
      ops.push({ oldStart: oldPos, oldEnd: oldPos + part.value.length, newStart: newPos, newEnd: newPos });
      oldPos += part.value.length;
      continue;
    }
    if (part.added) {
      ops.push({ oldStart: oldPos, oldEnd: oldPos, newStart: newPos, newEnd: newPos + part.value.length });
      newPos += part.value.length;
      continue;
    }
  }
  return ops;
}

// 境界を含む(inclusive)ことで、挿入(start===end)が「リテラル区間の内部」
// 「リテラル区間の直前/直後」のどちらに当たる場合もまとめて拾える。
function findContaining(segments, start, end) {
  return segments.find((s) => s.outputStart <= start && s.outputEnd >= end);
}

// patches: 自動反映可能(auto)か要レビュー(review)かを判定して返す。
// id は scanner 側で page を跨いで一意付与する。
function computePatches(baselineHtml, segments, deployedHtml) {
  const ops = computeRawOps(baselineHtml, deployedHtml);
  const sorted = [...segments].sort((a, b) => a.outputStart - b.outputStart);
  const patches = [];

  for (const op of ops) {
    const oldText = baselineHtml.slice(op.oldStart, op.oldEnd);
    const newText = deployedHtml.slice(op.newStart, op.newEnd);
    const seg = findContaining(sorted, op.oldStart, op.oldEnd);

    if (seg) {
      const localStart = op.oldStart - seg.outputStart;
      const localEnd = op.oldEnd - seg.outputStart;
      patches.push({
        confidence: 'auto',
        file: seg.file,
        srcStart: seg.srcStart + localStart,
        srcEnd: seg.srcStart + localEnd,
        oldText: seg.text.slice(localStart, localEnd),
        newText,
        oldHtml: oldText,
        newHtml: newText,
      });
    } else {
      const reason = op.oldStart === op.oldEnd
        ? '動的部分の近くへの挿入のため自動判定不可'
        : '変更範囲が動的部分(include/式埋め込み等)に重なるため自動判定不可';
      patches.push({ confidence: 'review', reason, oldHtml: oldText, newHtml: newText });
    }
  }

  return patches;
}

module.exports = { computePatches, computeRawOps };
