/**
 * 見張り役（keepAlive）のテスト
 *
 * 旧 GAS 版が静かに停止して誰も気づけなかった件の再発防止が目的のジョブなので、
 * 「気づける状態になっているか」を検証する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../support/d1-sqlite.js';
import { runKeepAlive } from '../../src/jobs/keepAlive.js';
import { connectWithInviteCode } from '../../src/integrations/beds24.js';
import { getAuthStatus, STATE } from '../../src/db/beds24Auth.js';
import { startRun, finishRun, listRuns } from '../../src/db/runs.js';
import { listUnacknowledged } from '../../src/db/notifications.js';

const ENC_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const NOW = Date.parse('2026-09-09T09:00:00Z'); // JST 18:00

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

let db;
beforeEach(() => {
  db = createTestDb();
});

function stub(handlers) {
  const calls = [];
  return Object.assign(
    async (url, init) => {
      calls.push({ url, headers: init?.headers ?? {} });
      for (const [pattern, respond] of handlers) if (url.includes(pattern)) return respond(url);
      throw new Error(`想定外のURL: ${url}`);
    },
    { calls }
  );
}

describe('見張り役', () => {
  it('未接続でも落ちずに完了する', async () => {
    const result = await runKeepAlive({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('未接続');
    expect((await listRuns(db))[0].kind).toBe('keepalive');
  });

  it('接続済みならトークンを能動的に更新する（30日失効の防止）', async () => {
    const fetchImpl = stub([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r1', token: 't1', expiresIn: 86400 })],
      ['/authentication/token', () => jsonResponse({ refreshToken: 'r2', token: 't2', expiresIn: 86400 })]
    ]);
    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl, now: () => NOW });

    const result = await runKeepAlive({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW, fetchImpl });

    expect(result.message).toContain('トークン更新OK');
    // 期限内であっても必ず取り直している（使わないと失効するため）
    expect(fetchImpl.calls.some((c) => c.url.includes('/authentication/token'))).toBe(true);
  });

  it('トークンが失効していたら通知に残す', async () => {
    const fetchImpl = stub([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r', token: 't', expiresIn: 86400 })],
      ['/authentication/token', () => jsonResponse({ error: 'unauthorized' }, 401)]
    ]);
    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl, now: () => NOW });

    await runKeepAlive({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW, fetchImpl });

    const notices = await listUnacknowledged(db);
    expect(notices.map((n) => n.kind)).toContain('auth_expired');
    expect((await getAuthStatus(db)).state).toBe(STATE.NEEDS_RECONNECT);
  });

  // ------------------------------------------------------------------
  // 実行ログの「結果」欄が本当のことを言っているか
  //
  // 以前はここが無条件に ok:true で、トークン更新に失敗しても
  // 一覧には緑の「正常」と出ていた。内容欄と結果欄が矛盾していて、
  // 一目見て異常に気づけない状態だった。
  // ------------------------------------------------------------------

  it('★トークン更新に失敗したら、実行の行は「失敗」になる', async () => {
    const fetchImpl = stub([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r', token: 't', expiresIn: 86400 })],
      ['/authentication/token', () => jsonResponse({ error: 'unauthorized' }, 401)]
    ]);
    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl, now: () => NOW });

    const result = await runKeepAlive({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW, fetchImpl });

    expect(result.ok).toBe(false);
    expect((await listRuns(db))[0].ok).toBe(0);
  });

  it('失敗の内容は error 列にも入る（詳細画面の赤い枠に出すため）', async () => {
    const fetchImpl = stub([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r', token: 't', expiresIn: 86400 })],
      ['/authentication/token', () => jsonResponse({ error: 'unauthorized' }, 401)]
    ]);
    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl, now: () => NOW });

    await runKeepAlive({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW, fetchImpl });

    const row = (await listRuns(db))[0];
    expect(row.error).toContain('トークン更新に失敗');
    expect(row.error).toContain('401'); // 切り分けに要るので HTTP の数字まで残す
  });

  it('未接続は「失敗」にしない（まだ繋いでいないだけ）', async () => {
    const result = await runKeepAlive({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW });

    expect(result.ok).toBe(true);
    expect((await listRuns(db))[0].ok).toBe(1);
  });

  it('★滞留を見つけただけでは「失敗」にしない（見つけるのが仕事なので）', async () => {
    const runId = await startRun(db, 'cron', { at: '2026-09-01T21:00:00Z' });
    await finishRun(db, runId, { ok: true, at: '2026-09-01T21:00:00Z' });

    const result = await runKeepAlive({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW });

    expect(result.stale).toBe(true);
    expect(result.ok).toBe(true);
    expect((await listRuns(db))[0].ok).toBe(1);
  });

  it('トークン更新が通れば「正常」', async () => {
    const fetchImpl = stub([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r', token: 't', expiresIn: 86400 })],
      ['/authentication/token', () => jsonResponse({ token: 't2', expiresIn: 86400 })]
    ]);
    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl, now: () => NOW });

    const result = await runKeepAlive({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW, fetchImpl });

    expect(result.ok).toBe(true);
    expect((await listRuns(db))[0].ok).toBe(1);
    expect((await listRuns(db))[0].error).toBe(null);
  });

  it('日次処理が3日以上成功していなければ通知に残す', async () => {
    const runId = await startRun(db, 'cron', { at: '2026-09-01T21:00:00Z' });
    await finishRun(db, runId, { ok: true, at: '2026-09-01T21:00:00Z' });

    const result = await runKeepAlive({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW });

    expect(result.stale).toBe(true);
    const notices = await listUnacknowledged(db);
    expect(notices.map((n) => n.kind)).toContain('stale_run');
  });

  it('直近に成功していれば滞留の通知は出さない', async () => {
    const runId = await startRun(db, 'cron', { at: '2026-09-09T00:00:00Z' });
    await finishRun(db, runId, { ok: true, at: '2026-09-09T00:00:00Z' });

    const result = await runKeepAlive({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW });

    expect(result.stale).toBe(false);
    expect((await listUnacknowledged(db)).map((n) => n.kind)).not.toContain('stale_run');
  });

  it('期限切れのログインセッションを掃除する', async () => {
    await db
      .prepare(
        `INSERT INTO users (login_id, display_name, role, password_iterations, password_salt, password_hash, created_at, updated_at)
         VALUES ('u1', 'テスト', 'staff', 1, 's', 'h', ?, ?)`
      )
      .bind(NOW, NOW)
      .run();

    await db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, 1, ?, ?, ?)')
      .bind('expired', '2026-08-01T00:00:00Z', '2026-08-08T00:00:00Z', '2026-08-01T00:00:00Z')
      .run();
    await db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, 1, ?, ?, ?)')
      .bind('valid', '2026-09-01T00:00:00Z', '2027-03-01T00:00:00Z', '2026-09-01T00:00:00Z')
      .run();

    const result = await runKeepAlive({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW });

    expect(result.sweptCount).toBe(1);
    const remaining = await db.prepare('SELECT id FROM sessions').all();
    expect(remaining.results.map((r) => r.id)).toEqual(['valid']);
  });
});

describe('見張り役は滞留の判定を壊さない', () => {
  it('★何日動かしても、日次処理の滞留は進み続ける', async () => {
    // 見張り役は必ず正常終了する。これを「成功した実行」に数えると、
    // 朝6時が一度も動かなくても毎日リセットされ、警告が永久に出なくなる。
    // 実際にそうなっていて、利用者に指摘されるまで気づけなかった。
    const { startRun, finishRun, getRunHealth } = await import('../../src/db/runs.js');

    const daily = await startRun(db, 'cron');
    await finishRun(db, daily, { ok: true, at: '2026-09-01T21:00:00Z' });

    for (const day of ['02', '03', '04', '05']) {
      await runKeepAlive({ DB: db }, { now: Date.parse(`2026-09-${day}T09:00:00Z`) });
    }

    const health = await getRunHealth(db, Date.parse('2026-09-05T21:00:00Z'));
    expect(health.lastSuccessAt).toBe('2026-09-01T21:00:00Z');
    expect(health.isStale).toBe(true);
  });
});
