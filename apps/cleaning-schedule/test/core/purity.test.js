/**
 * `src/core/` が純粋であることを機械的に守るテスト
 *
 * 割り当てロジックが DB・ネットワーク・現在時刻に触れ始めると、
 * テストできなくなり、Workers の UTC 問題も再発する。
 * 人間のレビューに頼らず、ここで落とす。
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CORE_DIR = new URL('../../src/core/', import.meta.url).pathname;

// dates.js だけは実時刻の入口（jstToday / nowIso）を持つため例外扱いにする
const TIME_ENTRYPOINT = 'dates.js';

const FORBIDDEN = [
  { pattern: /\bDate\.now\(/, reason: '現在時刻に依存している（today を引数で受け取ること）' },
  { pattern: /\bnew Date\(/, reason: 'Date を直接組み立てている（core/dates.js の関数を使うこと）' },
  { pattern: /\bfetch\(/, reason: 'ネットワークに触れている' },
  { pattern: /\benv\./, reason: 'Cloudflare の env に触れている' },
  { pattern: /\bD1\b/, reason: 'D1 に触れている' },
  { pattern: /\bcrypto\./, reason: 'Web Crypto に触れている' }
];

function coreFiles() {
  return readdirSync(CORE_DIR).filter((f) => f.endsWith('.js'));
}

describe('src/core は純粋であること', () => {
  it('検査対象のファイルが存在する', () => {
    expect(coreFiles().length).toBeGreaterThan(0);
  });

  for (const file of coreFiles()) {
    if (file === TIME_ENTRYPOINT) continue;

    it(`${file} は外部依存を持たない`, () => {
      const source = readFileSync(join(CORE_DIR, file), 'utf8');
      // コメント行は検査対象から外す（説明文に new Date と書くことがあるため）
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');

      for (const { pattern, reason } of FORBIDDEN) {
        expect(pattern.test(code), `${file}: ${reason}`).toBe(false);
      }
    });
  }

  it('core は core の外を import しない', () => {
    for (const file of coreFiles()) {
      const source = readFileSync(join(CORE_DIR, file), 'utf8');
      const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const spec of imports) {
        expect(spec.startsWith('./'), `${file} が core の外を import している: ${spec}`).toBe(true);
      }
    }
  });
});
