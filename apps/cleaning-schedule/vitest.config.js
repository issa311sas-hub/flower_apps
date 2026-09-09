import { defineConfig } from 'vitest/config';

/**
 * `.sql` を文字列として読み込めるようにする。
 *
 * 本番（wrangler）は .sql を Text モジュールとして扱うが、Vitest は素の JavaScript として
 * 解釈しようとして失敗する。同じ挙動をテスト側でも再現するための変換。
 * これによりスキーマの定義を .sql に一本化したまま、Worker 全体をテストできる。
 */
const sqlAsText = {
  name: 'sql-as-text',
  enforce: 'pre',
  transform(code, id) {
    if (!id.endsWith('.sql')) return null;
    return { code: `export default ${JSON.stringify(code)};`, map: null };
  }
};

export default defineConfig({
  plugins: [sqlAsText],
  test: {
    include: ['test/**/*.test.js'],
    // 新旧一致テストはランダム2000シナリオを回すため数秒かかる。
    // 既定の5秒だとマシンの速さ次第で落ちることがあり、
    // デプロイ（Cloudflare 側で npm test を実行）が理由なく止まるので広めに取る。
    testTimeout: 60000,
    // 旧 GAS 版は JST(UTC+9) のスクリプトタイムゾーンで動いていた。
    // 比較用の legacy エンジンは Date のローカル解釈に依存するため、
    // テストのタイムゾーンを固定して結果を再現可能にする。
    env: { TZ: 'UTC' }
  }
});
