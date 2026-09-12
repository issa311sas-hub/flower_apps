/**
 * 外注（Rクリーン）のアカウントのテスト
 *
 * 外注は予定を見るだけで、出勤入力は使わない。
 * 割り当てエンジンは外注の出勤入力を読まない（core/assign.js は workers に
 * 外注を入れず、外注に回すときも枠を見ない）ので、入れても何も起きない。
 * 入れられる状態にしておくと「入力したのに反映されない」となるだけ。
 *
 * 完了報告（現地精算金額を含む）は従来どおり使う。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser } from '../../src/db/users.js';
import { getStaffByName, updateStaff } from '../../src/db/staff.js';
import { applyFetchedBookings } from '../../src/db/bookings.js';
import { saveAssignments } from '../../src/db/assignments.js';
import { jstToday, addDays } from '../../src/core/dates.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const FAST = { pepper: PEPPER, iterations: 1000 };
// /me は今日から14日分しか出さないので、予定は必ずその窓の中に置く
const TODAY = jstToday();
const DATE = addDays(TODAY, 2);
const MONTH = DATE.slice(0, 7);

let env;

beforeEach(async () => {
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER };
});

function get(path, cookie) {
  return new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
}

function post(path, body, cookie) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: new URLSearchParams(body).toString() });
}

/** 担当者に紐づくスタッフ用アカウントを作ってログインする */
async function loginAs(staffName, loginId) {
  const staff = await getStaffByName(env.DB, staffName);
  const created = await createUser(
    env.DB,
    { loginId, displayName: staffName, role: 'staff', staffId: staff.id, mustChange: false },
    FAST
  );
  const res = await worker.fetch(post('/login', { login_id: loginId, password: created.password }), env);
  return { cookie: (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0], staff };
}

/** その担当者に清掃を1件割り当てる */
async function assign(staffName) {
  await applyFetchedBookings(
    env.DB,
    [{ bookingId: '77', title: '', startDate: addDays(TODAY, -2), checkoutDate: DATE, unit: 'b4', guests: 2 }],
    { from: addDays(TODAY, -30), to: addDays(TODAY, 365) },
    `${TODAY}T00:00:00Z`
  );
  await saveAssignments(
    env.DB,
    [{ bookingId: '77', checkoutDate: DATE, cleaningDate: DATE, unit: 'b4', title: '', staffName, status: '外注', isManual: false }],
    {}
  );
}

describe('外注（Rクリーン）のアカウント', () => {
  it('予定は見られる', async () => {
    const { cookie } = await loginAs('Rクリーン', 'rclean');
    await assign('Rクリーン');

    const res = await worker.fetch(get('/me', cookie), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('b4');
  });

  it('★ナビに「出勤入力」を出さない', async () => {
    const { cookie } = await loginAs('Rクリーン', 'rclean');

    const body = await (await worker.fetch(get('/me', cookie), env)).text();
    expect(body).toContain('<a href="/me">予定</a>');
    expect(body).not.toContain('href="/me/availability"');
  });

  it('★URL を直に叩いても出勤入力は開けない', async () => {
    const { cookie } = await loginAs('Rクリーン', 'rclean');

    const res = await worker.fetch(get('/me/availability', cookie), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('出勤入力を使いません');
  });

  it('★URL を直に叩いても出勤入力は保存できない', async () => {
    const { cookie, staff } = await loginAs('Rクリーン', 'rclean');

    await worker.fetch(post('/me/availability', { month: MONTH, [`cap_${DATE}`]: '3' }, cookie), env);

    const row = await env.DB.prepare('SELECT capacity FROM availability WHERE staff_id = ?').bind(staff.id).first();
    expect(row).toBeFalsy();
  });

  it('完了報告は従来どおり使える', async () => {
    const { cookie } = await loginAs('Rクリーン', 'rclean');
    await assign('Rクリーン');

    const body = await (await worker.fetch(get('/me', cookie), env)).text();
    expect(body).toContain('/me/report/77');

    const res = await worker.fetch(get('/me/report/77', cookie), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('現地精算');
  });

  it('通常のスタッフは従来どおり出勤入力を使える', async () => {
    const { cookie } = await loginAs('細田さん', 'hosoda');

    const body = await (await worker.fetch(get('/me', cookie), env)).text();
    expect(body).toContain('href="/me/availability"');

    const res = await worker.fetch(get('/me/availability', cookie), env);
    expect(res.status).toBe(200);
  });

  it('通常のスタッフの保存は従来どおり通る', async () => {
    const { cookie, staff } = await loginAs('細田さん', 'hosoda');

    await worker.fetch(post('/me/availability', { month: MONTH, [`cap_${DATE}`]: '3' }, cookie), env);

    const saved = await env.DB.prepare('SELECT capacity FROM availability WHERE staff_id = ? AND date = ?')
      .bind(staff.id, DATE)
      .first('capacity');
    expect(saved).toBe(3);
  });
});

// ------------------------------------------------------------------
// アカウントの作成
//
// 外注に画面を用意しても、アカウントが作れなければ意味がない。
// 担当者のプルダウンが kind === 'staff' で絞られていて、外注が出なかった。
// ------------------------------------------------------------------

describe('外注アカウントの作成', () => {
  let cookie;

  beforeEach(async () => {
    const created = await createUser(
      env.DB,
      { loginId: 'owner', displayName: '経営者', role: 'admin', mustChange: false },
      FAST
    );
    const res = await worker.fetch(post('/login', { login_id: 'owner', password: created.password }), env);
    cookie = (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
  });

  const staffPage = async () => (await worker.fetch(get('/admin/staff', cookie), env)).text();

  it('★外注が担当者のプルダウンに出る', async () => {
    const outsource = await getStaffByName(env.DB, 'Rクリーン');
    expect(await staffPage()).toContain(`<option value="${outsource.id}">`);
  });

  it('外注だと分かる表示になっている', async () => {
    expect(await staffPage()).toContain('外注・出勤入力なし');
  });

  it('通常のスタッフも従来どおり出る', async () => {
    const hosoda = await getStaffByName(env.DB, '細田さん');
    expect(await staffPage()).toContain(`<option value="${hosoda.id}">細田さん</option>`);
  });

  it('停止中の担当者は出ない', async () => {
    const hosoda = await getStaffByName(env.DB, '細田さん');
    await updateStaff(env.DB, hosoda.id, { isActive: false });

    expect(await staffPage()).not.toContain(`<option value="${hosoda.id}">`);
  });

  it('★外注を選んでアカウントを作れる', async () => {
    const outsource = await getStaffByName(env.DB, 'Rクリーン');

    const res = await worker.fetch(
      post('/admin/staff', { login_id: 'rclean', display_name: 'Rクリーン', staff_id: String(outsource.id) }, cookie),
      env
    );
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT staff_id, role FROM users WHERE login_id = ?').bind('rclean').first();
    expect(row.staff_id).toBe(outsource.id);
    expect(row.role).toBe('staff');
  });

  it('★作った外注アカウントで、実際にログインして出勤入力が使えないこと', async () => {
    const outsource = await getStaffByName(env.DB, 'Rクリーン');

    const res = await worker.fetch(
      post('/admin/staff', { login_id: 'rclean', display_name: 'Rクリーン', staff_id: String(outsource.id) }, cookie),
      env
    );

    // 発行されたパスワードは、この画面に1度だけ表示される
    const password = (await res.text()).match(/id="issued" type="text" value="([^"]+)"/)?.[1];
    expect(password).toBeTruthy();

    const login = await worker.fetch(post('/login', { login_id: 'rclean', password }), env);
    const rcCookie = (login.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
    expect(rcCookie).toBeTruthy();

    // 初回はパスワード変更を求められるので、先に済ませてから確認する
    await worker.fetch(
      post('/me/password', { current: password, next1: 'NewPass123!', next2: 'NewPass123!' }, rcCookie),
      env
    );

    const avail = await worker.fetch(get('/me/availability', rcCookie), env);
    expect(avail.status).toBe(404);
    expect(await avail.text()).toContain('出勤入力を使いません');
  });

  it('すでにアカウントがある担当者には印が付く', async () => {
    const hosoda = await getStaffByName(env.DB, '細田さん');
    await createUser(
      env.DB,
      { loginId: 'hosoda', displayName: '細田さん', role: 'staff', staffId: hosoda.id, mustChange: false },
      FAST
    );

    expect(await staffPage()).toContain('アカウント作成済み');
  });
});
