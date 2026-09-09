import { defineConfig } from 'vitest/config';

export default defineConfig({
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
