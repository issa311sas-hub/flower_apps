/**
 * 暗号まわりのテスト
 *
 * 手順書が「16進数64文字」を作らせていた一方、実装は「32バイトのbase64」を
 * 要求しており、登録していれば Beds24 接続時に失敗していた。
 * 同じ食い違いを二度と起こさないよう、鍵の形式をここで固定する。
 */

import { describe, it, expect } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  hashPassword,
  verifyPassword,
  sha256Hex,
  randomToken,
  toBase64,
  fromBase64
} from '../../src/integrations/crypto.js';

/** /setup/keys が生成するのと同じ形式の鍵 */
function generateKey() {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

describe('TOKEN_ENC_KEY の形式', () => {
  it('生成した鍵は32バイトのbase64になっている', () => {
    const key = generateKey();
    expect(fromBase64(key)).toHaveLength(32);
  });

  it('生成した鍵で暗号化・復号ができる', async () => {
    const key = generateKey();
    const encrypted = await encryptSecret('beds24-refresh-token', key);

    expect(encrypted).not.toContain('beds24-refresh-token');
    expect(await decryptSecret(encrypted, key)).toBe('beds24-refresh-token');
  });

  it('毎回ちがう暗号文になる（同じ値を暗号化しても）', async () => {
    const key = generateKey();
    const a = await encryptSecret('same', key);
    const b = await encryptSecret('same', key);

    expect(a).not.toBe(b);
    expect(await decryptSecret(a, key)).toBe('same');
    expect(await decryptSecret(b, key)).toBe('same');
  });

  it('16進数の文字列は鍵として受け付けない（手順書の不整合の再発防止）', async () => {
    const hex = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    await expect(encryptSecret('x', hex)).rejects.toThrow(/32バイト/);
  });

  it('長さが足りない鍵は受け付けない', async () => {
    await expect(encryptSecret('x', toBase64(new Uint8Array(16)))).rejects.toThrow(/32バイト/);
  });

  it('鍵が未設定なら分かりやすいエラーになる', async () => {
    await expect(encryptSecret('x', '')).rejects.toThrow(/TOKEN_ENC_KEY が設定されていません/);
  });

  it('別の鍵では復号できない', async () => {
    const encrypted = await encryptSecret('secret', generateKey());
    await expect(decryptSecret(encrypted, generateKey())).rejects.toThrow();
  });
});

describe('パスワード（M4の認証で使う）', () => {
  it('同じパスワードなら検証が通る', async () => {
    const stored = await hashPassword('correct-horse', { iterations: 1000 });
    expect(await verifyPassword('correct-horse', stored)).toBe(true);
  });

  it('違うパスワードは通らない', async () => {
    const stored = await hashPassword('correct-horse', { iterations: 1000 });
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('同じパスワードでもソルトが違えばハッシュは変わる', async () => {
    const a = await hashPassword('same', { iterations: 1000 });
    const b = await hashPassword('same', { iterations: 1000 });
    expect(a.hash).not.toBe(b.hash);
    expect(a.salt).not.toBe(b.salt);
  });

  it('反復回数は保存され、後から引き上げられる', async () => {
    const stored = await hashPassword('pw', { iterations: 1000 });
    expect(stored.iterations).toBe(1000);
    // 保存された反復回数で検証されるので、古いハッシュもそのまま使える
    expect(await verifyPassword('pw', stored)).toBe(true);
  });
});

describe('その他', () => {
  it('セッショントークンはURLに載せられる文字だけになる', () => {
    for (let i = 0; i < 20; i++) {
      expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('毎回ちがうトークンになる', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => randomToken()));
    expect(tokens.size).toBe(100);
  });

  it('同じ文字列からは同じハッシュになる（セッションIDの保存用）', async () => {
    expect(await sha256Hex('abc')).toBe(await sha256Hex('abc'));
    expect(await sha256Hex('abc')).not.toBe(await sha256Hex('abd'));
  });
});
