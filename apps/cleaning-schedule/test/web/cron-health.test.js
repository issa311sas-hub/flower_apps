/**
 * 「cron から呼ばれているか」を切り分けられることのテスト
 *
 * 朝6時の自動実行が動かなかったとき、実行の記録が1件も無かった。
 * 実行の行は処理が始まってから作られるので、その手前で落ちた場合も、
 * Cloudflare から呼ばれなかった場合も、**同じ見え方**になっていた。
 *
 * 原因が違えば見に行く先も直し方も違うので、区別できることを固定する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser } from '../../src/db/users.js';
import { getSetting, setSetting } from '../../src/db/settings.js';
import { getCronHealth, recordCronEvent, startRun, finishRun } from '../../src/db/runs.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const FAST = { pepper: PEPPER, iterations: 1000 };

const DAILY_CRON = '0 21 * * *';
const KEEPALIVE_CRON = '0 9 * * *';

let env;
let cookie;

beforeEach(async () => {
  // TOKEN_ENC_KEY を渡さないので Beds24 には触れない（cron の記録だけを見る）
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER };

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

function post(path, body) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: new URLSearchParams(body).toString()
  });
}

const health = async () => (await worker.fetch(get('/api/health'), env)).json();
const adminPage = async () => (await worker.fetch(get('/admin'), env)).text();

/** 日次処理が成功した記録を作る */
async function dailySucceeded(at) {
  const id = await startRun(env.DB, 'cron');
  await finishRun(env.DB, id, { ok: true, at });
}

describe('呼ばれた事実を記録する', () => {
  it('cron から呼ばれると記録が残る', async () => {
    await worker.scheduled({ cron: KEEPALIVE_CRON }, env, {});

    expect(await getSetting(env.DB, 'last_cron_event_at', '')).toBeTruthy();
    expect(await getSetting(env.DB, 'last_cron_expression', '')).toBe(KEEPALIVE_CRON);
  });

  it('★処理が失敗しても、呼ばれた事実は残る', async () => {
    // Beds24 に接続していないので日次処理は失敗する。
    // それでも「呼ばれた」ことは分からないといけない
    await worker.scheduled({ cron: DAILY_CRON }, env, {});

    expect(await getSetting(env.DB, 'last_cron_event_at', '')).toBeTruthy();
    expect(await getSetting(env.DB, 'last_cron_expression', '')).toBe(DAILY_CRON);

    // 日次処理そのものは失敗として記録されている
    const runs = await env.DB.prepare("SELECT ok FROM runs WHERE kind = 'cron'").all();
    expect(runs.results[0].ok).toBe(0);
  });

  it('どちらの cron かが分かる', async () => {
    await worker.scheduled({ cron: DAILY_CRON }, env, {});
    expect(await getSetting(env.DB, 'last_cron_expression', '')).toBe(DAILY_CRON);

    await worker.scheduled({ cron: KEEPALIVE_CRON }, env, {});
    expect(await getSetting(env.DB, 'last_cron_expression', '')).toBe(KEEPALIVE_CRON);
  });

  it('記録に失敗しても本処理は動く（記録のために業務を止めない）', async () => {
    const broken = {
      ...env,
      DB: {
        ...env.DB,
        prepare(sql) {
          if (sql.includes('INSERT INTO settings')) throw new Error('書けません');
          return env.DB.prepare(sql);
        }
      }
    };

    expect(await recordCronEvent(broken.DB, DAILY_CRON)).toBe(false);
  });
});

describe('呼ばれていないことを検知する', () => {
  it('2日呼ばれていなければ異常にする', async () => {
    await setSetting(env.DB, 'last_cron_event_at', '2026-09-08T21:00:00Z');

    const result = await getCronHealth(env.DB, Date.parse('2026-09-10T21:00:00Z'));

    expect(result.silentDays).toBe(2);
    expect(result.isSilent).toBe(true);
  });

  it('前日に呼ばれていれば正常', async () => {
    await setSetting(env.DB, 'last_cron_event_at', '2026-09-09T21:00:00Z');

    const result = await getCronHealth(env.DB, Date.parse('2026-09-10T21:00:00Z'));

    expect(result.silentDays).toBe(1);
    expect(result.isSilent).toBe(false);
  });

  it('/api/health が 503 を返し、Cloudflare の設定を見るよう伝える', async () => {
    await dailySucceeded('2026-09-08T21:00:00Z');
    await setSetting(env.DB, 'last_cron_event_at', '2020-01-01T00:00:00Z');

    const res = await worker.fetch(get('/api/health'), env);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.problems.join()).toContain('呼ばれていません');
    expect(body.problems.join()).toContain('Cron Triggers');
    expect(body.d1.lastCronEventAt).toBe('2020-01-01T00:00:00Z');
  });
});

describe('原因を取り違えない', () => {
  it('呼ばれているのに失敗しているときは、Cloudflare のせいにしない', async () => {
    // 今日呼ばれたが、日次処理は一度も成功していない
    await worker.scheduled({ cron: DAILY_CRON }, env, {});

    const body = await health();
    const problems = body.problems.join();

    expect(problems).not.toContain('呼ばれていません');
    expect(problems).toContain('まだ一度も成功していません');
  });

  it('管理画面でも、呼ばれていない場合はアプリではなく Cloudflare を見るよう案内する', async () => {
    await setSetting(env.DB, 'last_cron_event_at', '2020-01-01T00:00:00Z');

    const body = await adminPage();

    expect(body).toContain('呼ばれていません');
    expect(body).toContain('Cloudflare の設定');
    expect(body).toContain('Cron Triggers');
  });

  it('管理画面で、呼ばれているのに失敗している場合は実行ログへ案内する', async () => {
    await worker.scheduled({ cron: DAILY_CRON }, env, {});

    const body = await adminPage();

    expect(body).toContain('Cloudflare からは呼ばれているので');
    expect(body).toContain('/admin/runs');
    expect(body).not.toContain('Cloudflare の設定');
  });

  it('一度も呼ばれていない状態も、Cloudflare 側として案内する', async () => {
    const body = await adminPage();

    expect(body).toContain('まだ一度も呼ばれていません');
    expect(body).toContain('Cron Triggers');
  });
});

describe('管理画面の表示', () => {
  it('最後に呼ばれた時刻を出す', async () => {
    await setSetting(env.DB, 'last_cron_event_at', '2026-09-09T21:00:00Z');

    const body = await adminPage();

    expect(body).toContain('Cloudflareからの呼び出し');
    expect(body).toContain('2026-09-09T21:00:00Z');
  });
});
