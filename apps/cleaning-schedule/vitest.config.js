import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    // 旧 GAS 版は JST(UTC+9) のスクリプトタイムゾーンで動いていた。
    // 比較用の legacy エンジンは Date のローカル解釈に依存するため、
    // テストのタイムゾーンを固定して結果を再現可能にする。
    env: { TZ: 'UTC' }
  }
});
