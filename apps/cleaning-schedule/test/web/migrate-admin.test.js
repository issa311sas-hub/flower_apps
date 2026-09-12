/**
 * 管理画面からのデータベース更新のテスト
 *
 * 本番で 0003 が未適用のまま残った件の再発防止。
 * 原因は仕組みではなく導線で、/setup が管理者ログインを要求するため
 * 「URLを開いたのに何も起きない」状態になっていた。
 * 管理画面（＝すでにログイン済み）から1クリックで当てられることを固定する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser } from '../../src/db/users.js';
import { getStaffByName } from '../../src/db/staff.js';
import { getSchemaState, listPendingMigrations } from '../../src/db/migrate.js';
import { MIGRATIONS } from '../../src/db/migrations.js';
import { listNotifications } from '../../src/db/notifications.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const FAST = { pepper: PEPPER, iterations: 1000 };

let env;
let cookie;

beforeEach(async () => {
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER };
  cookie = await loginAs('owner', null);
});

async function loginAs(loginId, staffName) {
  const staff = staffName ? await getStaffByName(env.DB, staffName) : null;
  const created = await createUser(
    env.DB,
    {
      loginId,
      displayName: staffName ?? '経営者',
      role: staff ? 'staff' : 'admin',
      staffId: staff?.id ?? null,
      mustChange: false
    },
    FAST
  );
  const res = await worker.fetch(post('/login', { login_id: loginId, password: created.password }), env);
  return (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
}

function get(path, cookieValue = cookie) {
  return new Request(`${ORIGIN}${path}`, { headers: cookieValue ? { cookie: cookieValue } : {} });
}

function post(path, body, { cookie: cookieValue, origin = ORIGIN } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookieValue) headers.cookie = cookieValue;
  if (origin !== null) headers.origin = origin;
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body ?? {}).toString()
  });
}

/** 本番で起きた状態を作る: 最後のマイグレーションだけ未適用 */
/**
 * マイグレーションを1つ取り消す方法。
 *
 * 「いちばん新しいものが未適用」という状況を作るために使う。
 * **マイグレーションを足したらここにも足すこと。** 知らない名前が来たら
 * 黙って通さず落とす（取り消せていないのに未適用のふりをすると、
 * テストが何を確かめているのか分からなくなるため）。
 */
const UNDO = {
  '0003_completion_reports.sql': async () => {
    await env.DB.prepare('DROP TABLE IF EXISTS report_answers').run();
    await env.DB.prepare('DROP TABLE IF EXISTS completion_reports').run();
  },
  '0004_checkin_limit.sql': async () => {
    await env.DB.prepare('ALTER TABLE availability DROP COLUMN checkin_limit').run();
  }
};

async function pretendOutdated() {
  const last = MIGRATIONS[MIGRATIONS.length - 1].name;
  const undo = UNDO[last];
  if (!undo) throw new Error(`${last} の取り消し方が UNDO にありません。足してください。`);

  await env.DB.prepare('DELETE FROM schema_migrations WHERE name = ?').bind(last).run();
  await undo();
  return last;
}

/**
 * 適用すると必ず失敗する状態を作る。
 * 記録だけ消して表は残すので、CREATE TABLE が「すでにある」で落ちる。
 * （途中まで適用されて記録が食い違った、という状況の再現）
 */
async function pretendBroken() {
  const last = MIGRATIONS[MIGRATIONS.length - 1].name;
  await env.DB.prepare('DELETE FROM schema_migrations WHERE name = ?').bind(last).run();
  return last;
}

describe('未適用があるとき', () => {
  it('管理画面のいちばん上で知らせ、その場で更新できる', async () => {
    const pending = await pretendOutdated();

    const body = await (await worker.fetch(get('/admin'), env)).text();
    expect(body).toContain('データベースの更新が 1件 あります');
    expect(body).toContain('action="/admin/migrate"');
    expect(body).toContain('いま更新する');

    const res = await worker.fetch(post('/admin/migrate', {}, { cookie }), env);
    const result = await res.text();

    expect(res.status).toBe(200);
    expect(result).toContain('データベースを更新しました');
    expect(result).toContain(pending);

    expect(await listPendingMigrations(env.DB, MIGRATIONS)).toEqual([]);
    expect((await getSchemaState(env.DB)).tables).toContain('completion_reports');
  });

  it('2回押しても二重に適用されない', async () => {
    await pretendOutdated();
    await worker.fetch(post('/admin/migrate', {}, { cookie }), env);
    const second = await worker.fetch(post('/admin/migrate', {}, { cookie }), env);

    expect(await second.text()).toContain('すでに最新です');
    expect(Number(await env.DB.prepare('SELECT COUNT(*) AS n FROM schema_migrations').first('n'))).toBe(
      MIGRATIONS.length
    );
  });

  it('失敗したら理由を画面に出す', async () => {
    await pretendBroken();

    const res = await worker.fetch(post('/admin/migrate', {}, { cookie }), env);

    expect(res.status).toBe(500);
    expect(await res.text()).toContain('更新に失敗しました');
  });

  it('更新すると管理画面から知らせが消える', async () => {
    await pretendOutdated();
    await worker.fetch(post('/admin/migrate', {}, { cookie }), env);

    const body = await (await worker.fetch(get('/admin'), env)).text();
    expect(body).not.toContain('データベースの更新が');
  });
});

describe('未適用がないとき', () => {
  it('管理画面に知らせを出さない', async () => {
    const body = await (await worker.fetch(get('/admin'), env)).text();
    expect(body).not.toContain('データベースの更新が');
  });

  it('押しても何も変えない', async () => {
    const before = await getSchemaState(env.DB);

    const res = await worker.fetch(post('/admin/migrate', {}, { cookie }), env);
    expect(await res.text()).toContain('すでに最新です');

    expect((await getSchemaState(env.DB)).tables).toEqual(before.tables);
  });

});

describe('アクセス制御', () => {
  it('スタッフは更新できない', async () => {
    await pretendOutdated();
    const sid = await loginAs('hosoda', '細田さん');

    const res = await worker.fetch(post('/admin/migrate', {}, { cookie: sid }), env);

    expect(res.headers.get('location')).toBe('/me');
    expect(await listPendingMigrations(env.DB, MIGRATIONS)).toHaveLength(1);
  });

  it('Origin の無いPOSTは拒否する', async () => {
    await pretendOutdated();

    const res = await worker.fetch(post('/admin/migrate', {}, { cookie, origin: null }), env);

    expect(res.status).toBe(403);
    expect(await listPendingMigrations(env.DB, MIGRATIONS)).toHaveLength(1);
  });

  it('未ログインだとログイン画面に送られる', async () => {
    const res = await worker.fetch(post('/admin/migrate', {}, {}), env);
    expect(res.headers.get('location')).toContain('/login');
  });
});

describe('自動実行のときにも適用する', () => {
  /** cron の呼び出し（Beds24 には触らせない） */
  const runCron = async (cron = '0 9 * * *') => {
    await worker.scheduled({ cron }, { ...env, TOKEN_ENC_KEY: undefined }, {});
  };

  it('誰も画面を開かなくても、いずれ当たる', async () => {
    await pretendOutdated();

    await runCron();

    expect(await listPendingMigrations(env.DB, MIGRATIONS)).toEqual([]);
    expect((await getSchemaState(env.DB)).tables).toContain('completion_reports');
  });

  it('更新に失敗しても、ジョブ本体は動く', async () => {
    await pretendBroken();

    await runCron();

    // 見張りジョブは実行され、失敗は通知に残る
    const runs = await env.DB.prepare('SELECT COUNT(*) AS n FROM runs').first('n');
    expect(Number(runs)).toBeGreaterThan(0);

    const kinds = (await listNotifications(env.DB)).map((n) => n.kind);
    expect(kinds).toContain('migration_failed');
  });
});
