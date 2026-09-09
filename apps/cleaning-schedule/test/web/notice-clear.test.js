/**
 * 古い警告が残り続けないことのテスト
 *
 * 「Beds24 は接続済みなのに『再接続が必要です』が管理画面に出たままになる」
 * という報告の再発防止。警告を出す仕組みはあったが、**直ったときに消す仕組みが無かった**。
 * 消えない警告は、しばらくすると誰も読まなくなる。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser } from '../../src/db/users.js';
import { recordNotification, listUnacknowledged } from '../../src/db/notifications.js';
import { saveTokens, recordAuthFailure } from '../../src/db/beds24Auth.js';
import { replaceUnitMap } from '../../src/db/units.js';
import { runDaily } from '../../src/jobs/dailyRun.js';
import { runKeepAlive } from '../../src/jobs/keepAlive.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const ENC_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const FAST = { pepper: PEPPER, iterations: 1000 };
const NOW = Date.parse('2026-09-10T00:00:00Z');

let env;
let cookie;

beforeEach(async () => {
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER, TOKEN_ENC_KEY: ENC_KEY };

  const created = await createUser(
    env.DB,
    { loginId: 'owner', displayName: '経営者', role: 'admin', mustChange: false },
    FAST
  );
  const res = await worker.fetch(post('/login', { login_id: 'owner', password: created.password }), env);
  cookie = (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
});

function get(path) {
  return new Request(`${ORIGIN}${path}`, { headers: { cookie } });
}

function post(path, body, cookieValue) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN };
  if (cookieValue) headers.cookie = cookieValue;
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body ?? {}).toString()
  });
}

const kinds = async () => (await listUnacknowledged(env.DB)).map((n) => n.kind);

/** Beds24 が失効した状態を作る */
async function beds24Expired() {
  await recordAuthFailure(env.DB, { permanent: true, error: 'HTTP 401' });
  await recordNotification(env.DB, {
    kind: 'auth_expired',
    level: 'error',
    subject: 'Beds24 の再接続が必要です',
    body: '招待コードを発行し直してください。'
  });
}

describe('Beds24 につなぎ直したとき', () => {
  it('「再接続が必要です」の警告が消える', async () => {
    await beds24Expired();
    expect(await kinds()).toContain('auth_expired');

    // つなぎ直す（招待コードでも自動更新でも、通るのは saveTokens）
    await saveTokens(env.DB, ENC_KEY, { refreshToken: 'r', accessToken: 'a', expiresInSec: 86400 });

    expect(await kinds()).not.toContain('auth_expired');
  });

  it('失効が近いという警告も消える', async () => {
    await recordNotification(env.DB, {
      kind: 'token_stale',
      level: 'warn',
      subject: 'Beds24 トークンの失効が近づいています',
      body: 'x'
    });

    await saveTokens(env.DB, ENC_KEY, { refreshToken: 'r', accessToken: 'a', expiresInSec: 86400 });

    expect(await kinds()).not.toContain('token_stale');
  });

  it('管理画面から警告が消える', async () => {
    await beds24Expired();
    expect(await (await worker.fetch(get('/admin'), env)).text()).toContain('Beds24 の再接続が必要です');

    await saveTokens(env.DB, ENC_KEY, { refreshToken: 'r', accessToken: 'a', expiresInSec: 86400 });

    expect(await (await worker.fetch(get('/admin'), env)).text()).not.toContain('Beds24 の再接続が必要です');
  });
});

describe('日次処理が通ったとき', () => {
  /**
   * 予約1件を返す Beds24。
   * 退去日は外注に回る期間（実行日から14日）より先にして、未割当のまま残るようにする。
   */
  const okFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      {
        id: 1,
        roomId: 100,
        unitId: 1,
        arrival: '2026-10-10',
        departure: '2026-10-15',
        numAdult: 2,
        status: 'confirmed'
      }
    ],
    text: async () => ''
  });

  async function connected() {
    await replaceUnitMap(env.DB, [{ roomId: '100', unitId: '1', unitName: 'b4' }]);
    await saveTokens(env.DB, ENC_KEY, { refreshToken: 'r', accessToken: 'a', expiresInSec: 86400 }, '2026-09-10T00:00:00Z');
  }

  it('失敗・滞留の警告が消える', async () => {
    await connected();
    for (const kind of ['run_error', 'zero_bookings', 'stale_run']) {
      await recordNotification(env.DB, { kind, level: 'error', subject: kind, body: 'x' });
    }

    const result = await runDaily(env, { now: NOW, fetchImpl: okFetch, sleep: async () => {} });
    expect(result.ok).toBe(true);

    const remaining = await kinds();
    expect(remaining).not.toContain('run_error');
    expect(remaining).not.toContain('zero_bookings');
    expect(remaining).not.toContain('stale_run');
  });

  it('「未割当があります」は消さない（いまの状態を伝えるものなので）', async () => {
    await connected();
    // 出勤入力が無いので未割当になる
    const result = await runDaily(env, { now: NOW, fetchImpl: okFetch, sleep: async () => {} });

    expect(result.ok).toBe(true);
    expect(await kinds()).toContain('unassigned');
  });

  it('失敗したときは消さない', async () => {
    await connected();
    await recordNotification(env.DB, { kind: 'run_error', level: 'error', subject: 'x', body: 'x' });

    const failing = async () => ({ ok: false, status: 500, json: async () => null, text: async () => 'boom' });
    const result = await runDaily(env, { now: NOW, fetchImpl: failing, sleep: async () => {} });

    expect(result.ok).toBe(false);
    expect(await kinds()).toContain('run_error');
  });
});

describe('見張り役', () => {
  it('自分が出した滞留の警告を、自分で消さない', async () => {
    // keepAlive は常に正常終了するので、実行の成功で消す作りにすると
    // 出した直後に自分で消してしまう
    await env.DB.prepare("UPDATE settings SET value = '2020-01-01T00:00:00Z' WHERE key = 'last_success_run_at'").run();

    await runKeepAlive(env, { now: NOW });

    expect(await kinds()).toContain('stale_run');
  });
});

describe('手で片付ける', () => {
  it('管理画面のその場で「確認しました」を押せる', async () => {
    await recordNotification(env.DB, {
      kind: 'unassigned',
      level: 'warn',
      subject: '未割当が 3件あります',
      body: 'x'
    });

    const body = await (await worker.fetch(get('/admin'), env)).text();
    expect(body).toContain('確認しました');

    const [notice] = await listUnacknowledged(env.DB);
    const res = await worker.fetch(post(`/admin/notifications/${notice.id}/ack`, { back: '/admin' }, cookie), env);

    expect(res.headers.get('location')).toBe('/admin');
    expect(await listUnacknowledged(env.DB)).toHaveLength(0);
  });

  it('実行ログから押したときは実行ログに戻る', async () => {
    await recordNotification(env.DB, { kind: 'unassigned', level: 'warn', subject: 'x', body: 'x' });
    const [notice] = await listUnacknowledged(env.DB);

    const res = await worker.fetch(post(`/admin/notifications/${notice.id}/ack`, {}, cookie), env);
    expect(res.headers.get('location')).toBe('/admin/runs');
  });
});
