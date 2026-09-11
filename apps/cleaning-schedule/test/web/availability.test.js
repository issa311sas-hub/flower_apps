/**
 * 出勤入力の状況（管理画面）のテスト
 *
 * この画面の値がずれると、外注費の見込みを誤る。
 * 特に「未入力」と「0件の入力」は意味が違うので、必ず区別されることを固定する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser } from '../../src/db/users.js';
import { getStaffByName } from '../../src/db/staff.js';
import { setCapacityBulk } from '../../src/db/availability.js';
import { saveAssignments } from '../../src/db/assignments.js';
import { applyFetchedBookings } from '../../src/db/bookings.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const FAST = { pepper: PEPPER, iterations: 1000 };
const MONTH = '2099-01';

let env;
let cookie;

beforeEach(async () => {
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER };
  const created = await createUser(
    env.DB,
    { loginId: 'owner', displayName: '経営者', role: 'admin', mustChange: false },
    FAST
  );
  const res = await worker.fetch(post('/login', { login_id: 'owner', password: created.password }), env);
  cookie = (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
});

function get(path, cookieValue = cookie) {
  return new Request(`${ORIGIN}${path}`, { headers: cookieValue ? { cookie: cookieValue } : {} });
}

function post(path, body, { cookie: cookieValue } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN };
  if (cookieValue) headers.cookie = cookieValue;
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString()
  });
}

async function enter(staffName, entries) {
  const staff = await getStaffByName(env.DB, staffName);
  await setCapacityBulk(env.DB, staff.id, entries);
}

/** その日に清掃を n 件つくる */
async function seedCleanings(date, count) {
  const bookings = Array.from({ length: count }, (_, i) => ({
    bookingId: `${date}-${i}`,
    title: '',
    startDate: date,
    checkoutDate: date,
    unit: ['b4', 'b5', 'b6', 'b2', 'b3'][i] ?? 'c4',
    guests: 2
  }));

  await applyFetchedBookings(env.DB, bookings, { from: '2099-01-01', to: '2099-12-31' }, '2099-01-01T00:00:00Z');
  await saveAssignments(
    env.DB,
    bookings.map((b) => ({
      bookingId: b.bookingId,
      checkoutDate: date,
      cleaningDate: date,
      unit: b.unit,
      title: '',
      staffName: '未割当',
      status: '要確認',
      isManual: false
    })),
    {}
  );
}

/** 表の1行を取り出す（日付の数字で探す） */
function rowFor(body, day) {
  const match = body.match(new RegExp(`<tr[^>]*>\\s*<th[^>]*>\\s*<a[^>]*>${day}\\([^)]*\\)</a>[\\s\\S]*?</tr>`));
  return match ? match[0] : null;
}

describe('出勤入力の状況', () => {
  it('担当者ごとの入力値が日付の行に並ぶ', async () => {
    await enter('細田さん', [{ date: '2099-01-10', capacity: 3 }]);
    await enter('普久原さん', [{ date: '2099-01-10', capacity: 2 }]);

    const body = await (await worker.fetch(get(`/admin/availability?month=${MONTH}`), env)).text();
    const row = rowFor(body, 10);

    expect(row).toContain('<td>3</td>');
    expect(row).toContain('<td>2</td>');
    // 福田さんは未入力
    expect(row).toContain('<td class="unset">-</td>');
  });

  it('「未入力」と「0件の入力」を区別する', async () => {
    await enter('細田さん', [{ date: '2099-01-11', capacity: 0 }]);

    const body = await (await worker.fetch(get(`/admin/availability?month=${MONTH}`), env)).text();
    const row = rowFor(body, 11);

    // 0件は入力済み。未入力の「-」とは別物
    expect(row).toContain('<td>0</td>');
    expect(row).toContain('<td class="unset">-</td>');
  });

  it('枠・清掃・過不足を計算する', async () => {
    await enter('細田さん', [{ date: '2099-01-12', capacity: 3 }]);
    await enter('福田さん', [{ date: '2099-01-12', capacity: 2 }]);
    await seedCleanings('2099-01-12', 4);

    const body = await (await worker.fetch(get(`/admin/availability?month=${MONTH}`), env)).text();
    const row = rowFor(body, 12);

    expect(row).toContain('<td>5</td>'); // 枠
    expect(row).toContain('<td>4</td>'); // 清掃
    expect(row).toContain('+1'); // 過不足
    expect(row).not.toContain('class="short"');
  });

  it('枠が足りない日は目印を付け、件数を先に伝える', async () => {
    await enter('細田さん', [{ date: '2099-01-13', capacity: 1 }]);
    await seedCleanings('2099-01-13', 3);

    const body = await (await worker.fetch(get(`/admin/availability?month=${MONTH}`), env)).text();

    expect(rowFor(body, 13)).toContain('class="short"');
    expect(body).toContain('枠が足りない日が 1日あります');
    expect(body).toContain('外注');
  });

  it('足りていれば、その旨を伝える', async () => {
    const body = await (await worker.fetch(get(`/admin/availability?month=${MONTH}`), env)).text();
    expect(body).toContain('枠が足りています');
  });

  it('担当者ごとの入力済み日数と合計件数が出る', async () => {
    await enter('細田さん', [
      { date: '2099-01-10', capacity: 3 },
      { date: '2099-01-11', capacity: 2 }
    ]);

    const body = await (await worker.fetch(get(`/admin/availability?month=${MONTH}`), env)).text();

    expect(body).toContain('2 / 31日');
    expect(body).toContain('合計 5件');
  });

  it('外注（Rクリーン）は列に出ない', async () => {
    const body = await (await worker.fetch(get(`/admin/availability?month=${MONTH}`), env)).text();

    expect(body).toContain('細田さん');
    expect(body).not.toContain('Rクリーン');
  });

  it('月を切り替えられる', async () => {
    await enter('細田さん', [{ date: '2099-02-05', capacity: 4 }]);

    const jan = await (await worker.fetch(get('/admin/availability?month=2099-01'), env)).text();
    const feb = await (await worker.fetch(get('/admin/availability?month=2099-02'), env)).text();

    expect(jan).toContain('2099年1月の出勤入力');
    expect(feb).toContain('2099年2月の出勤入力');
    expect(rowFor(feb, 5)).toContain('<td>4</td>');
    expect(feb).toContain('合計 4件');
    expect(jan).not.toContain('合計 4件');
  });

  it('日付からその週のタイムラインに飛べる', async () => {
    const body = await (await worker.fetch(get(`/admin/availability?month=${MONTH}`), env)).text();
    expect(body).toContain('href="/admin/timeline?from=2099-01-10&days=7"');
  });

  it('スタッフは入れない', async () => {
    const staff = await getStaffByName(env.DB, '細田さん');
    const created = await createUser(
      env.DB,
      { loginId: 'hosoda', displayName: '細田さん', role: 'staff', staffId: staff.id, mustChange: false },
      FAST
    );
    const login = await worker.fetch(post('/login', { login_id: 'hosoda', password: created.password }), env);
    const sid = (login.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];

    const res = await worker.fetch(get('/admin/availability', sid), env);
    expect(res.headers.get('location')).toBe('/me');
  });

  it('未ログインだとログイン画面に送られる', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/admin/availability`), env);
    expect(res.headers.get('location')).toContain('/login');
  });
});

// ------------------------------------------------------------------
// 代理入力（管理者が本人の代わりに入れる）
//
// 入力されない日は「出勤できない」扱いで外注に回る。本人が入れられない
// まま放置されると、そのまま費用になる。管理者が電話や LINE で聞いた分を
// 入れられるようにしたもの。
//
// 他人の出勤を書き換えられる画面なので、認可を最優先で固定する。
// ------------------------------------------------------------------

describe('出勤の代理入力', () => {
  const FUTURE = `${MONTH}-15`;

  const staffId = async (name = '細田さん') => (await getStaffByName(env.DB, name)).id;

  /** スタッフ権限でログインして cookie を返す */
  async function loginAsStaff(name = '普久原さん') {
    const staff = await getStaffByName(env.DB, name);
    const created = await createUser(
      env.DB,
      { loginId: `u${staff.id}`, displayName: name, role: 'staff', staffId: staff.id, mustChange: false },
      FAST
    );
    const res = await worker.fetch(post('/login', { login_id: `u${staff.id}`, password: created.password }), env);
    return (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
  }

  it('★スタッフ権限では他人の出勤を開けない', async () => {
    const target = await staffId('細田さん');
    const staffCookie = await loginAsStaff('普久原さん');

    // ログイン自体は成立していることを先に確かめる。
    // これが無いと、ログイン失敗でも「開けない」ので素通りしてしまう
    expect((await worker.fetch(get('/me/availability', staffCookie), env)).status).toBe(200);

    const res = await worker.fetch(get(`/admin/availability/${target}?month=${MONTH}`, staffCookie), env);
    expect(res.status).not.toBe(200);
  });

  it('★スタッフ権限では他人の出勤を保存できない', async () => {
    const target = await staffId('細田さん');
    const staffCookie = await loginAsStaff('普久原さん');

    expect((await worker.fetch(get('/me/availability', staffCookie), env)).status).toBe(200);

    await worker.fetch(
      post(`/admin/availability/${target}`, { month: MONTH, [`cap_${FUTURE}`]: '4' }, { cookie: staffCookie }),
      env
    );

    const row = await env.DB.prepare('SELECT capacity FROM availability WHERE staff_id = ? AND date = ?')
      .bind(target, FUTURE)
      .first();
    expect(row).toBeFalsy();
  });

  it('★スタッフ権限では自分の分すら管理者用の経路からは保存できない', async () => {
    const self = await getStaffByName(env.DB, '普久原さん');
    const staffCookie = await loginAsStaff('普久原さん');

    await worker.fetch(
      post(`/admin/availability/${self.id}`, { month: MONTH, [`cap_${FUTURE}`]: '4' }, { cookie: staffCookie }),
      env
    );

    const row = await env.DB.prepare('SELECT capacity FROM availability WHERE staff_id = ? AND date = ?')
      .bind(self.id, FUTURE)
      .first();
    expect(row).toBeFalsy();
  });

  it('未ログインでは開けない', async () => {
    const target = await staffId();
    const res = await worker.fetch(get(`/admin/availability/${target}?month=${MONTH}`, null), env);
    expect(res.status).not.toBe(200);
  });

  it('管理者は担当者ごとの入力画面を開ける', async () => {
    const target = await staffId('細田さん');
    const res = await worker.fetch(get(`/admin/availability/${target}?month=${MONTH}`), env);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('細田さん');
    expect(body).toContain(`action="/admin/availability/${target}"`);
  });

  it('管理者が入力すると、本人の入力として保存される', async () => {
    const target = await staffId('細田さん');

    const res = await worker.fetch(
      post(`/admin/availability/${target}`, { month: MONTH, view: 'calendar', [`cap_${FUTURE}`]: '4' }, { cookie }),
      env
    );
    expect(res.status).toBe(303);

    const saved = await env.DB.prepare('SELECT capacity FROM availability WHERE staff_id = ? AND date = ?')
      .bind(target, FUTURE)
      .first('capacity');
    expect(saved).toBe(4);
  });

  it('★入力した管理者が updated_by に残る（本人の入力と見分けるため）', async () => {
    const target = await staffId('細田さん');
    await worker.fetch(
      post(`/admin/availability/${target}`, { month: MONTH, [`cap_${FUTURE}`]: '2' }, { cookie }),
      env
    );

    const row = await env.DB.prepare(
      `SELECT u.role AS role, u.login_id AS loginId
         FROM availability a JOIN users u ON u.id = a.updated_by
        WHERE a.staff_id = ? AND a.date = ?`
    )
      .bind(target, FUTURE)
      .first();

    expect(row.role).toBe('admin');
    expect(row.loginId).toBe('owner');
  });

  it('画面に最終更新が出る（黙って上書きしたことにならないように）', async () => {
    const target = await staffId('細田さん');
    await worker.fetch(post(`/admin/availability/${target}`, { month: MONTH, [`cap_${FUTURE}`]: '2' }, { cookie }), env);

    const body = await (await worker.fetch(get(`/admin/availability/${target}?month=${MONTH}`), env)).text();
    expect(body).toContain('最終更新');
    expect(body).toContain('経営者');
  });

  it('「消す」で未入力に戻せる（0件とは意味が違う）', async () => {
    const target = await staffId('細田さん');
    await enter('細田さん', [{ date: FUTURE, capacity: 3 }]);

    await worker.fetch(post(`/admin/availability/${target}`, { month: MONTH, [`cap_${FUTURE}`]: '-1' }, { cookie }), env);

    const row = await env.DB.prepare('SELECT capacity FROM availability WHERE staff_id = ? AND date = ?')
      .bind(target, FUTURE)
      .first();
    expect(row).toBeFalsy();
  });

  it('0件の入力は「未入力」にはしない', async () => {
    const target = await staffId('細田さん');
    await worker.fetch(post(`/admin/availability/${target}`, { month: MONTH, [`cap_${FUTURE}`]: '0' }, { cookie }), env);

    const saved = await env.DB.prepare('SELECT capacity FROM availability WHERE staff_id = ? AND date = ?')
      .bind(target, FUTURE)
      .first('capacity');
    expect(saved).toBe(0);
  });

  it('過去の日付は書き換えない', async () => {
    const target = await staffId('細田さん');
    await worker.fetch(
      post(`/admin/availability/${target}`, { month: '2020-01', cap_2020_01_05: '5', 'cap_2020-01-05': '5' }, { cookie }),
      env
    );

    const row = await env.DB.prepare('SELECT capacity FROM availability WHERE staff_id = ? AND date = ?')
      .bind(target, '2020-01-05')
      .first();
    expect(row).toBeFalsy();
  });

  it('存在しない担当者は 404', async () => {
    expect((await worker.fetch(get('/admin/availability/9999?month=' + MONTH), env)).status).toBe(404);
  });

  it('★外注（Rクリーン）には出勤入力させない', async () => {
    const outsource = await getStaffByName(env.DB, 'Rクリーン');
    const res = await worker.fetch(get(`/admin/availability/${outsource.id}?month=${MONTH}`), env);
    expect(res.status).toBe(404);
  });

  it('一覧から各担当者の入力画面へ行ける', async () => {
    const target = await staffId('細田さん');
    const body = await (await worker.fetch(get(`/admin/availability?month=${MONTH}`), env)).text();
    expect(body).toContain(`/admin/availability/${target}?month=${MONTH}`);
  });
});
