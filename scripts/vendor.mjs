// 画面側(ブラウザ)で使う、`diff` ライブラリの ES モジュール版を、`renderer/vendor/diff/` に写す。
// 画面は `renderer/` をそのまま配るため、node_modules は、見えない。依存の版は package.json / package-lock.json で
// 管理し(Dependabot・OSV-Scanner の対象)、写しはビルドのたびに作り直す(`renderer/vendor/` は Git に入れない)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'diff', 'libesm');
const dest = path.join(root, 'renderer', 'vendor', 'diff');

if (!fs.existsSync(src)) {
  console.error('node_modules/diff/libesm が見つかりません。先に npm ci を実行してください。');
  process.exit(1);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, {
  recursive: true,
  filter: (p) => !p.endsWith('.d.ts') && !p.endsWith('.map'),
});
const license = path.join(root, 'node_modules', 'diff', 'LICENSE');
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(dest, 'LICENSE'));
console.log('diff を renderer/vendor/diff に写しました');
