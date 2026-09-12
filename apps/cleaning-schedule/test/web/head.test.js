/**
 * HEAD リクエストに応答することのテスト
 *
 * UptimeRobot などの死活監視は **まず HEAD で叩き、失敗したら GET でやり直す**。
 * ルータがメソッド完全一致だったため、/api/health への HEAD は毎回404を返し、
 * 1回の巡回が2往復になっていた（本番のログで18秒差の HEAD→GET が並んでいた）。
 *
 * それ自体は GET のやり直しで通っていたが、監視を「HEADのみ」に設定すると
 * **健全なのに常時停止と誤検知する**。死活監視の窓口が、監視のやり方しだいで
 * 嘘をつく状態だった。ここを固定する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { startRun, finishRun, recordCronEvent } from '../../src/db/runs.js';

const ORIGIN = 'https://cleaning.example.workers.dev';

let env;

beforeEach(() => {
  env = { DB: createTestDb(), SESSION_PEPPER: 'test-pepper' };
});

const req = (method, path) => new Request(`${ORIGIN}${path}`, { method });
const call = (method, path) => worker.fetch(req(method, path), env);

describe('死活監視の HEAD', () => {
  it('/api/health は HEAD でも 404 にならず、GET と同じ状態を返す', async () => {
    const head = await call('HEAD', '/api/health');
    const get = await call('GET', '/api/health');

    expect(head.status).not.toBe(404);
    expect(head.status).toBe(get.status);
  });

  it('★異常時は HEAD でも 503 を返す（誤検知の逆・見落としを防ぐ）', async () => {
    // 初期データが入っていない ＝ /api/health が異常と判定する状態
    const head = await call('HEAD', '/api/health');
    expect(head.status).toBe(503);
  });

  it('正常時は HEAD でも 200 を返す', async () => {
    // 初期データを入れ、自動実行が成功した実績も作る。
    // 「まだ一度も動いていない」は 503 の扱い（cron 未登録と区別できないため）
    await worker.fetch(new Request(`${ORIGIN}/setup`), env);
    const runId = await startRun(env.DB, 'cron');
    await finishRun(env.DB, runId, { ok: true, stats: { fetched: 1 } });
    await recordCronEvent(env.DB, '0 21 * * *');

    const head = await call('HEAD', '/api/health');
    const get = await call('GET', '/api/health');

    expect(get.status).toBe(200);
    expect(head.status).toBe(200);
  });

  it('HEAD の応答に本文は含まれない', async () => {
    const head = await call('HEAD', '/api/health');
    expect(await head.text()).toBe('');
  });

  it('GET の応答は本文を返したままである（取り違えていない）', async () => {
    const get = await call('GET', '/api/health');
    expect((await get.text()).length).toBeGreaterThan(0);
  });

  it('ヘッダは GET と同じものを返す', async () => {
    const head = await call('HEAD', '/api/health');
    const get = await call('GET', '/api/health');
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
  });

  it('画面のパスも HEAD で引ける（HEAD 専用の登録は無く、GET が使われる）', async () => {
    const head = await call('HEAD', '/login');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('★POST 専用のパスは HEAD でも 404 のまま（GET へ流さない）', async () => {
    // /admin/run は POST だけ。HEAD を GET 扱いにする際に、
    // メソッドの区別まで崩すと、副作用のある処理を GET で叩けてしまう
    expect((await call('HEAD', '/admin/run')).status).toBe(404);
    expect((await call('GET', '/admin/run')).status).toBe(404);
  });

  it('存在しないパスは HEAD でも 404', async () => {
    expect((await call('HEAD', '/nope')).status).toBe(404);
  });
});
