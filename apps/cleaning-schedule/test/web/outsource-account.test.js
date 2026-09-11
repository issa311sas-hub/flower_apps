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
import { getStaffByName } from '../../src/db/staff.js';
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
