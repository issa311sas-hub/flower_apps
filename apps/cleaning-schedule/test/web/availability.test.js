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
